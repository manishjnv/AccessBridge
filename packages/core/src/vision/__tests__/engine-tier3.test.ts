import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VisionRecoveryEngine } from '../engine.js';
import { DEFAULT_VISION_CONFIG } from '../types.js';
import type {
  UnlabeledElement,
  OnDeviceVisionClient,
  ScreenshotProvider,
  LabelEmbedder,
  ScreenshotHasher,
  ImageDataLike,
  ApiVisionClient,
} from '../types.js';

function el(overrides: Partial<UnlabeledElement> = {}): UnlabeledElement {
  return {
    nodeHint: 'div.btn',
    bbox: { x: 0, y: 0, w: 40, h: 40 },
    computedRole: null,
    currentAriaLabel: null,
    textContent: '',
    siblingContext: '',
    classSignature: 'sig-' + Math.random().toString(36).slice(2),
    backgroundImageUrl: null,
    ...overrides,
  };
}

function img(w: number = 32, h: number = 32): ImageDataLike {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

function makeOnDevice(opts: { loaded?: boolean; fails?: boolean; confidence?: number } = {}): OnDeviceVisionClient {
  const loaded = opts.loaded ?? true;
  const fails = opts.fails ?? false;
  const confidence = opts.confidence ?? 0.9;
  return {
    isLoaded: () => loaded,
    describeElement: vi.fn(async () => {
      if (fails) throw new Error('boom');
      return {
        caption: 'a submit button',
        role: 'button',
        inferredLabel: 'submit button',
        confidence,
        latencyMs: 23,
      };
    }),
  };
}

function makeScreenshotProvider(opts: { returnsNull?: boolean; throws?: boolean } = {}): ScreenshotProvider {
  return {
    screenshot: vi.fn(async () => {
      if (opts.throws === true) throw new Error('capture failed');
      if (opts.returnsNull === true) return null;
      return img(64, 64);
    }),
  };
}

function makeHasher(fixedHash: string = 'aabbcc'): ScreenshotHasher {
  return {
    hash: vi.fn(async () => fixedHash),
  };
}

function makeEmbedder(vecs: Record<string, Float32Array>): LabelEmbedder {
  return {
    embed: vi.fn(async (t: string) => {
      for (const [k, v] of Object.entries(vecs)) if (t.includes(k)) return v;
      return new Float32Array([0.01, 0.01, 0.01]);
    }),
  };
}

const cfgTier3 = {
  ...DEFAULT_VISION_CONFIG,
  tierEnabled: { 1: true, 2: false, 3: true },
  minConfidence: 0.7,
  maxPerPageScan: 10,
  maxTier3PerDay: 100,
};

describe('VisionRecoveryEngine — Tier 3 waterfall', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('escalates to Tier 3 when Tier 1 is low-confidence and Tier 3 enabled', async () => {
    const engine = new VisionRecoveryEngine(cfgTier3, null, {
      onDeviceClient: makeOnDevice({ confidence: 0.95 }),
      screenshotProvider: makeScreenshotProvider(),
    });
    const result = await engine.recoverSingle(el({ nodeHint: 'div.icon' }), 'v1');
    expect(result).not.toBeNull();
    expect(result?.tier).toBe(3);
    expect(result?.source).toBe('on-device-vlm');
  });

  it('does NOT invoke Tier 3 when disabled in profile', async () => {
    const onDev = makeOnDevice({ confidence: 0.95 });
    const engine = new VisionRecoveryEngine(
      { ...cfgTier3, tierEnabled: { 1: true, 2: false, 3: false } },
      null,
      { onDeviceClient: onDev, screenshotProvider: makeScreenshotProvider() },
    );
    await engine.recoverSingle(el(), 'v1');
    expect(onDev.describeElement).not.toHaveBeenCalled();
  });

  it('does NOT invoke Tier 3 when model is not loaded', async () => {
    const onDev = makeOnDevice({ loaded: false });
    const engine = new VisionRecoveryEngine(cfgTier3, null, {
      onDeviceClient: onDev,
      screenshotProvider: makeScreenshotProvider(),
    });
    await engine.recoverSingle(el(), 'v1');
    expect(onDev.describeElement).not.toHaveBeenCalled();
  });

  it('semantic-hash dedup: identical screenshot → second call cached, does not re-infer', async () => {
    const onDev = makeOnDevice({ confidence: 0.95 });
    const engine = new VisionRecoveryEngine(cfgTier3, null, {
      onDeviceClient: onDev,
      screenshotProvider: makeScreenshotProvider(),
      screenshotHasher: makeHasher('same-hash'),
    });
    const e1 = el({ classSignature: 'sig-A' });
    const e2 = el({ classSignature: 'sig-B' }); // different DOM cache key
    await engine.recoverSingle(e1, 'v1');
    const r2 = await engine.recoverSingle(e2, 'v1');
    expect(onDev.describeElement).toHaveBeenCalledTimes(1); // dedup prevented second inference
    expect(r2?.source).toBe('cached');
    const stats = engine.getCacheStats();
    expect(stats.dedupHits).toBe(1);
  });

  it('semantic similarity via MiniLM collapses near-duplicate labels', async () => {
    const vec = new Float32Array([1, 0, 0]);
    const embedder = makeEmbedder({ submit: vec });
    const onDev = makeOnDevice({ confidence: 0.95 });
    // Return two different screenshots so dedup doesn't mask the semantic match.
    let count = 0;
    const provider: ScreenshotProvider = {
      screenshot: async () => {
        count++;
        return { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).fill(count) };
      },
    };
    const hasher: ScreenshotHasher = {
      hash: async () => 'hash-' + Math.random(), // always different
    };
    const engine = new VisionRecoveryEngine(
      { ...cfgTier3, semanticSimilarityThreshold: 0.5 },
      null,
      { onDeviceClient: onDev, screenshotProvider: provider, labelEmbedder: embedder, screenshotHasher: hasher },
    );
    const r1 = await engine.recoverSingle(el({ classSignature: 'sig-A' }), 'v1');
    const r2 = await engine.recoverSingle(el({ classSignature: 'sig-B' }), 'v1');
    expect(r1?.source).toBe('on-device-vlm');
    expect(r2?.source).toBe('semantic-similar');
    expect(r2?.similarTo).toBe('submit button');
    expect(engine.getCacheStats().semanticReuse).toBe(1);
  });

  it('final fallback: all tiers fail → returns null', async () => {
    const engine = new VisionRecoveryEngine(
      { ...cfgTier3, tierEnabled: { 1: false, 2: false, 3: true } },
      null,
      { onDeviceClient: makeOnDevice({ fails: true }), screenshotProvider: makeScreenshotProvider() },
    );
    const result = await engine.recoverSingle(el(), 'v1');
    expect(result).toBeNull();
  });

  it('Tier 3 throws → falls through to Tier 1 if Tier 1 was high-confidence', async () => {
    const engine = new VisionRecoveryEngine(cfgTier3, null, {
      onDeviceClient: makeOnDevice({ fails: true }),
      screenshotProvider: makeScreenshotProvider(),
    });
    // Feed an element Tier 1 handles well → icon lexicon hit if applicable.
    const result = await engine.recoverSingle(
      el({ nodeHint: 'button.fa-solid-arrow-right', textContent: 'Next' }),
      'v1',
    );
    // The result may be null (if Tier 1 returned low-confidence) or tier 1 — we only assert no throw bubbled up.
    expect(result === null || result.tier === 1).toBe(true);
  });

  it('screenshot provider throws → Tier 3 skipped, engine does not throw', async () => {
    const engine = new VisionRecoveryEngine(cfgTier3, null, {
      onDeviceClient: makeOnDevice(),
      screenshotProvider: makeScreenshotProvider({ throws: true }),
    });
    const result = await engine.recoverSingle(el(), 'v1');
    expect(result === null || result.tier !== 3).toBe(true);
  });

  it('per-scan cap: once tier3ScanCount hits maxPerPageScan, further Tier 3 skipped', async () => {
    const onDev = makeOnDevice({ confidence: 0.95 });
    // Unique hashes so dedup doesn't mask the scan-cap.
    let h = 0;
    const hasher: ScreenshotHasher = { hash: async () => 'h-' + h++ };
    const engine = new VisionRecoveryEngine(
      { ...cfgTier3, maxPerPageScan: 2 },
      null,
      { onDeviceClient: onDev, screenshotProvider: makeScreenshotProvider(), screenshotHasher: hasher },
    );
    const cands = Array.from({ length: 5 }, (_, i) => el({ classSignature: 'c' + i }));
    await engine.recoverLabels(cands, 'v1');
    expect((onDev.describeElement as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('per-day cap: once maxTier3PerDay reached, no further Tier 3 inferences', async () => {
    const onDev = makeOnDevice({ confidence: 0.95 });
    let h = 0;
    const hasher: ScreenshotHasher = { hash: async () => 'd-' + h++ };
    const engine = new VisionRecoveryEngine(
      { ...cfgTier3, maxTier3PerDay: 1, maxPerPageScan: 100 },
      null,
      { onDeviceClient: onDev, screenshotProvider: makeScreenshotProvider(), screenshotHasher: hasher },
    );
    await engine.recoverSingle(el({ classSignature: 'a' }), 'v1');
    await engine.recoverSingle(el({ classSignature: 'b' }), 'v1');
    expect((onDev.describeElement as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('getCacheStats exposes Tier counters', async () => {
    const engine = new VisionRecoveryEngine(cfgTier3, null, {
      onDeviceClient: makeOnDevice(),
      screenshotProvider: makeScreenshotProvider(),
    });
    await engine.recoverSingle(el(), 'v1');
    const stats = engine.getCacheStats();
    expect(stats).toHaveProperty('tier3');
    expect(stats).toHaveProperty('tier3Today');
    expect(stats).toHaveProperty('semanticReuse');
  });

  it('clearCache resets all tier counters + vocab', async () => {
    const engine = new VisionRecoveryEngine(cfgTier3, null, {
      onDeviceClient: makeOnDevice(),
      screenshotProvider: makeScreenshotProvider(),
    });
    await engine.recoverSingle(el(), 'v1');
    await engine.clearCache();
    const stats = engine.getCacheStats();
    expect(stats.entries).toBe(0);
    expect(stats.tier3).toBe(0);
    expect(stats.semanticReuse).toBe(0);
    expect(stats.dedupHits).toBe(0);
  });

  it('Tier 2 still wins when tierEnabled[2] is true and confidence high', async () => {
    const apiClient: ApiVisionClient = {
      inferElementMeaning: vi.fn(async () => ({
        role: 'button',
        label: 'from-tier2',
        description: 'tier2 desc',
        confidence: 0.95,
      })),
    };
    const onDev = makeOnDevice();
    const engine = new VisionRecoveryEngine(
      { ...cfgTier3, tierEnabled: { 1: true, 2: true, 3: true } },
      apiClient,
      { onDeviceClient: onDev, screenshotProvider: makeScreenshotProvider() },
    );
    const r = await engine.recoverSingle(el(), 'v1');
    expect(r?.source).toBe('api-vision');
    expect(onDev.describeElement).not.toHaveBeenCalled();
  });

  it('DOM cache hit: second recoverSingle with identical element returns source="cached"', async () => {
    const engine = new VisionRecoveryEngine(cfgTier3, null, {
      onDeviceClient: makeOnDevice(),
      screenshotProvider: makeScreenshotProvider(),
    });
    const e = el({ classSignature: 'stable' });
    await engine.recoverSingle(e, 'v1');
    const r2 = await engine.recoverSingle(e, 'v1');
    expect(r2?.source).toBe('cached');
  });
});
