/**
 * ONNXRuntime — singleton manager for on-device model sessions.
 *
 * Responsibilities:
 *   1. Lazy-import onnxruntime-web (kept out of the startup bundle so the
 *      extension can initialise without paying the WASM cost until a model
 *      is actually needed).
 *   2. Fetch model bytes from the registered URL, verify SHA-256 integrity
 *      when a hash is known, and cache the binary in IndexedDB so repeat
 *      loads are a single DB read.
 *   3. Instantiate InferenceSession objects, track usage stats, and expose
 *      explicit unload for memory pressure.
 *
 * All I/O is injectable (ortLoader, fetch, indexedDB, digest, logger) so
 * tests can run against pure mocks.
 */

import type {
  InferenceSessionLike,
  LoadResult,
  ModelLoadProgress,
  ModelMetadata,
  RuntimeStats,
  TensorLike,
} from './types.js';
import { getModelMetadata } from './model-registry.js';

const IDB_NAME = 'accessbridge-onnx-cache';
const IDB_STORE = 'models';
const IDB_VERSION = 1;

type ORTTensorCtor = new (
  type: string,
  data: Float32Array | Int32Array | BigInt64Array,
  dims: number[],
) => TensorLike;

type ORTInferenceSession = {
  create(bytes: Uint8Array): Promise<InferenceSessionLike>;
};

interface ORTModuleShape {
  InferenceSession: ORTInferenceSession;
  Tensor: ORTTensorCtor;
  env?: {
    wasm?: {
      numThreads?: number;
      simd?: boolean;
      wasmPaths?: string | Record<string, string>;
    };
  };
}

export interface ONNXRuntimeOptions {
  /** Override the onnxruntime-web loader (for tests). */
  ortLoader?: () => Promise<ORTModuleShape>;
  /** Override fetch (for tests). */
  fetch?: typeof fetch;
  /** Override IndexedDB factory (for tests). */
  indexedDB?: IDBFactory | null;
  /** Override crypto.subtle.digest (for tests). */
  digest?: (algo: 'SHA-256', data: ArrayBuffer) => Promise<ArrayBuffer>;
  /** Log hook (defaults to console). */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /**
   * Base URL for the ort-wasm files inside the extension (e.g. the result of
   * `chrome.runtime.getURL('ort/')`). Set once the runtime is constructed in
   * the service worker; tests leave it undefined.
   */
  wasmPathBase?: string;
  /**
   * Resolver for `meta.bundledPath` — typically `(p) => chrome.runtime.getURL(p)`
   * in extension context. If provided, Tier 0 + any other model with a non-null
   * `bundledPath` loads from the packaged URL instead of the CDN.
   */
  bundledUrlResolver?: (path: string) => string;
}

export class ONNXRuntime {
  private readonly opts: Omit<Required<ONNXRuntimeOptions>, 'wasmPathBase' | 'bundledUrlResolver'> & {
    wasmPathBase: string | undefined;
    bundledUrlResolver: ((path: string) => string) | undefined;
  };
  private ort: ORTModuleShape | null = null;
  private sessions = new Map<string, InferenceSessionLike>();
  private inferenceCounts = new Map<string, number>();
  private latencyTotals = new Map<string, number>();
  private fallbacks = 0;
  private initializing: Promise<void> | null = null;

