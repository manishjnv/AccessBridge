/**
 * Session 12 — semantic cache key via embedding.
 * Companion to cache.test.ts; scopes to the new generateKeyByEmbedding path.
 */

import { describe, it, expect, vi } from 'vitest';
import { AICache } from '../cache.js';
import type { AIRequest } from '../types.js';

function makeRequest(overrides?: Partial<AIRequest>): AIRequest {
  return {
    id: 'req-1',
    type: 'summarize',
    input: 'Please summarize this meeting.',
    ...overrides,
  };
}

function unitVector(index: number, dim = 384, magnitude = 1): Float32Array {
  const v = new Float32Array(dim);
  v[index] = magnitude;
  return v;
}

describe('AICache.generateKeyByEmbedding', () => {
  it('returns the same key for two embeddings that share their dominant dimensions', async () => {
    const cache = new AICache(60_000);
    const req = makeRequest();

    // Both embeddings dominate on index 5 with similar magnitude — the top-K
    // signature is the same, so they should collide.
    const a = unitVector(5, 384, 0.9);
    const b = unitVector(5, 384, 0.92);

    const embedderA = { embed: vi.fn(async () => a) };
    const embedderB = { embed: vi.fn(async () => b) };

    const keyA = await cache.generateKeyByEmbedding(req, embedderA);
    const keyB = await cache.generateKeyByEmbedding(req, embedderB);
    expect(keyA).toBe(keyB);
  });

  it('returns a different key when dominant dimensions differ', async () => {
    const cache = new AICache(60_000);
    const req = makeRequest();

    const onIndex5 = { embed: async () => unitVector(5) };
    const onIndex200 = { embed: async () => unitVector(200) };

    const k1 = await cache.generateKeyByEmbedding(req, onIndex5);
    const k2 = await cache.generateKeyByEmbedding(req, onIndex200);
    expect(k1).not.toBe(k2);
  });

  it('falls back to the exact-string key when the embedder returns null', async () => {
    const cache = new AICache(60_000);
    const req = makeRequest();
    const nullEmbedder = { embed: vi.fn(async () => null) };

    const fallbackKey = await cache.generateKeyByEmbedding(req, nullEmbedder);
    expect(fallbackKey).toBe(cache.generateKey(req));
  });

  it('falls back to the exact-string key when the embedder throws', async () => {
    const cache = new AICache(60_000);
    const req = makeRequest();
    const angryEmbedder = {
      embed: vi.fn(async () => {
        throw new Error('embedder failure');
      }),
    };
    const key = await cache.generateKeyByEmbedding(req, angryEmbedder);
    expect(key).toBe(cache.generateKey(req));
  });

  it('differentiates by request type even for the same embedding', async () => {
    const cache = new AICache(60_000);
    const v = unitVector(7);
    const embedder = { embed: async () => v };

    const summarizeKey = await cache.generateKeyByEmbedding(
      makeRequest({ type: 'summarize' }),
      embedder,
    );
    const simplifyKey = await cache.generateKeyByEmbedding(
      makeRequest({ type: 'simplify' }),
      embedder,
    );
    expect(summarizeKey).not.toBe(simplifyKey);
  });

  it('falls back for non-string input (binary payloads)', async () => {
    const cache = new AICache(60_000);
    const binary: AIRequest = {
      id: 'req-bin',
      type: 'summarize',
      input: new ArrayBuffer(32),
    };
    const embedder = { embed: vi.fn(async () => unitVector(0)) };

    const key = await cache.generateKeyByEmbedding(binary, embedder);
    expect(key).toBe(cache.generateKey(binary));
    // Embedder should never have been called for an empty string input.
    expect(embedder.embed).not.toHaveBeenCalled();
  });
});
