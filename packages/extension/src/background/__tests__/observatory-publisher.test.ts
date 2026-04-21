/**
 * Tests for observatory-publisher pure helpers:
 *   addLaplaceNoise, merkleRoot, aggregateDailyBundle.
 * 14 tests total (5 + 5 + 4).
 */

import { describe, it, expect } from 'vitest';
import {
  addLaplaceNoise,
  merkleRoot,
  aggregateDailyBundle,
  OBSERVATORY_ENDPOINT,
  OBSERVATORY_ENROLL_ENDPOINT,
  OBSERVATORY_RING_ENDPOINT,
} from '../observatory-publisher.js';

// Node 20+ exposes globalThis.crypto with SubtleCrypto via the Web Crypto API,
// and vitest's 'node' environment inherits it — no shim needed.

describe('uses https for all observatory endpoints (EXT-001 regression)', () => {
  it('OBSERVATORY_ENDPOINT starts with https://accessbridge.space/', () => {
    expect(OBSERVATORY_ENDPOINT.startsWith('https://accessbridge.space/')).toBe(true);
  });
  it('OBSERVATORY_ENROLL_ENDPOINT starts with https://accessbridge.space/', () => {
    expect(OBSERVATORY_ENROLL_ENDPOINT.startsWith('https://accessbridge.space/')).toBe(true);
  });
  it('OBSERVATORY_RING_ENDPOINT starts with https://accessbridge.space/', () => {
    expect(OBSERVATORY_RING_ENDPOINT.startsWith('https://accessbridge.space/')).toBe(true);
  });
});

function variance(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
}

describe('addLaplaceNoise', () => {
  it('returns a non-negative integer', () => {
    for (let i = 0; i < 100; i++) {
      const r = addLaplaceNoise(5, 1.0, 1);
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
    }
  });

  it('stays near input on average over 1000 samples', () => {
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) samples.push(addLaplaceNoise(100, 1.0, 1));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Laplace(0, 1) has mean 0 → samples mean should be near 100.
    expect(Math.abs(mean - 100)).toBeLessThan(5);
  });

  it('lower epsilon produces wider variance', () => {
    const lowEps: number[] = [];
    const highEps: number[] = [];
    for (let i = 0; i < 500; i++) {
      lowEps.push(addLaplaceNoise(1000, 0.1, 1));
      highEps.push(addLaplaceNoise(1000, 10, 1));
    }
    expect(variance(lowEps)).toBeGreaterThan(variance(highEps));
  });

  it('is non-deterministic across repeated calls', () => {
    // Laplace + rounding with sensitivity=1 typically spans a handful of integers
    // near the input — ≥3 distinct values across 100 samples proves non-determinism
    // without demanding a wider spread than the mechanism produces.
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) seen.add(addLaplaceNoise(50, 1.0, 1));
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('sensitivity scales noise magnitude', () => {
    const s1: number[] = [];
    const s10: number[] = [];
    for (let i = 0; i < 500; i++) {
      s1.push(addLaplaceNoise(500, 1.0, 1));
      s10.push(addLaplaceNoise(500, 1.0, 10));
    }
    expect(variance(s10)).toBeGreaterThan(variance(s1));
  });
});

describe('merkleRoot', () => {
  const SHA256_EMPTY =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('is deterministic for same input', async () => {
    const a = await merkleRoot(['x', 'y', 'z']);
    const b = await merkleRoot(['x', 'y', 'z']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empty array returns sha256("") hex', async () => {
    const r = await merkleRoot([]);
    expect(r).toBe(SHA256_EMPTY);
  });

  it('single item returns sha256(item) hex', async () => {
    // Known: sha256("a") = ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb
    const r = await merkleRoot(['a']);
    expect(r).toBe(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    );
  });

  it('handles N items with odd-level duplication', async () => {
    // Should compute without throwing for N=1..7 and produce distinct roots.
    const roots = new Set<string>();
    for (let n = 1; n <= 7; n++) {
      const items = Array.from({ length: n }, (_, i) => `item-${i}`);
      roots.add(await merkleRoot(items));
    }
    expect(roots.size).toBe(7);
  });

  it('is sensitive to item order', async () => {
    const a = await merkleRoot(['a', 'b']);
    const b = await merkleRoot(['b', 'a']);
    expect(a).not.toBe(b);
  });
});

describe('aggregateDailyBundle', () => {
  const BASE_COUNTERS = {
    adaptations_applied: { FONT_SCALE: 5, FOCUS_MODE: 3 },
    struggle_events_triggered: 4,
    features_enabled: { focus_mode: 2, voice_nav: 1 },
    languages_used: ['hi', 'en', 'hi', 'ta'],
    domain_connectors_activated: { banking: 2 },
    estimated_accessibility_score_improvement: 60,
  };

  it('produces schema_version 1 and YYYY-MM-DD date', async () => {
    const bundle = await aggregateDailyBundle(BASE_COUNTERS);
    expect(bundle.schema_version).toBe(1);
    expect(bundle.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(bundle.merkle_root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves metric names (keys from input)', async () => {
    const bundle = await aggregateDailyBundle(BASE_COUNTERS);
    expect(Object.keys(bundle.adaptations_applied).sort()).toEqual([
      'FOCUS_MODE',
      'FONT_SCALE',
    ]);
    expect(Object.keys(bundle.features_enabled).sort()).toEqual([
      'focus_mode',
      'voice_nav',
    ]);
    expect(Object.keys(bundle.domain_connectors_activated)).toEqual(['banking']);
  });

  it('dedups and sorts languages_used', async () => {
    const bundle = await aggregateDailyBundle(BASE_COUNTERS);
    expect(bundle.languages_used).toEqual(['en', 'hi', 'ta']);
  });

  it('handles empty raw counters', async () => {
    const bundle = await aggregateDailyBundle({
      adaptations_applied: {},
      struggle_events_triggered: 0,
      features_enabled: {},
      languages_used: [],
      domain_connectors_activated: {},
      estimated_accessibility_score_improvement: 0,
    });
    expect(bundle.adaptations_applied).toEqual({});
    expect(bundle.features_enabled).toEqual({});
    expect(bundle.domain_connectors_activated).toEqual({});
    expect(bundle.languages_used).toEqual([]);
    expect(bundle.struggle_events_triggered).toBeGreaterThanOrEqual(0);
    expect(bundle.estimated_accessibility_score_improvement).toBeGreaterThanOrEqual(0);
    expect(bundle.estimated_accessibility_score_improvement).toBeLessThanOrEqual(100);
    expect(bundle.merkle_root).toMatch(/^[0-9a-f]{64}$/);
  });
});
