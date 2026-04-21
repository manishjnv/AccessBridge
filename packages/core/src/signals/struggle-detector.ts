import { SignalType } from '../types/signals.js';
import type {
  BehaviorSignal,
  StruggleScore,
  UserBaseline,
  SignalBaseline,
} from '../types/signals.js';

const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  [SignalType.SCROLL_VELOCITY]: 0.08,
  [SignalType.CLICK_ACCURACY]: 0.15,
  [SignalType.DWELL_TIME]: 0.1,
  [SignalType.TYPING_RHYTHM]: 0.12,
  [SignalType.BACKSPACE_RATE]: 0.12,
  [SignalType.ZOOM_EVENTS]: 0.1,
  [SignalType.CURSOR_PATH]: 0.08,
  [SignalType.ERROR_RATE]: 0.1,
  [SignalType.READING_SPEED]: 0.08,
  [SignalType.HESITATION]: 0.07,
};

/** Stable feature-vector ordering for the ONNX classifier input.
 *  Don't reorder without bumping the classifier model version. */
export const SIGNAL_FEATURE_ORDER: readonly SignalType[] = [
  SignalType.SCROLL_VELOCITY,
  SignalType.CLICK_ACCURACY,
  SignalType.DWELL_TIME,
  SignalType.TYPING_RHYTHM,
  SignalType.BACKSPACE_RATE,
  SignalType.ZOOM_EVENTS,
  SignalType.CURSOR_PATH,
  SignalType.ERROR_RATE,
  SignalType.READING_SPEED,
  SignalType.HESITATION,
];

/** Number of rolling statistics emitted per signal type. */
export const STATS_PER_SIGNAL = 6;

/** Total feature dimension (must match the ONNX classifier input). */
export const FEATURE_DIM = SIGNAL_FEATURE_ORDER.length * STATS_PER_SIGNAL;

/** Sliding window duration in milliseconds (60 seconds) */
const WINDOW_DURATION_MS = 60_000;

/** Minimum number of signals needed for a confident score */
const MIN_SIGNALS_FOR_CONFIDENCE = 5;

/** Classifier confidence threshold above which we blend into the heuristic. */
export const CLASSIFIER_BLEND_THRESHOLD = 0.7;

/** Blend weights when the classifier is trusted. */
export const CLASSIFIER_BLEND_WEIGHT = 0.6;
export const HEURISTIC_BLEND_WEIGHT = 0.4;

export interface StruggleClassifierLike {
  predict(
    features: Float32Array,
  ): Promise<{ score: number; confidence: number } | null>;
}

function defaultBaseline(): UserBaseline {
  const baselines = new Map<SignalType, SignalBaseline>();
  for (const type of Object.values(SignalType)) {
    baselines.set(type, { mean: 0.5, stddev: 0.2, sampleCount: 0 });
  }
  return { signalBaselines: baselines, lastUpdated: Date.now() };
}

export class StruggleDetector {
  private signals: BehaviorSignal[] = [];
  private baseline: UserBaseline;
  private classifier: StruggleClassifierLike | null;

  constructor(
    baseline?: UserBaseline,
    classifier?: StruggleClassifierLike | null,
  ) {
    this.baseline = baseline ?? defaultBaseline();
    this.classifier = classifier ?? null;
  }

  /** Swap in / out a classifier without re-instantiating. */
  setClassifier(classifier: StruggleClassifierLike | null): void {
    this.classifier = classifier;
  }

  hasClassifier(): boolean {
    return this.classifier !== null;
  }

  addSignal(signal: BehaviorSignal): void {
    this.signals.push(signal);
    this.pruneOldSignals();
  }

