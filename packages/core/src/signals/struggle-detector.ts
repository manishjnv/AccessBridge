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

/** Sliding window duration in milliseconds (60 seconds) */
const WINDOW_DURATION_MS = 60_000;

/** Minimum number of signals needed for a confident score */
const MIN_SIGNALS_FOR_CONFIDENCE = 5;

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

  constructor(baseline?: UserBaseline) {
    this.baseline = baseline ?? defaultBaseline();
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
