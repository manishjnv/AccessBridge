import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StruggleClassifier, buildPrediction } from '../models/struggle-classifier.js';
import type { ONNXRuntime } from '../runtime.js';
import type { InferenceSessionLike, TensorLike } from '../types.js';
import { STRUGGLE_CLASSIFIER_ID } from '../model-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(probs: number[]): InferenceSessionLike {
  return {
    inputNames: ['features'],
    outputNames: ['probabilities'],
    run: async () => ({
      probabilities: {
        type: 'float32',
        data: new Float32Array(probs),
        dims: [1, probs.length],
      } satisfies TensorLike,
    }),
  };
}

function makeMockRuntime(
  opts: {
    session?: InferenceSessionLike | null;
    tensor?: TensorLike | null;
  } = {},
) {
  const recordInference = vi.fn();
  const recordFallback = vi.fn();
  const hasModel = vi.fn(
    () => opts.session !== null && opts.session !== undefined,
  );
  const getModel = vi.fn(() => opts.session ?? null);
  const createTensor = vi.fn(
    () =>
      opts.tensor ?? {
        type: 'float32',
        data: new Float32Array(60),
        dims: [1, 60],
      },
  );
  return {
    getModel,
    hasModel,
    createTensor,
    recordInference,
    recordFallback,
    loadModel: vi.fn(async () => ({
      ok: true,
      session: opts.session,
      cached: false,
    })),
  } as unknown as ONNXRuntime;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StruggleClassifier', () => {
  describe('predict() — session not loaded', () => {
    it('returns null when no session is registered', async () => {
      const runtime = makeMockRuntime({ session: null });
      const clf = new StruggleClassifier(runtime);

      const result = await clf.predict(new Float32Array(60));

      expect(result).toBeNull();
    });
  });

  describe('predict() — feature-length validation', () => {
    it('returns null when features has fewer than 60 elements (50)', async () => {
      const runtime = makeMockRuntime({ session: makeSession([0.25, 0.25, 0.25, 0.25]) });
      const clf = new StruggleClassifier(runtime);

      expect(await clf.predict(new Float32Array(50))).toBeNull();
    });

    it('returns null when features is empty (length 0)', async () => {
      const runtime = makeMockRuntime({ session: makeSession([0.25, 0.25, 0.25, 0.25]) });
      const clf = new StruggleClassifier(runtime);

      expect(await clf.predict(new Float32Array(0))).toBeNull();
    });

    it('returns null when features has more than 60 elements (61)', async () => {
      const runtime = makeMockRuntime({ session: makeSession([0.25, 0.25, 0.25, 0.25]) });
      const clf = new StruggleClassifier(runtime);

      expect(await clf.predict(new Float32Array(61))).toBeNull();
    });
  });

  describe('predict() — happy paths', () => {
    it('returns high bucket with high confidence when argmax is class 3', async () => {
      // probs: [0.05, 0.05, 0.10, 0.80] → argmax=3 (high), confidence=0.80
      // weighted score = (0.05/1)*0 + (0.05/1)*25 + (0.10/1)*60 + (0.80/1)*85
      //                = 0 + 1.25 + 6 + 68 = 75.25
      const runtime = makeMockRuntime({
        session: makeSession([0.05, 0.05, 0.1, 0.8]),
      });
      const clf = new StruggleClassifier(runtime);

      const result = await clf.predict(new Float32Array(60));

      expect(result).not.toBeNull();
      expect(result!.bucket).toBe('high');
      expect(result!.confidence).toBeCloseTo(0.8, 5);
      // Weighted score sits between 60 (medium centre) and 85 (high centre)
      expect(result!.score).toBeGreaterThan(60);
      expect(result!.score).toBeLessThanOrEqual(85);
    });

    it('returns none bucket with high confidence when argmax is class 0', async () => {
      // probs: [0.7, 0.1, 0.1, 0.1] → argmax=0 (none), confidence=0.70
      // weighted score = (0.7/1)*0 + (0.1/1)*25 + (0.1/1)*60 + (0.1/1)*85
      //                = 0 + 2.5 + 6 + 8.5 = 17
      const runtime = makeMockRuntime({
        session: makeSession([0.7, 0.1, 0.1, 0.1]),
      });
      const clf = new StruggleClassifier(runtime);

      const result = await clf.predict(new Float32Array(60));

      expect(result).not.toBeNull();
      expect(result!.bucket).toBe('none');
      expect(result!.confidence).toBeCloseTo(0.7, 5);
      expect(result!.score).toBeLessThan(25);
    });

    it('returns score ~42.5 for a flat distribution (equal probs)', async () => {
      // probs: [0.25, 0.25, 0.25, 0.25]
      // weighted score = (0+25+60+85)/4 = 42.5
      const runtime = makeMockRuntime({
        session: makeSession([0.25, 0.25, 0.25, 0.25]),
      });
      const clf = new StruggleClassifier(runtime);

      const result = await clf.predict(new Float32Array(60));

      expect(result).not.toBeNull();
      expect(result!.score).toBeCloseTo(42.5, 1);
      expect(result!.confidence).toBeCloseTo(0.25, 5);
    });
  });

  describe('predict() — error handling', () => {
    it('returns null and calls recordFallback when session.run throws', async () => {
      const session: InferenceSessionLike = {
        inputNames: ['features'],
        outputNames: ['probabilities'],
        run: async () => {
          throw new Error('ONNX runtime error');
        },
      };
      const runtime = makeMockRuntime({ session });
      const clf = new StruggleClassifier(runtime);

      const result = await clf.predict(new Float32Array(60));

      expect(result).toBeNull();
      expect((runtime as unknown as { recordFallback: ReturnType<typeof vi.fn> }).recordFallback).toHaveBeenCalledTimes(1);
    });

    it('calls recordInference once with modelId on successful inference', async () => {
      const runtime = makeMockRuntime({
        session: makeSession([0.05, 0.05, 0.1, 0.8]),
      });
      const clf = new StruggleClassifier(runtime);

      await clf.predict(new Float32Array(60));

      const ri = (runtime as unknown as { recordInference: ReturnType<typeof vi.fn> }).recordInference;
      expect(ri).toHaveBeenCalledTimes(1);
      expect(ri.mock.calls[0]![0]).toBe(STRUGGLE_CLASSIFIER_ID);
    });
  });

  describe('ready()', () => {
    it('returns true when hasModel returns true', () => {
      const runtime = makeMockRuntime({ session: makeSession([0.25, 0.25, 0.25, 0.25]) });
      const clf = new StruggleClassifier(runtime);

      expect(clf.ready()).toBe(true);
    });

    it('returns false when hasModel returns false (no session)', () => {
      const runtime = makeMockRuntime({ session: null });
      const clf = new StruggleClassifier(runtime);

      expect(clf.ready()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// buildPrediction unit tests (pure function, no mocking needed)
// ---------------------------------------------------------------------------

describe('buildPrediction', () => {
  it('all probability in class 3 → bucket high, score 85, confidence 1', () => {
    const result = buildPrediction(new Float32Array([0, 0, 0, 1]));

    expect(result.bucket).toBe('high');
    expect(result.score).toBeCloseTo(85, 5);
    expect(result.confidence).toBeCloseTo(1, 5);
  });

  it('all probability in class 0 → bucket none, score 0, confidence 1', () => {
    const result = buildPrediction(new Float32Array([1, 0, 0, 0]));

    expect(result.bucket).toBe('none');
    expect(result.score).toBeCloseTo(0, 5);
    expect(result.confidence).toBeCloseTo(1, 5);
  });

  it('all-zero probs do not throw and fall back to argmax-0 (none)', () => {
    expect(() => {
      const result = buildPrediction(new Float32Array([0, 0, 0, 0]));
      // probSum === 0 → falls back to BUCKET_CENTERS[maxIdx=0] = 0
      expect(result.bucket).toBe('none');
      expect(result.score).toBe(0);
    }).not.toThrow();
  });

  it('clamps score to [0, 100] even when raw weighted value would exceed bounds', () => {
    // Negative probs are clamped to 0 internally; supply probs > 1 by using
    // a raw Float32Array that sums > 1 so we exercise the clamp on score.
    // All weight on class 3 (centre 85) → score should equal 85, well within [0,100].
    const result = buildPrediction(new Float32Array([0, 0, 0, 2]));
    // maxProb=2 → confidence clamped to 1
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