  getStruggleScore(): StruggleScore {
    this.pruneOldSignals();

    const now = Date.now();

    if (this.signals.length === 0) {
      return { score: 0, confidence: 0, signals: [], timestamp: now };
    }

    let weightedSum = 0;
    let totalWeight = 0;
    const signalTypesSeen = new Set<SignalType>();

    for (const signal of this.signals) {
      const weight = SIGNAL_WEIGHTS[signal.type];
      const baseline = this.baseline.signalBaselines.get(signal.type);

      if (!baseline) continue;

      signalTypesSeen.add(signal.type);

      // Calculate deviation from baseline: how far the normalized value
      // deviates from the baseline mean, scaled by stddev
      const stddev = baseline.stddev > 0 ? baseline.stddev : 0.2;
      const deviation = Math.abs(signal.normalized - baseline.mean) / stddev;

      // Clamp deviation to [0, 3] range then scale to [0, 1]
      const clampedDeviation = Math.min(deviation, 3) / 3;

      weightedSum += clampedDeviation * weight;
      totalWeight += weight;
    }

    const rawScore = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 0;
    const score = Math.min(100, Math.max(0, rawScore));

    // Confidence is based on how many distinct signal types we have
    // and how many total signals are in the window
    const typeRatio = signalTypesSeen.size / Object.values(SignalType).length;
    const countRatio = Math.min(
      this.signals.length / MIN_SIGNALS_FOR_CONFIDENCE,
      1,
    );
    const confidence = Math.min(1, typeRatio * 0.6 + countRatio * 0.4);

    return {
      score: Math.round(score * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      signals: [...this.signals],
      timestamp: now,
    };
  }

  /**
   * Async scoring path that consults the ONNX classifier when available.
   *
   * Behavior:
   *   - Always compute the heuristic score (identical to getStruggleScore).
   *   - If a classifier is set, call predict(featurize()).
   *   - When the classifier returns a result whose confidence > 0.7,
   *     blend: final = 0.6 * classifier.score + 0.4 * heuristic.score.
   *   - Any classifier error / null return falls back to heuristic-only.
   */
  async getStruggleScoreAsync(): Promise<StruggleScore> {
    const heuristic = this.getStruggleScore();
    if (!this.classifier) return heuristic;

    let prediction: { score: number; confidence: number } | null = null;
    try {
      prediction = await this.classifier.predict(this.featurize());
    } catch {
      prediction = null;
    }

    if (!prediction || prediction.confidence <= CLASSIFIER_BLEND_THRESHOLD) {
      return heuristic;
    }

    const blended =
      CLASSIFIER_BLEND_WEIGHT * prediction.score +
      HEURISTIC_BLEND_WEIGHT * heuristic.score;

    const boostedConfidence = Math.min(
      1,
      Math.max(heuristic.confidence, prediction.confidence),
    );

    return {
      score: Math.round(Math.min(100, Math.max(0, blended)) * 100) / 100,
      confidence: Math.round(boostedConfidence * 100) / 100,
      signals: heuristic.signals,
      timestamp: heuristic.timestamp,
    };
  }

  /**
   * Produce the 60-dim Float32Array the ONNX struggle classifier expects.
   *
   * Layout: for each signal in SIGNAL_FEATURE_ORDER, emit six stats over
   * the current sliding window (values already normalized 0-1):
   *   [ current, mean, stddev, min, max, trend ]
   *
   * "current" is the most recent sample (0 if absent); "trend" is the
   * normalised slope of the values vs. their per-signal index (in [-1, 1]).
   */
  featurize(): Float32Array {
    this.pruneOldSignals();
    const out = new Float32Array(FEATURE_DIM);
    const buckets = new Map<SignalType, BehaviorSignal[]>();
    for (const s of this.signals) {
      const arr = buckets.get(s.type);
      if (arr) arr.push(s);
      else buckets.set(s.type, [s]);
    }

    for (let i = 0; i < SIGNAL_FEATURE_ORDER.length; i++) {
      const type = SIGNAL_FEATURE_ORDER[i];
      const samples = buckets.get(type);
      const base = i * STATS_PER_SIGNAL;
      if (!samples || samples.length === 0) {
        // Leave the six stats at 0 for "no data in window".
        continue;
      }

      const n = samples.length;
      let min = 1;
      let max = 0;
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const v = clamp01(samples[j].normalized);
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const mean = sum / n;
      let variance = 0;
      for (let j = 0; j < n; j++) {
        const v = clamp01(samples[j].normalized);
        variance += (v - mean) * (v - mean);
      }
      const stddev = Math.sqrt(variance / n);
      const current = clamp01(samples[n - 1].normalized);
      const trend = n > 1 ? clampSigned(slope(samples) * (n - 1)) : 0;

      out[base + 0] = current;
      out[base + 1] = mean;
      out[base + 2] = stddev;
      out[base + 3] = min;
      out[base + 4] = max;
      out[base + 5] = trend;
    }

    return out;
  }

  updateBaseline(): void {
    this.pruneOldSignals();

    const grouped = new Map<SignalType, number[]>();

    for (const signal of this.signals) {
      const values = grouped.get(signal.type) ?? [];
      values.push(signal.normalized);
      grouped.set(signal.type, values);
    }

    for (const [type, values] of grouped) {
      if (values.length < 2) continue;

      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance =
        values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
      const stddev = Math.sqrt(variance);

      const existing = this.baseline.signalBaselines.get(type);
      const prevCount = existing?.sampleCount ?? 0;
      const newCount = prevCount + values.length;

      // Exponential moving average to blend old and new baselines
      const alpha = Math.min(values.length / newCount, 0.3);
      const blendedMean = existing
        ? existing.mean * (1 - alpha) + mean * alpha
        : mean;
      const blendedStddev = existing
        ? existing.stddev * (1 - alpha) + stddev * alpha
        : stddev;

      this.baseline.signalBaselines.set(type, {
        mean: blendedMean,
        stddev: Math.max(blendedStddev, 0.05),
        sampleCount: newCount,
      });
    }

    this.baseline.lastUpdated = Date.now();
  }

  reset(): void {
    this.signals = [];
  }

  getBaseline(): UserBaseline {
    return this.baseline;
  }

  private pruneOldSignals(): void {
    const cutoff = Date.now() - WINDOW_DURATION_MS;
    this.signals = this.signals.filter((s) => s.timestamp >= cutoff);
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampSigned(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < -1) return -1;
  if (v > 1) return 1;
  return v;
}

/**
 * Simple least-squares slope of (index, normalized) pairs, then scaled
 * by the window length so the result roughly represents "how much did
 * this signal change end-to-end" in [-1, 1].
 */
function slope(samples: BehaviorSignal[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = clamp01(samples[i].normalized);
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
