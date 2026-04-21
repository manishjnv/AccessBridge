/**
 * Session 12 — On-Device ONNX Models
 *
 * Tests for the Session 12 extensions to LocalAIProvider:
 *   - embed() method (MiniLM path + trigram pseudo-embedding fallback)
 *   - summarize() T5 path + fallbacks
 *   - setEmbedder / setSummarizer construction helpers
 *
 * Does NOT duplicate coverage from local-provider.test.ts
 * (heuristic summarize, simplify, classify, translate).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalAIProvider, EMBED_DIM } from '../providers/local.js';
import type { LocalEmbedder, LocalSummarizer } from '../providers/local.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LONG_TEXT = Array.from(
  { length: 10 },
  (_, i) =>
    `Sentence number ${i + 1} describes an important aspect of the topic under discussion.`,
).join(' ');

function makeEmbedder(
  result: Float32Array | null,
): LocalEmbedder & { embed: ReturnType<typeof vi.fn> } {
  return { embed: vi.fn(async () => result) };
}

function makeSummarizer(
  result: string | null,
): LocalSummarizer & { summarize: ReturnType<typeof vi.fn> } {
  return { summarize: vi.fn(async () => result) };
}

function isUnitVector(v: Float32Array): boolean {
  let ss = 0;
  for (let i = 0; i < v.length; i++) ss += v[i] * v[i];
  return Math.abs(ss - 1) < 1e-4;
}

// ---------------------------------------------------------------------------
// embed() — pseudo-embedding (no embedder)
// ---------------------------------------------------------------------------

describe('LocalAIProvider — embed() pseudo-embedding', () => {
  const provider = new LocalAIProvider();

  it('no embedder → returns Float32Array of length EMBED_DIM with at least one non-zero value, L2-normalised', async () => {
    const v = await provider.embed('hello world');

    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBED_DIM);
    expect(Array.from(v).some((x) => x !== 0)).toBe(true);
    expect(isUnitVector(v)).toBe(true);
  });

  it('pseudo-embedding is deterministic — two calls with the same input produce identical vectors', async () => {
    const v1 = await provider.embed('hello world');
    const v2 = await provider.embed('hello world');

    expect(v1.length).toBe(v2.length);
    for (let i = 0; i < v1.length; i++) {
      expect(v1[i]).toBe(v2[i]);
    }
  });

  it('different inputs produce different pseudo-embeddings', async () => {
    const vCat = await provider.embed('cat');
    const vDog = await provider.embed('dog');

    let differs = false;
    for (let i = 0; i < vCat.length; i++) {
      if (vCat[i] !== vDog[i]) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// embed() — embedder provided
// ---------------------------------------------------------------------------

describe('LocalAIProvider — embed() with embedder', () => {
  it('embedder returns valid Float32Array(384) → passed through unchanged', async () => {
    const expected = Float32Array.from({ length: EMBED_DIM }, (_, i) =>
      i === 0 ? 1 : 0,
    );
    const embedder = makeEmbedder(expected);
    const provider = new LocalAIProvider({ embedder });

    const result = await provider.embed('x');

    expect(result).toEqual(expected);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledWith('x');
  });

  it('embedder returns null → fallback to pseudo-embedding (Float32Array of EMBED_DIM)', async () => {
    const embedder = makeEmbedder(null);
    const provider = new LocalAIProvider({ embedder });

    const result = await provider.embed('hello');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBED_DIM);
  });

  it('embedder returns wrong-size vector (128 dims) → fallback returns Float32Array(384)', async () => {
    const shortVec = new Float32Array(128);
    const embedder: LocalEmbedder = { embed: vi.fn(async () => shortVec) };
    const provider = new LocalAIProvider({ embedder });

    const result = await provider.embed('test');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBED_DIM);
  });

  it('embedder throws → no re-throw, fallback returns Float32Array(384)', async () => {
    const embedder: LocalEmbedder = {
      embed: vi.fn(async () => {
        throw new Error('ONNX runtime error');
      }),
    };
    const provider = new LocalAIProvider({ embedder });

    await expect(provider.embed('test')).resolves.toBeInstanceOf(Float32Array);
    const result = await provider.embed('test');
    expect(result.length).toBe(EMBED_DIM);
  });

  it('forceFallback: () => true skips the embedder entirely → pseudo-embedding returned', async () => {
    const embedder = makeEmbedder(
      Float32Array.from({ length: EMBED_DIM }, () => 1),
    );
    const provider = new LocalAIProvider({
      embedder,
      forceFallback: () => true,
    });

    const result = await provider.embed('forced');

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBED_DIM);
  });

  it('onFallback is invoked once with "embedder" when the embedder returns null', async () => {
    const onFallback = vi.fn();
    const embedder = makeEmbedder(null);
    const provider = new LocalAIProvider({ embedder, onFallback });

    await provider.embed('trigger fallback');

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('embedder');
  });

  it('modelTimeoutMs triggers fallback — never-resolving embedder falls back within wall-clock budget', async () => {
    vi.useFakeTimers();

    const embedder: LocalEmbedder = {
      embed: vi.fn(() => new Promise<Float32Array>(() => { /* never resolves */ })),
    };
    const provider = new LocalAIProvider({ embedder, modelTimeoutMs: 50 });

    const resultPromise = provider.embed('timeout test');

    // Advance fake timers past the timeout threshold
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBED_DIM);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// summarize() — T5 path
// ---------------------------------------------------------------------------