  constructor(options: ONNXRuntimeOptions = {}) {
    const defaultFetch =
      typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : (async () => {
            throw new Error('[onnx] fetch is not available in this environment');
          });

    const defaultIDB =
      typeof globalThis !== 'undefined' &&
      (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB
        ? ((globalThis as unknown as { indexedDB: IDBFactory }).indexedDB)
        : null;

    const defaultDigest =
      typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      globalThis.crypto.subtle
        ? (algo: 'SHA-256', data: ArrayBuffer) =>
            globalThis.crypto.subtle.digest(algo, data)
        : async () => {
            throw new Error('[onnx] crypto.subtle is not available');
          };

    this.opts = {
      ortLoader:
        options.ortLoader ??
        (async () => {
          // Import the /wasm entry specifically — it omits JSEP / WebGPU
          // variants (~50 % smaller bundle + half-size WASM). Our runtime
          // configures env.wasm.wasmPaths to the extension-local copy so
          // the CPU SIMD WASM file is the one that actually loads.
          const mod = await import('onnxruntime-web/wasm');
          return mod as unknown as ORTModuleShape;
        }),
      fetch: options.fetch ?? defaultFetch,
      indexedDB: options.indexedDB === undefined ? defaultIDB : options.indexedDB,
      digest: options.digest ?? defaultDigest,
      logger: options.logger ?? console,
      wasmPathBase: options.wasmPathBase,
      bundledUrlResolver: options.bundledUrlResolver,
    };
  }

  async initialize(): Promise<boolean> {
    if (this.ort) return true;
    if (!this.initializing) {
      this.initializing = this.doInitialize();
    }
    await this.initializing;
    return this.ort !== null;
  }

  private async doInitialize(): Promise<void> {
    try {
      this.ort = await this.opts.ortLoader();
      // Point ort at bundled ort-wasm-*.wasm so inference stays offline.
      // Without this, onnxruntime-web tries to fetch from a jsdelivr CDN at
      // session-create time — which the extension's default CSP blocks.
      if (this.opts.wasmPathBase && this.ort?.env?.wasm) {
        this.ort.env.wasm.wasmPaths = this.opts.wasmPathBase;
      }
    } catch (err) {
      this.opts.logger.warn(
        '[onnx] onnxruntime-web failed to load — runtime will return fallback for all models',
        err,
      );
      this.ort = null;
    }
  }

  async loadModel(
    modelId: string,
    onProgress?: (p: ModelLoadProgress) => void,
  ): Promise<LoadResult> {
    const meta = getModelMetadata(modelId);
    if (!meta) return { ok: false, error: `unknown-model:${modelId}` };

    const cached = this.sessions.get(modelId);
    if (cached) return { ok: true, session: cached, cached: true };

    const ready = await this.initialize();
    if (!ready || !this.ort) return { ok: false, error: 'ort-unavailable' };

    let buffer: ArrayBuffer | null = await this.readFromCache(modelId).catch(
      () => null,
    );

    if (!buffer) {
      const fetched = await this.fetchWithProgress(meta, onProgress);
      if (!fetched.ok) return { ok: false, error: fetched.error };
      buffer = fetched.buffer;

      if (meta.sha256) {
        const actual = await this.computeSha256(buffer);
        if (actual !== meta.sha256.toLowerCase()) {
          return {
            ok: false,
            error: `integrity-mismatch:expected=${meta.sha256} actual=${actual}`,
          };
        }
      } else {
        this.opts.logger.warn(
          `[onnx] model ${modelId} has no sha256 in registry — integrity unverified`,
        );
      }

      await this.writeToCache(modelId, buffer).catch((e) => {
        this.opts.logger.warn(`[onnx] cache write failed for ${modelId}`, e);
      });
    } else {
      onProgress?.({
        loaded: buffer.byteLength,
        total: buffer.byteLength,
        percent: 100,
      });
    }

    try {
      const session = await this.ort.InferenceSession.create(
        new Uint8Array(buffer),
      );
      this.sessions.set(modelId, session);
      return { ok: true, session, cached: false };
    } catch (err) {
      return {
        ok: false,
        error: `session-create-failed:${(err as Error).message}`,
      };
    }
  }

  getModel(modelId: string): InferenceSessionLike | null {
    return this.sessions.get(modelId) ?? null;
  }

  hasModel(modelId: string): boolean {
    return this.sessions.has(modelId);
  }

  unloadModel(modelId: string): void {
    const s = this.sessions.get(modelId);
    if (!s) return;
    try {
      s.release?.();
    } catch {
      // release errors are non-fatal
    }
    this.sessions.delete(modelId);
  }

  createTensor(
    type: 'float32' | 'int32' | 'int64',
    data: Float32Array | Int32Array | BigInt64Array,
    dims: number[],
  ): TensorLike | null {
    if (!this.ort) return null;
    try {
      return new this.ort.Tensor(type, data, dims);
    } catch (err) {
      this.opts.logger.warn('[onnx] createTensor failed', err);
      return null;
    }
  }

  recordInference(modelId: string, latencyMs: number): void {
    this.inferenceCounts.set(
      modelId,
      (this.inferenceCounts.get(modelId) ?? 0) + 1,
    );
    this.latencyTotals.set(
      modelId,
      (this.latencyTotals.get(modelId) ?? 0) + latencyMs,
    );
  }

  recordFallback(): void {
    this.fallbacks += 1;
  }

  async getStats(): Promise<RuntimeStats> {
    const cacheBytes = await this.getCacheSize().catch(() => 0);
    const inferenceCount: Record<string, number> = {};
    const avgLatencyMs: Record<string, number> = {};
    for (const [id, count] of this.inferenceCounts) {
      inferenceCount[id] = count;
      const total = this.latencyTotals.get(id) ?? 0;
      avgLatencyMs[id] = count > 0 ? Math.round(total / count) : 0;
    }
    return {
      modelsLoaded: [...this.sessions.keys()],
      cacheBytes,
      inferenceCount,
      avgLatencyMs,
      fallbackCount: this.fallbacks,
    };
  }

  async clearCache(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.unloadModel(id);
    await this.clearIDB().catch(() => {});
  }

  // ---------------------------------------------------------------------
  // private
  // ---------------------------------------------------------------------

  private async fetchWithProgress(
    meta: ModelMetadata,
    onProgress?: (p: ModelLoadProgress) => void,
  ): Promise<{ ok: true; buffer: ArrayBuffer } | { ok: false; error: string }> {
    // Prefer the bundled packaged path when it exists — zero-latency, offline,
    // no CDN dependency. Falls through to the CDN URL on tiers without a bundle.
    const fetchUrl =
      meta.bundledPath && this.opts.bundledUrlResolver
        ? this.opts.bundledUrlResolver(meta.bundledPath)
        : meta.url;
    let res: Response;
    try {
      res = await this.opts.fetch(fetchUrl);
    } catch (err) {
      return { ok: false, error: `fetch-error:${(err as Error).message}` };
    }

    if (!res.ok) {
      return { ok: false, error: `fetch-status:${res.status}` };
    }

    const total = Number(res.headers.get('content-length') ?? meta.sizeBytes);
    const reader = res.body?.getReader?.();

    if (!reader) {
      const buf = await res.arrayBuffer();
      onProgress?.({
        loaded: buf.byteLength,
        total: buf.byteLength,
        percent: 100,
      });
      return { ok: true, buffer: buf };
    }

    const chunks: Uint8Array[] = [];
    let loaded = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.({
          loaded,
          total,
          percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
        });
      }
    }

    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return { ok: true, buffer: out.buffer };
  }

  private async computeSha256(buffer: ArrayBuffer): Promise<string> {
    const hash = await this.opts.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private openDB(): Promise<IDBDatabase | null> {
    if (!this.opts.indexedDB) return Promise.resolve(null);
    return new Promise((resolve) => {
      const req = this.opts.indexedDB!.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  private async readFromCache(id: string): Promise<ArrayBuffer | null> {
    const db = await this.openDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(id);
        req.onsuccess = () =>
          resolve((req.result as ArrayBuffer | undefined) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async writeToCache(id: string, buffer: ArrayBuffer): Promise<void> {
    const db = await this.openDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(buffer, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  private async clearIDB(): Promise<void> {
    const db = await this.openDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  private async getCacheSize(): Promise<number> {
    const db = await this.openDB();
    if (!db) return 0;
    return new Promise((resolve) => {
      let total = 0;
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) {
            const v = c.value as ArrayBuffer;
            total += v.byteLength;
            c.continue();
          } else {
            resolve(total);
          }
        };
        cursor.onerror = () => resolve(total);
      } catch {
        resolve(total);
      }
    });
  }
}
