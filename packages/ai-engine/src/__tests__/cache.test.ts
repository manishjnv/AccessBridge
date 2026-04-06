import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AICache } from '../cache.js';
import type { AIRequest, AIResponse } from '../types.js';

function makeRequest(overrides?: Partial<AIRequest>): AIRequest {
  return {
    id: 'req-1',
    type: 'summarize',
    input: 'Hello world, this is a test input.',
    ...overrides,
  };
}

function makeResponse(overrides?: Partial<AIResponse>): AIResponse {
  return {
    id: 'res-1',
    requestId: 'req-1',
    output: 'Hello world summary.',
    tier: 'local',
    provider: 'local',
    cached: false,
    tokensUsed: 10,
    estimatedCost: 0,
    latencyMs: 5,
    ...overrides,
  };
}

describe('AICache', () => {
  let cache: AICache;

  beforeEach(() => {
    cache = new AICache(60_000); // 60s TTL
  });

  it('returns null on cache miss', () => {
    const result = cache.get(makeRequest());
    expect(result).toBeNull();
  });

  it('stores and retrieves a response', () => {
    const req = makeRequest();
    const res = makeResponse();
    cache.set(req, res);

    const hit = cache.get(req);
    expect(hit).not.toBeNull();
    expect(hit!.output).toBe('Hello world summary.');
    expect(hit!.cached).toBe(true);
  });

  it('normalises whitespace/casing for key generation', () => {
    const req1 = makeRequest({ input: '  Hello   World  ' });
    const req2 = makeRequest({ input: 'hello world' });

    cache.set(req1, makeResponse());
    const hit = cache.get(req2);
    expect(hit).not.toBeNull();
  });

  it('differentiates requests by type', () => {
    const req1 = makeRequest({ type: 'summarize' });
    const req2 = makeRequest({ type: 'simplify' });

    cache.set(req1, makeResponse({ output: 'summary' }));
    const hit = cache.get(req2);
    expect(hit).toBeNull();
  });

  it('differentiates requests by language', () => {
    const req1 = makeRequest({ language: 'en' });
    const req2 = makeRequest({ language: 'hi' });

    cache.set(req1, makeResponse({ output: 'english' }));
    const hit = cache.get(req2);
    expect(hit).toBeNull();
  });

  it('evicts expired entries', () => {
    vi.useFakeTimers();
    const cache2 = new AICache(1000); // 1s TTL

    cache2.set(makeRequest(), makeResponse());
    expect(cache2.get(makeRequest())).not.toBeNull();

    vi.advanceTimersByTime(1500);
    expect(cache2.get(makeRequest())).toBeNull();

    vi.useRealTimers();
  });

  it('tracks hit/miss stats', () => {
    const req = makeRequest();
    cache.get(req); // miss
    cache.set(req, makeResponse());
    cache.get(req); // hit
    cache.get(req); // hit

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  it('clears all entries and resets stats', () => {
    cache.set(makeRequest(), makeResponse());
    cache.get(makeRequest());
    cache.clear();

    const stats = cache.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.size).toBe(0);
  });

  it('generates consistent keys for the same input', () => {
    const req = makeRequest();
    const key1 = cache.generateKey(req);
    const key2 = cache.generateKey(req);
    expect(key1).toBe(key2);
  });

  it('truncates long inputs for key generation', () => {
    const longInput = 'a'.repeat(10000);
    const req = makeRequest({ input: longInput });
    const key = cache.generateKey(req);
    expect(typeof key).toBe('string');
    expect(key.length).toBeLessThan(50);
  });
});