describe('LocalAIProvider — summarize() T5 path', () => {
  it('summarizer returns text → provider returns that text, not heuristic output', async () => {
    const summarizer = makeSummarizer('MODEL OUTPUT');
    const provider = new LocalAIProvider({ summarizer });

    const result = await provider.summarize(LONG_TEXT);

    expect(result).toBe('MODEL OUTPUT');
    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
  });

  it('summarizer returns null → heuristic fallback (non-empty, trimmed string)', async () => {
    const summarizer = makeSummarizer(null);
    const provider = new LocalAIProvider({ summarizer });

    const result = await provider.summarize(LONG_TEXT);

    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).not.toBe('null');
  });

  it('summarizer returns empty string → fallback (non-empty)', async () => {
    const summarizer = makeSummarizer('');
    const provider = new LocalAIProvider({ summarizer });

    const result = await provider.summarize(LONG_TEXT);

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('summarizer returns whitespace-only string → fallback (non-empty)', async () => {
    const summarizer = makeSummarizer('   ');
    const provider = new LocalAIProvider({ summarizer });

    const result = await provider.summarize(LONG_TEXT);

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('summarizer throws → fallback without propagating the error', async () => {
    const summarizer: LocalSummarizer = {
      summarize: vi.fn(async () => {
        throw new Error('T5 crash');
      }),
    };
    const provider = new LocalAIProvider({ summarizer });

    await expect(provider.summarize(LONG_TEXT)).resolves.toBeTruthy();
    const result = await provider.summarize(LONG_TEXT);
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('forceFallback: () => true skips summarizer — summarize not called, heuristic output returned', async () => {
    const summarizer = makeSummarizer('MODEL OUTPUT');
    const provider = new LocalAIProvider({
      summarizer,
      forceFallback: () => true,
    });

    const result = await provider.summarize(LONG_TEXT);

    expect(summarizer.summarize).not.toHaveBeenCalled();
    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).not.toBe('MODEL OUTPUT');
  });

  it('setSummarizer(null) removes the model — subsequent summarize uses heuristic', async () => {
    const summarizer = makeSummarizer('MODEL OUTPUT');
    const provider = new LocalAIProvider({ summarizer });

    // Before removal: model is used
    const before = await provider.summarize(LONG_TEXT);
    expect(before).toBe('MODEL OUTPUT');

    // Remove the summarizer
    provider.setSummarizer(null);

    // After removal: heuristic is used
    const after = await provider.summarize(LONG_TEXT);
    expect(after.trim().length).toBeGreaterThan(0);
    expect(after).not.toBe('MODEL OUTPUT');
  });
});

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

describe('LocalAIProvider — setEmbedder()', () => {
  it('setEmbedder replaces the embedder — subsequent embed() uses the new one', async () => {
    const provider = new LocalAIProvider();

    // Start with no embedder: result is pseudo-embedding
    const pseudo = await provider.embed('replace me');
    expect(pseudo.length).toBe(EMBED_DIM);

    // Wire in a real embedder
    const modelVec = Float32Array.from({ length: EMBED_DIM }, (_, i) =>
      i === 1 ? 1 : 0,
    );
    const newEmbedder = makeEmbedder(modelVec);
    provider.setEmbedder(newEmbedder);

    const result = await provider.embed('replace me');

    expect(result).toEqual(modelVec);
    expect(newEmbedder.embed).toHaveBeenCalledTimes(1);
    expect(newEmbedder.embed).toHaveBeenCalledWith('replace me');
  });
});
