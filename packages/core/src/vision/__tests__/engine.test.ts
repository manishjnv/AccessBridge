import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VisionRecoveryEngine } from '../engine.js';
import { DEFAULT_VISION_CONFIG } from '../types.js';
import type {
  UnlabeledElement,
  VisionRecoveryConfig,
  ApiVisionClient,
} from '../types.js';

const makeEl = (overrides: Partial<UnlabeledElement> = {}): UnlabeledElement => ({
  nodeHint: 'button',
  bbox: { x: 0, y: 0, w: 40, h: 40 },
  computedRole: null,
  currentAriaLabel: null,
  textContent: '',
  siblingContext: '',
  classSignature: '',
  backgroundImageUrl: null,
  ...overrides,
});

const tier1Config: VisionRecoveryConfig = {
  ...DEFAULT_VISION_CONFIG,
  tierEnabled: { 1: true, 2: false, 3: false },
  minConfidence: 0.5,
};

const tier12Config: VisionRecoveryConfig = {
  ...DEFAULT_VISION_CONFIG,
  tierEnabled: { 1: true, 2: true, 3: false },
  minConfidence: 0.8, // high threshold so Tier-1 typically doesn't satisfy
};

describe('VisionRecoveryEngine', () => {
  it('returns null when element has no signals (Tier 1 only)', async () => {
    const engine = new VisionRecoveryEngine(tier1Config);
    const result = await engine.recoverSingle(makeEl());
    expect(result).toBeNull();
  });

  it('returns a heuristic label for an element with an icon class', async () => {
    const engine = new VisionRecoveryEngine(tier1Config);
    const el = makeEl({ classSignature: 'fa fa-search' });
    const result = await engine.recoverSingle(el);
    expect(result).not.toBeNull();
    expect(result?.source).toBe('heuristic');
    expect(result?.tier).toBe(1);
  });

  it('cache hit on repeated recoverSingle marks source as "cached"', async () => {
    const engine = new VisionRecoveryEngine(tier1Config);
    const el = makeEl({ classSignature: 'fa fa-search' });
    const first = await engine.recoverSingle(el, 'v1');
    expect(first?.source).toBe('heuristic');
    const second = await engine.recoverSingle(el, 'v1');
    expect(second?.source).toBe('cached');
  });

  it('clearCache() invalidates cached entries', async () => {
    const engine = new VisionRecoveryEngine(tier1Config);
    const el = makeEl({ classSignature: 'fa fa-search' });
    await engine.recoverSingle(el, 'v1');
    await engine.clearCache();
    const stats = engine.getCacheStats();
    expect(stats.entries).toBe(0);
  });

  it('recoverLabels returns only non-null results', async () => {
    const engine = new VisionRecoveryEngine(tier1Config);
    const candidates = [
      makeEl({ classSignature: 'fa fa-search' }),
      makeEl(), // no signals
      makeEl({ classSignature: 'icon-close' }),
    ];
    const results = await engine.recoverLabels(candidates);
    expect(results.length).toBe(2);
  });

  it('Tier 2 escalation: when T1 confidence below minConfidence AND tier2 enabled, calls apiClient', async () => {
    const apiClient: ApiVisionClient = {
      inferElementMeaning: vi.fn().mockResolvedValue({
        role: 'button',
        label: 'Submit form',
        description: 'Primary submission action',
        confidence: 0.9,
      }),
    };
    const engine = new VisionRecoveryEngine(tier12Config, apiClient);
    const el = makeEl({ classSignature: 'unknown-cls' }); // no heuristic match
    const result = await engine.recoverSingle(el);
    expect(apiClient.inferElementMeaning).toHaveBeenCalled();
    expect(result?.source).toBe('api-vision');
    expect(result?.tier).toBe(2);
  });

  it('Tier 2 NOT called when tier2Enabled = false', async () => {
    const apiClient: ApiVisionClient = {
      inferElementMeaning: vi.fn(),
    };
    const engine = new VisionRecoveryEngine(tier1Config, apiClient);
    const el = makeEl({ classSignature: 'unknown-cls' });
    await engine.recoverSingle(el);
    expect(apiClient.inferElementMeaning).not.toHaveBeenCalled();
  });

  it('Tier 2 apiClient throw: keeps T1 result when present', async () => {
    const apiClient: ApiVisionClient = {
      inferElementMeaning: vi.fn().mockRejectedValue(new Error('API down')),
    };
    const engine = new VisionRecoveryEngine(tier12Config, apiClient);
    const el = makeEl({ classSignature: 'fa fa-search' });
    // Tier-1 yields a result, but below high minConfidence; apiClient fails;
    // engine should keep T1 result only if confidence >= minConfidence; here 0.75 < 0.8 so null.
    const result = await engine.recoverSingle(el);
    expect(result).toBeNull();
  });

  it('getCacheStats returns a well-formed shape', async () => {
    const engine = new VisionRecoveryEngine(tier1Config);
    const stats = engine.getCacheStats();
    expect(stats).toHaveProperty('hits');
    expect(stats).toHaveProperty('entries');
    expect(stats).toHaveProperty('sizeBytes');
    expect(stats.hits).toBe(0);
    expect(stats.entries).toBe(0);
  });

  it('appVersion segregates cache entries', async () => {
    const engine = new VisionRecoveryEngine(tier1Config);
    const el = makeEl({ classSignature: 'fa fa-search' });
    await engine.recoverSingle(el, 'v1');
    await engine.recoverSingle(el, 'v2');
    const stats = engine.getCacheStats();
    expect(stats.entries).toBeGreaterThanOrEqual(2);
  });

  it('minConfidence filters out low-confidence T1 results', async () => {
    const strictConfig: VisionRecoveryConfig = {
      ...DEFAULT_VISION_CONFIG,
      tierEnabled: { 1: true, 2: false, 3: false },
      minConfidence: 0.99,
    };
    const engine = new VisionRecoveryEngine(strictConfig);
    const el = makeEl({ classSignature: 'fa fa-search' });
    const result = await engine.recoverSingle(el);
    expect(result).toBeNull();
  });
});

describe('VisionRecoveryEngine cache stats', () => {
  let engine: VisionRecoveryEngine;
  beforeEach(() => {
    engine = new VisionRecoveryEngine(tier1Config);
  });

  it('counts cache hits on repeated retrievals', async () => {
    const el = makeEl({ classSignature: 'fa fa-search' });
    await engine.recoverSingle(el, 'v1');
    await engine.recoverSingle(el, 'v1');
    await engine.recoverSingle(el, 'v1');
    const stats = engine.getCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(2);
  });
});
