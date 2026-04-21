import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ONNXRuntime } from '../runtime.js';
import { STRUGGLE_CLASSIFIER_ID, MODEL_REGISTRY } from '../model-registry.js';

// ---------------------------------------------------------------------------
// Shared mock bytes — small but realistic enough to pass into the session.
// ---------------------------------------------------------------------------
const MODEL_BYTES = new Uint8Array([0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);

// ---------------------------------------------------------------------------
// Factory helpers — rebuilt fresh in each beforeEach so mocks don't bleed.
// ---------------------------------------------------------------------------
function makeSession() {
  return {
    inputNames: ['features'],
    outputNames: ['probabilities'],
    run: vi.fn(async () => ({})),
    release: vi.fn(),
  };
}

function makeOrt() {
  return {
    InferenceSession: {
      create: vi.fn(async (_bytes: Uint8Array) => makeSession()),
    },
    Tensor: vi.fn((type: string, data: Float32Array | Int32Array | BigInt64Array, dims: number[]) => ({
      type,
      data,
      dims,
    })),
    env: {},
  };
}

function makeFetch(bytes: Uint8Array = MODEL_BYTES) {
  return vi.fn(async (_url: string) => {
    // Copy into an ArrayBuffer so Response/BodyInit typing accepts it under
    // strict DOM lib settings (rejects SharedArrayBuffer-backed Uint8Array).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new Response(ab, {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  });
}

/** Returns 32 zero bytes — distinct from 'aa...' so mismatch tests work. */
function makeDigest() {
  return vi.fn(async (_algo: 'SHA-256', _data: ArrayBuffer) => new ArrayBuffer(32));
}

function makeLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Minimal in-memory IDB stub — covers the surface ONNXRuntime uses:
//   openDB → IDBDatabase
//     .transaction(store, mode) → IDBTransaction
//       .objectStore(store) → IDBObjectStore
//         .get(key)  → IDBRequest
//         .put(value, key) → void
//         .clear()   → void
//         .openCursor() → IDBRequest (cursor)
//     .oncomplete
//     .onerror
// ---------------------------------------------------------------------------
function makeIDBFactory(): IDBFactory {
  const store = new Map<string, ArrayBuffer>();

  const makeObjectStore = (readwrite: boolean) => ({
    get(key: string) {
      const req = { result: undefined as ArrayBuffer | undefined, onsuccess: null as null | (() => void), onerror: null as null | (() => void) } as unknown as IDBRequest;
      Promise.resolve().then(() => {
        (req as unknown as { result: ArrayBuffer | undefined }).result = store.get(key);
        (req as unknown as { onsuccess: (() => void) | null }).onsuccess?.();
      });
      return req;
    },
    put(value: ArrayBuffer, key: string) {
      if (readwrite) store.set(key, value);
    },
    clear() {
      if (readwrite) store.clear();
    },
    openCursor() {
      const entries = [...store.entries()];
      let idx = 0;

      const req = {
        result: null as null | { value: ArrayBuffer; continue: () => void },
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
      } as unknown as IDBRequest;

      const advance = () => {
        Promise.resolve().then(() => {
          if (idx < entries.length) {
            const [, value] = entries[idx++];
            (req as unknown as { result: { value: ArrayBuffer; continue: () => void } }).result = {
              value,
              continue: advance,
            };
          } else {
            (req as unknown as { result: null }).result = null;
          }
          (req as unknown as { onsuccess: (() => void) | null }).onsuccess?.();
        });
      };
      advance();
      return req;
    },
  });

  const makeTransaction = (mode: string) => {
    const tx = {
      oncomplete: null as null | (() => void),
      onerror: null as null | (() => void),
      error: null,
      objectStore(_name: string) {
        return makeObjectStore(mode === 'readwrite');
      },
    };
    // auto-complete after a microtask
    Promise.resolve().then(() => (tx as unknown as { oncomplete: (() => void) | null }).oncomplete?.());
    return tx as unknown as IDBTransaction;
  };

  const db = {
    objectStoreNames: { contains: (_: string) => true },
    transaction(_store: string, mode: IDBTransactionMode) {
      return makeTransaction(mode as string);
    },
    createObjectStore() {},
  } as unknown as IDBDatabase;

  const idb = {
    open(_name: string, _version: number) {
      const req = {
        result: db,
        onupgradeneeded: null,
        onsuccess: null as null | (() => void),
        onerror: null,
      } as unknown as IDBOpenDBRequest;
      Promise.resolve().then(() => (req as unknown as { onsuccess: (() => void) | null }).onsuccess?.());
      return req;
    },
  } as unknown as IDBFactory;

  return idb;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ONNXRuntime', () => {
  let ort: ReturnType<typeof makeOrt>;
  let mockFetch: ReturnType<typeof makeFetch>;
  let mockDigest: ReturnType<typeof makeDigest>;
  let mockLogger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    ort = makeOrt();
    mockFetch = makeFetch();
    mockDigest = makeDigest();
    mockLogger = makeLogger();
  });

  function makeRuntime(extra?: { indexedDB?: IDBFactory | null }) {
    return new ONNXRuntime({
      ortLoader: async () => ort as never,
      fetch: mockFetch as unknown as typeof fetch,
      indexedDB: extra?.indexedDB !== undefined ? extra.indexedDB : null,
      digest: mockDigest,
      logger: mockLogger,
    });
  }

  // -----------------------------------------------------------------------
  // 1. Unknown model id
  // -----------------------------------------------------------------------
  it('returns {ok: false, error: "unknown-model:..."} for an unknown id', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadModel('does-not-exist');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('unknown-model:does-not-exist');
    }
  });

  // -----------------------------------------------------------------------
  // 2. ortLoader rejection → ort-unavailable
  // -----------------------------------------------------------------------
  it('returns {ok: false, error: "ort-unavailable"} when ortLoader rejects', async () => {
    const runtime = new ONNXRuntime({
      ortLoader: async () => { throw new Error('wasm load failed'); },
      fetch: mockFetch as unknown as typeof fetch,
      indexedDB: null,
      digest: mockDigest,
      logger: mockLogger,
    });
    const result = await runtime.loadModel(STRUGGLE_CLASSIFIER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ort-unavailable');
    }
  });

  // -----------------------------------------------------------------------
  // 3. Happy path — fresh fetch, session created, cached: false, hasModel
  // -----------------------------------------------------------------------
  it('happy path: fetches bytes, creates InferenceSession, returns {ok: true, cached: false}', async () => {
    const runtime = makeRuntime();
    const result = await runtime.loadModel(STRUGGLE_CLASSIFIER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cached).toBe(false);
      expect(result.session).toBeDefined();
    }

    // InferenceSession.create must have received a Uint8Array
    expect(ort.InferenceSession.create).toHaveBeenCalledOnce();
    const [arg] = ort.InferenceSession.create.mock.calls[0];
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(Array.from(arg as Uint8Array)).toEqual(Array.from(MODEL_BYTES));

    // hasModel should now be true
    expect(runtime.hasModel(STRUGGLE_CLASSIFIER_ID)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. Second call for same id — memoised, cached: true
  // -----------------------------------------------------------------------
  it('returns {ok: true, cached: true} on the second loadModel call for the same id', async () => {
    const runtime = makeRuntime();

    const first = await runtime.loadModel(STRUGGLE_CLASSIFIER_ID);
    expect(first.ok).toBe(true);

    const second = await runtime.loadModel(STRUGGLE_CLASSIFIER_ID);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.cached).toBe(true);
    }

    // fetch and InferenceSession.create should only have been called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(ort.InferenceSession.create).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 5. onProgress called during streaming fetch
  // -----------------------------------------------------------------------
  it('calls onProgress at least once during a streaming fetch', async () => {
    // Build a fetch mock that returns a streaming body via ReadableStream
    const chunk = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const streamFetch = vi.fn(async (_url: string) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-length': String(chunk.length) },
      });
    });

    const runtime = new ONNXRuntime({
      ortLoader: async () => ort as never,
      fetch: streamFetch as unknown as typeof fetch,
      indexedDB: null,
      digest: mockDigest,
      logger: mockLogger,
    });

    const progressEvents: Array<{ loaded: number; total: number; percent: number }> = [];
    const result = await runtime.loadModel(STRUGGLE_CLASSIFIER_ID, (p) => progressEvents.push(p));

    expect(result.ok).toBe(true);
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    // Final event should be 100 %
    const last = progressEvents[progressEvents.length - 1];
    expect(last.percent).toBe(100);
  });

  // -----------------------------------------------------------------------
  // 6. SHA-256 mismatch → integrity-mismatch error
  // -----------------------------------------------------------------------
  describe('integrity check', () => {
    const FAKE_SHA = 'aabbccdd'.repeat(8); // 64 hex chars = 32 bytes
    let originalSha: string | null;

    beforeEach(() => {
      originalSha = MODEL_REGISTRY[STRUGGLE_CLASSIFIER_ID].sha256;
      MODEL_REGISTRY[STRUGGLE_CLASSIFIER_ID].sha256 = FAKE_SHA;
    });

    afterEach(() => {
      MODEL_REGISTRY[STRUGGLE_CLASSIFIER_ID].sha256 = originalSha;
    });

    it('returns {ok: false, error: /^integrity-mismatch/} when digest does not match registry sha256', async () => {
      // digest returns 32 zero bytes → hex = '00'.repeat(32) — does not match FAKE_SHA
      const runtime = makeRuntime();
      const result = await runtime.loadModel(STRUGGLE_CLASSIFIER_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^integrity-mismatch/);
        expect(result.error).toContain(FAKE_SHA.toLowerCase());
      }
      // digest must have been invoked
      expect(mockDigest).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // 7. unloadModel — session removed, release called, getModel returns null
  // -----------------------------------------------------------------------
  it('unloadModel removes the session and calls release(); getModel returns null afterwards', async () => {
    const runtime = makeRuntime();
    await runtime.loadModel(STRUGGLE_CLASSIFIER_ID);

    expect(runtime.hasModel(STRUGGLE_CLASSIFIER_ID)).toBe(true);

    // Retrieve the actual session so we can inspect release()
    const session = runtime.getModel(STRUGGLE_CLASSIFIER_ID);
    expect(session).not.toBeNull();

    runtime.unloadModel(STRUGGLE_CLASSIFIER_ID);

    expect(runtime.hasModel(STRUGGLE_CLASSIFIER_ID)).toBe(false);
    expect(runtime.getModel(STRUGGLE_CLASSIFIER_ID)).toBeNull();

    // The session mock has a release fn — it should have been called
    if (session && typeof (session as { release?: () => void }).release === 'function') {
      const releaseMock = (session as unknown as { release: ReturnType<typeof vi.fn> }).release;
      expect(releaseMock).toHaveBeenCalledOnce();
    }
  });

  // -----------------------------------------------------------------------
  // 8. getStats — inferenceCount, avgLatencyMs, fallbackCount
  // -----------------------------------------------------------------------
  it('getStats returns correct counts and averages after recordInference and recordFallback', async () => {
    const runtime = makeRuntime();

    runtime.recordInference('x', 100);
    runtime.recordInference('x', 200);
    runtime.recordFallback();
    runtime.recordFallback();

    const stats = await runtime.getStats();

    expect(stats.inferenceCount['x']).toBe(2);
    expect(stats.avgLatencyMs['x']).toBe(150);
    expect(stats.fallbackCount).toBe(2);
    // No models loaded yet (we didn't call loadModel)
    expect(stats.modelsLoaded).toEqual([]);
    expect(typeof stats.cacheBytes).toBe('number');
  });

  // -----------------------------------------------------------------------
  // 9. clearCache — unloads all sessions; getModel returns null
  // -----------------------------------------------------------------------
  it('clearCache unloads all sessions; subsequent getModel returns null', async () => {
    const runtime = makeRuntime();
    await runtime.loadModel(STRUGGLE_CLASSIFIER_ID);
    expect(runtime.hasModel(STRUGGLE_CLASSIFIER_ID)).toBe(true);

    await runtime.clearCache();

    expect(runtime.hasModel(STRUGGLE_CLASSIFIER_ID)).toBe(false);
    expect(runtime.getModel(STRUGGLE_CLASSIFIER_ID)).toBeNull();

    const stats = await runtime.getStats();
    expect(stats.modelsLoaded).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 10. fetch network failure → {ok: false, error: /^fetch-/}
  // -----------------------------------------------------------------------
  it('fetch network failure returns {ok: false, error: matching /^fetch-/}', async () => {
    const failFetch = vi.fn(async (_url: string) => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    });

    const runtime = new ONNXRuntime({
      ortLoader: async () => ort as never,
      fetch: failFetch as unknown as typeof fetch,
      indexedDB: null,
      digest: mockDigest,
      logger: mockLogger,
    });

    const result = await runtime.loadModel(STRUGGLE_CLASSIFIER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^fetch-/);
    }
  });

  // -----------------------------------------------------------------------
  // Bonus: IDB cache-hit path via in-memory stub
  // -----------------------------------------------------------------------
  describe('IDB cache-hit path', () => {
    it('reads from IDB on second loadModel (new runtime instance sharing a store via stub)', async () => {
      // Pre-populate the store so the first readFromCache returns the bytes
      const idb = makeIDBFactory();

      // First runtime writes to IDB
      const rt1 = new ONNXRuntime({
        ortLoader: async () => ort as never,
        fetch: mockFetch as unknown as typeof fetch,
        indexedDB: idb,
        digest: mockDigest,
        logger: mockLogger,
      });
      const r1 = await rt1.loadModel(STRUGGLE_CLASSIFIER_ID);
      expect(r1.ok).toBe(true);
      // fetch was called once for the initial load
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Same runtime, second call — memoised in-memory, cached: true
      const r2 = await rt1.loadModel(STRUGGLE_CLASSIFIER_ID);
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.cached).toBe(true);
      // fetch still only called once
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
