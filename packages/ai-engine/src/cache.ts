/**
 * Request deduplication and in-memory caching.
 *
 * Keys are derived from normalised request content so that semantically
 * identical requests share a cache slot regardless of trivial whitespace
 * or casing differences.
 */

import type { AIRequest, AIResponse, CacheEntry, CacheStats } from './types.js';

/** How many top-magnitude dimensions survive into the embedding cache key. */
const EMBEDDING_KEY_DIMS = 8;
/** Quantization resolution for each surviving dimension's magnitude. */
const EMBEDDING_KEY_BUCKETS = 8;

/**
 * Minimal embedder contract.  Structurally compatible with
 * LocalAIProvider.embed and @accessbridge/onnx-runtime's MiniLMEmbeddings.
 */
export interface CacheEmbedder {
  embed(text: string): Promise<Float32Array | null | undefined>;
}

export class AICache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly ttl: number;
  private hits = 0;
  private misses = 0;

  constructor(ttl: number) {
    this.ttl = ttl;
  }

  // -----------------------------------------------------------------------
  // Key generation — normalise input so similar requests share a key.
  // -----------------------------------------------------------------------

  generateKey(request: AIRequest): string {
    const raw = typeof request.input === 'string' ? request.input : '<binary>';
    const normalised = raw
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .slice(0, 500);

    const parts = [
      request.type,
      normalised,
      request.language ?? '',
      String(request.maxLength ?? ''),
    ].join('|');

    return this.simpleHash(parts);
  }

  /**
   * Semantic cache key: embed the request input, bucket the top-K
   * dominant dimensions by quantized magnitude, and hash that signature.
   *
   * Two requests whose embeddings point in the same direction with
   * similar emphasis produce the same key — so "summarise this meeting"
   * and "please summarize my meeting" hit the same cache slot even
   * though their raw strings differ.
   *
   * When the embedder returns null or throws, falls back to the
   * exact-string key from generateKey().
   */
  async generateKeyByEmbedding(
    request: AIRequest,
    embedder: CacheEmbedder,
  ): Promise<string> {
    const raw = typeof request.input === 'string' ? request.input : '';
    if (!raw) return this.generateKey(request);

    let vector: Float32Array | null | undefined;
    try {
      vector = await embedder.embed(raw);
    } catch {
      vector = null;
    }
    if (!vector || vector.length === 0) return this.generateKey(request);

    const pairs: Array<{ idx: number; mag: number }> = new Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      pairs[i] = { idx: i, mag: Math.abs(vector[i]) };
    }
    pairs.sort((a, b) => b.mag - a.mag);

    const dims = Math.min(EMBEDDING_KEY_DIMS, pairs.length);
    const parts: string[] = new Array(dims);
    for (let i = 0; i < dims; i++) {
      const { idx, mag } = pairs[i];
      const bucket = Math.min(
        EMBEDDING_KEY_BUCKETS - 1,
        Math.floor(mag * EMBEDDING_KEY_BUCKETS),
      );
      parts[i] = `${idx}:${bucket}`;
    }

    const signature = [
      request.type,
      'emb',
      parts.join(','),
      request.language ?? '',
      String(request.maxLength ?? ''),
    ].join('|');

    return this.simpleHash(signature);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  get(request: AIRequest): AIResponse | null {
    this.evictExpired();
    const key = this.generateKey(request);
    const entry = this.store.get(key);

    if (entry && entry.expiresAt > Date.now()) {
      this.hits++;
      return { ...entry.response, cached: true };
    }

    if (entry) {
      this.store.delete(key); // expired
    }

    this.misses++;
    return null;
  }

  set(request: AIRequest, response: AIResponse): void {
    const key = this.generateKey(request);
    this.store.set(key, {
      key,
      response,
      expiresAt: Date.now() + this.ttl,
    });
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats(): CacheStats {
    this.evictExpired();
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.store.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Simple (non-cryptographic) string hash.  Good enough for cache keys
   * where collision only means a cache miss.
   */
  private simpleHash(str: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ((4294967296 * (2097151 & h2)) + (h1 >>> 0)).toString(36);
  }
}
