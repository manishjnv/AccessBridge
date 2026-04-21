/**
 * Session 12 — On-Device ONNX Models
 * Tests specific to the NEW additions: featurize() and the classifier-blending
 * path via getStruggleScoreAsync().
 *
 * Does NOT duplicate coverage from struggle-detector.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StruggleDetector,
  FEATURE_DIM,
  SIGNAL_FEATURE_ORDER,
  STATS_PER_SIGNAL,
  CLASSIFIER_BLEND_THRESHOLD,
  CLASSIFIER_BLEND_WEIGHT,
  HEURISTIC_BLEND_WEIGHT,
} from '../signals/struggle-detector.js';
import type { StruggleClassifierLike } from '../signals/struggle-detector.js';
import { SignalType } from '../types/signals.js';
import type { BehaviorSignal } from '../types/signals.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSignal(
  type: SignalType,
  normalized: number,
  timestamp = Date.now(),
): BehaviorSignal {
  return { type, value: normalized, normalized, timestamp };
}

function makeClassifier(
  impl: (features: Float32Array) => Promise<{ score: number; confidence: number } | null>,
): StruggleClassifierLike {
  return { predict: vi.fn(impl) };
}

// ─── featurize() ─────────────────────────────────────────────────────────────

describe('featurize()', () => {
  let detector: StruggleDetector;

  beforeEach(() => {
    detector = new StruggleDetector();
  });

  it('empty window → Float32Array of length FEATURE_DIM (60) with every value 0', () => {
    const out = detector.featurize();
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(FEATURE_DIM);
    expect(FEATURE_DIM).toBe(60);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0);
    }
  });

  it('length is always FEATURE_DIM even with many signals of a single type', () => {
    // Add 15 SCROLL_VELOCITY signals — more than 10 unique types
    for (let i = 0; i < 15; i++) {
      detector.addSignal(makeSignal(SignalType.SCROLL_VELOCITY, Math.random()));
    }
    const out = detector.featurize();
    expect(out.length).toBe(FEATURE_DIM);
  });

  it('layout: signal at order-index 0 writes bytes 0..5; index 1 writes bytes 6..11', () => {
    // SCROLL_VELOCITY is index 0 in SIGNAL_FEATURE_ORDER
    expect(SIGNAL_FEATURE_ORDER[0]).toBe(SignalType.SCROLL_VELOCITY);
    detector.addSignal(makeSignal(SignalType.SCROLL_VELOCITY, 0.7));
    let out = detector.featurize();
    // With n=1: current=0.7, mean=0.7
    expect(out[0]).toBeCloseTo(0.7, 5); // current
    expect(out[1]).toBeCloseTo(0.7, 5); // mean (n=1 → mean === current)

    // CLICK_ACCURACY is index 1 in SIGNAL_FEATURE_ORDER
    expect(SIGNAL_FEATURE_ORDER[1]).toBe(SignalType.CLICK_ACCURACY);
    detector.reset();
    detector.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.4));
    out = detector.featurize();
    expect(out[6]).toBeCloseTo(0.4, 5); // current at base=6
    expect(out[7]).toBeCloseTo(0.4, 5); // mean at base+1=7
  });

  it('stats correctness with three CURSOR_PATH samples 0.2, 0.6, 1.0 (index 6, base 36)', () => {
    // CURSOR_PATH is index 6 in SIGNAL_FEATURE_ORDER → base = 6 * 6 = 36
    expect(SIGNAL_FEATURE_ORDER[6]).toBe(SignalType.CURSOR_PATH);
    expect(6 * STATS_PER_SIGNAL).toBe(36);

    // Use fixed timestamps so they stay within the 60-second window.
    const now = Date.now();
    detector.addSignal(makeSignal(SignalType.CURSOR_PATH, 0.2, now - 2000));
    detector.addSignal(makeSignal(SignalType.CURSOR_PATH, 0.6, now - 1000));
    detector.addSignal(makeSignal(SignalType.CURSOR_PATH, 1.0, now));

    const out = detector.featurize();

    // current (last sample)
    expect(out[36]).toBeCloseTo(1.0, 2);
    // mean = (0.2+0.6+1.0)/3 = 0.6
    expect(out[37]).toBeCloseTo(0.6, 2);
    // stddev = sqrt(((0.2-0.6)^2+(0.6-0.6)^2+(1.0-0.6)^2)/3)
    //        = sqrt((0.16+0+0.16)/3) = sqrt(0.10667) ≈ 0.3266
    expect(out[38]).toBeCloseTo(0.327, 2);
    // min
    expect(out[39]).toBeCloseTo(0.2, 2);
    // max
    expect(out[40]).toBeCloseTo(1.0, 2);
    // trend: least-squares slope=0.4, then * (n-1)=2 → 0.8, clamped → 0.8
    expect(out[41]).toBeCloseTo(0.8, 2);
  });

  it('clamps out-of-range normalized values; all mean/min/max/current/stddev values stay in [0,1]', () => {
    detector.addSignal(makeSignal(SignalType.SCROLL_VELOCITY, 1.5));
    detector.addSignal(makeSignal(SignalType.SCROLL_VELOCITY, -0.3));

    const out = detector.featurize();

    // Slots 0..4 are current, mean, stddev, min, max for SCROLL_VELOCITY (index 0)
    // slot 5 is trend which can be in [-1, 1]
    const base = 0;
    expect(out[base + 0]).toBeGreaterThanOrEqual(0); // current
    expect(out[base + 0]).toBeLessThanOrEqual(1);
    expect(out[base + 1]).toBeGreaterThanOrEqual(0); // mean
    expect(out[base + 1]).toBeLessThanOrEqual(1);
    expect(out[base + 2]).toBeGreaterThanOrEqual(0); // stddev
    expect(out[base + 2]).toBeLessThanOrEqual(1);
    expect(out[base + 3]).toBeGreaterThanOrEqual(0); // min
    expect(out[base + 3]).toBeLessThanOrEqual(1);
    expect(out[base + 4]).toBeGreaterThanOrEqual(0); // max
    expect(out[base + 4]).toBeLessThanOrEqual(1);
    // trend (slot 5) is allowed [-1, 1]
    expect(out[base + 5]).toBeGreaterThanOrEqual(-1);
    expect(out[base + 5]).toBeLessThanOrEqual(1);

    // Verify the entire array has no value outside [-1, 1]
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(-1);
      expect(out[i]).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Classifier blending via getStruggleScoreAsync() ────────────────────────

describe('getStruggleScoreAsync() — classifier blending', () => {
  let detector: StruggleDetector;
  const now = Date.now();

  beforeEach(() => {
    detector = new StruggleDetector();
    // Single deterministic signal for a predictable heuristic score.
    // SCROLL_VELOCITY normalized=1.0 with default baseline mean=0.5, stddev=0.2:
    //   deviation = |1.0-0.5|/0.2 = 2.5 → clamped = 2.5/3 ≈ 0.8333
    //   weightedSum = 0.8333 * 0.08 = 0.06667, totalWeight = 0.08
    //   rawScore = (0.06667/0.08)*100 ≈ 83.33 → score = 83.33
    //   typeRatio = 1/10 = 0.1, countRatio = min(1/5,1) = 0.2
    //   confidence = 0.1*0.6 + 0.2*0.4 = 0.14
    detector.addSignal(makeSignal(SignalType.SCROLL_VELOCITY, 1.0, now));
  });

  it('no classifier → async returns same score and confidence as sync; hasClassifier() is false', async () => {
    expect(detector.hasClassifier()).toBe(false);
    const sync = detector.getStruggleScore();
    const async_ = await detector.getStruggleScoreAsync();
    expect(async_.score).toBe(sync.score);
    expect(async_.confidence).toBe(sync.confidence);
  });

  it('classifier confidence <= CLASSIFIER_BLEND_THRESHOLD → heuristic fallthrough; predict called once', async () => {
    const clf = makeClassifier(async () => ({ score: 90, confidence: 0.6 }));
    // 0.6 <= 0.7 (CLASSIFIER_BLEND_THRESHOLD) → should NOT blend
    detector.setClassifier(clf);
    const heuristic = detector.getStruggleScore();
    const result = await detector.getStruggleScoreAsync();

    expect(result.score).toBe(heuristic.score);
    expect(clf.predict).toHaveBeenCalledTimes(1);
  });

  it('classifier confidence > CLASSIFIER_BLEND_THRESHOLD → blended score = 0.6*clf + 0.4*heuristic', async () => {
    // Classifier returns score=90, confidence=0.9 (> 0.7 threshold).
    // Heuristic score from the beforeEach signal = 83.33 (deterministic).
    // Expected blend = 0.6*90 + 0.4*83.33 = 54 + 33.332 = 87.332
    //   → Math.round(87.332*100)/100 = 87.33
    const clf = makeClassifier(async () => ({ score: 90, confidence: 0.9 }));
    detector.setClassifier(clf);

    const heuristic = detector.getStruggleScore();
    const result = await detector.getStruggleScoreAsync();

    const expectedScore =
      Math.round(
        Math.min(
          100,
          Math.max(
            0,
            CLASSIFIER_BLEND_WEIGHT * 90 + HEURISTIC_BLEND_WEIGHT * heuristic.score,
          ),
        ) * 100,
      ) / 100;

    expect(result.score).toBeCloseTo(expectedScore, 2);
    expect(clf.predict).toHaveBeenCalledTimes(1);
  });

  it('classifier returns null → async score matches heuristic only', async () => {
    const clf = makeClassifier(async () => null);
    detector.setClassifier(clf);

    const heuristic = detector.getStruggleScore();
    const result = await detector.getStruggleScoreAsync();

    expect(result.score).toBe(heuristic.score);
    expect(result.confidence).toBe(heuristic.confidence);
  });

  it('classifier throws → resolves with heuristic score, no error surfaces', async () => {
    const clf = makeClassifier(async () => {
      throw new Error('boom');
    });
    detector.setClassifier(clf);

    const heuristic = detector.getStruggleScore();
    // Must NOT reject
    const result = await expect(detector.getStruggleScoreAsync()).resolves.toBeDefined();
    const resolved = await detector.getStruggleScoreAsync();
    expect(resolved.score).toBe(heuristic.score);
  });

  it('setClassifier(null) removes blending — predict is never called after unset', async () => {
    const clf = makeClassifier(async () => ({ score: 90, confidence: 0.95 }));
    detector.setClassifier(clf);
    expect(detector.hasClassifier()).toBe(true);

    detector.setClassifier(null);
    expect(detector.hasClassifier()).toBe(false);

    await detector.getStruggleScoreAsync();
    expect(clf.predict).not.toHaveBeenCalled();
  });

  it('blended confidence is max(heuristic.confidence, classifier.confidence)', async () => {
    // heuristic.confidence ≈ 0.14 (from the deterministic signal in beforeEach)
    // classifier.confidence = 0.9 → result.confidence should be 0.9
    const clf = makeClassifier(async () => ({ score: 50, confidence: 0.9 }));
    detector.setClassifier(clf);

    const heuristic = detector.getStruggleScore();
    const result = await detector.getStruggleScoreAsync();

    const expectedConfidence =
      Math.round(Math.min(1, Math.max(heuristic.confidence, 0.9)) * 100) / 100;
    expect(result.confidence).toBeCloseTo(expectedConfidence, 2);
    // Specifically: max(0.14, 0.9) = 0.9
    expect(result.confidence).toBeCloseTo(0.9, 2);
  });
});
