import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CostTracker, estimateCost } from '../cost-tracker.js';
import type { AIResponse } from '../types.js';

// Stub localStorage for tests
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

function makeResponse(overrides?: Partial<AIResponse>): AIResponse {
  return {
    id: 'res-1',
    requestId: 'req-1',
    output: 'result',
    tier: 'local',
    provider: 'local',
    cached: false,
    tokensUsed: 1000,
    estimatedCost: 0,
    latencyMs: 10,
    ...overrides,
  };
}

describe('estimateCost', () => {
  it('returns 0 for local tier', () => {
    expect(estimateCost(1_000_000, 'local')).toBe(0);
  });

  it('calculates Gemini Flash cost', () => {
    const cost = estimateCost(1_000_000, 'low-cost', 'gemini');
    expect(cost).toBeCloseTo(0.10);
  });

  it('calculates Claude Haiku cost', () => {
    const cost = estimateCost(1_000_000, 'low-cost', 'claude');
    expect(cost).toBeCloseTo(0.25);
  });

  it('calculates Claude Sonnet cost', () => {
    const cost = estimateCost(1_000_000, 'premium', 'claude');
    expect(cost).toBeCloseTo(3.00);
  });

  it('handles small token counts', () => {
    const cost = estimateCost(100, 'low-cost', 'gemini');
    expect(cost).toBeCloseTo(0.00001);
  });
});

describe('CostTracker', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('starts with zero stats', () => {
    const tracker = new CostTracker(1.0);
    const stats = tracker.getStats();
    expect(stats.totalTokens).toBe(0);
    expect(stats.totalCost).toBe(0);
    expect(stats.requestCount).toBe(0);
  });

  it('tracks a response', () => {
    const tracker = new CostTracker(1.0);
    tracker.track(makeResponse({ tokensUsed: 500, estimatedCost: 0.05 }));

    const stats = tracker.getStats();
    expect(stats.totalTokens).toBe(500);
    expect(stats.totalCost).toBeCloseTo(0.05);
    expect(stats.requestCount).toBe(1);
  });

  it('tracks cache hits vs misses', () => {
    const tracker = new CostTracker(1.0);
    tracker.track(makeResponse({ cached: false }));
    tracker.track(makeResponse({ cached: true }));
    tracker.track(makeResponse({ cached: true }));

    const stats = tracker.getStats();
    expect(stats.cacheHits).toBe(2);
    expect(stats.cacheMisses).toBe(1);
  });

  it('tracks by tier', () => {
    const tracker = new CostTracker(1.0);
    tracker.track(makeResponse({ tier: 'local', tokensUsed: 100 }));
    tracker.track(makeResponse({ tier: 'low-cost', tokensUsed: 200, estimatedCost: 0.02 }));

    const stats = tracker.getStats();
    expect(stats.byTier.local.tokens).toBe(100);
    expect(stats.byTier['low-cost'].tokens).toBe(200);
  });

  it('canAfford returns true when under budget', () => {
    const tracker = new CostTracker(1.0);
    expect(tracker.canAfford(100_000, 'low-cost', 'gemini')).toBe(true);
  });

  it('canAfford returns false when over budget', () => {
    const tracker = new CostTracker(0.001);
    tracker.track(makeResponse({ estimatedCost: 0.001 }));
    // Already at budget limit
    expect(tracker.canAfford(1_000_000, 'premium', 'claude')).toBe(false);
  });

  it('getDailyRemaining returns correct amount', () => {
    const tracker = new CostTracker(1.0);
    tracker.track(makeResponse({ estimatedCost: 0.30 }));
    expect(tracker.getDailyRemaining()).toBeCloseTo(0.70);
  });

  it('reset clears all stats', () => {
    const tracker = new CostTracker(1.0);
    tracker.track(makeResponse({ tokensUsed: 500, estimatedCost: 0.05 }));
    tracker.reset();

    const stats = tracker.getStats();
    expect(stats.totalTokens).toBe(0);
    expect(stats.totalCost).toBe(0);
  });
});
