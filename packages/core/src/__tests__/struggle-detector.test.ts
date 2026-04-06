import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StruggleDetector } from '../signals/struggle-detector.js';
import { SignalType } from '../types/signals.js';
import type { BehaviorSignal } from '../types/signals.js';

function makeSignal(
  type: SignalType,
  normalized: number,
  timestamp = Date.now(),
): BehaviorSignal {
  return { type, value: normalized, normalized, timestamp };
}

describe('StruggleDetector', () => {
  let detector: StruggleDetector;

  beforeEach(() => {
    detector = new StruggleDetector();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('empty state', () => {
    it('returns score 0 and confidence 0 when no signals have been added', () => {
      const result = detector.getStruggleScore();
      expect(result.score).toBe(0);
      expect(result.confidence).toBe(0);
      expect(result.signals).toHaveLength(0);
    });

    it('returns a timestamp even when there are no signals', () => {
      const before = Date.now();
      const result = detector.getStruggleScore();
      const after = Date.now();
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('adding signals and getting a score', () => {
    it('returns a non-zero score after adding a signal', () => {
      // A normalized value of 1.0 deviates far from the default baseline mean 0.5
      detector.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 1.0));
      const result = detector.getStruggleScore();
      expect(result.score).toBeGreaterThan(0);
    });

    it('includes the added signal in the returned signals array', () => {
      const signal = makeSignal(SignalType.TYPING_RHYTHM, 0.8);
      detector.addSignal(signal);
      const result = detector.getStruggleScore();
      expect(result.signals).toHaveLength(1);
      expect(result.signals[0].type).toBe(SignalType.TYPING_RHYTHM);
    });

    it('score is within the [0, 100] range', () => {
      detector.addSignal(makeSignal(SignalType.ERROR_RATE, 1.0));
      detector.addSignal(makeSignal(SignalType.BACKSPACE_RATE, 1.0));
      detector.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.0));
      const result = detector.getStruggleScore();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('confidence is within the [0, 1] range', () => {
      for (const type of Object.values(SignalType)) {
        detector.addSignal(makeSignal(type, 0.9));
      }
      const result = detector.getStruggleScore();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('score increases with erratic (high-deviation) signals', () => {
    it('returns a higher score when signals deviate far from baseline', () => {
      // Calm signals close to baseline mean (0.5)
      const detectorCalm = new StruggleDetector();
      detectorCalm.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.5));
      detectorCalm.addSignal(makeSignal(SignalType.ERROR_RATE, 0.5));
      detectorCalm.addSignal(makeSignal(SignalType.TYPING_RHYTHM, 0.5));
      const calmScore = detectorCalm.getStruggleScore().score;

      // Erratic signals at extreme ends
      const detectorErratic = new StruggleDetector();
      detectorErratic.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.0));
      detectorErratic.addSignal(makeSignal(SignalType.ERROR_RATE, 1.0));
      detectorErratic.addSignal(makeSignal(SignalType.TYPING_RHYTHM, 0.0));
      const erraticScore = detectorErratic.getStruggleScore().score;

      expect(erraticScore).toBeGreaterThan(calmScore);
    });

    it('score increases as more high-deviation signals accumulate', () => {
      const d = new StruggleDetector();

      d.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.0));
      const scoreOne = d.getStruggleScore().score;

      d.addSignal(makeSignal(SignalType.ERROR_RATE, 1.0));
      const scoreTwo = d.getStruggleScore().score;

      // Adding another high-deviation signal should not decrease the score
      expect(scoreTwo).toBeGreaterThanOrEqual(scoreOne);
    });
  });

  describe('multiple signal types', () => {
    it('handles all SignalType values without throwing', () => {
      for (const type of Object.values(SignalType)) {
        expect(() =>
          detector.addSignal(makeSignal(type, Math.random())),
        ).not.toThrow();
      }
      expect(() => detector.getStruggleScore()).not.toThrow();
    });

    it('confidence grows as more distinct signal types are added', () => {
      const d1 = new StruggleDetector();
      d1.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.8));
      const conf1 = d1.getStruggleScore().confidence;

      const d2 = new StruggleDetector();
      d2.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.8));
      d2.addSignal(makeSignal(SignalType.ERROR_RATE, 0.8));
      d2.addSignal(makeSignal(SignalType.READING_SPEED, 0.8));
      const conf2 = d2.getStruggleScore().confidence;

      expect(conf2).toBeGreaterThan(conf1);
    });
  });

  describe('baseline updating', () => {
    it('updateBaseline does not throw', () => {
      detector.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.7));
      detector.addSignal(makeSignal(SignalType.CLICK_ACCURACY, 0.8));
      expect(() => detector.updateBaseline()).not.toThrow();
    });

    it('updateBaseline sets lastUpdated to a recent timestamp', () => {
      detector.addSignal(makeSignal(SignalType.ERROR_RATE, 0.6));
      detector.addSignal(makeSignal(SignalType.ERROR_RATE, 0.9));
      const before = Date.now();
      detector.updateBaseline();
      const baseline = detector.getBaseline();
      expect(baseline.lastUpdated).toBeGreaterThanOrEqual(before);
    });

    it('baseline mean shifts toward sample mean after update with two samples', () => {
      // Default mean is 0.5; feed two high-value samples so the blended mean moves up
      detector.addSignal(makeSignal(SignalType.TYPING_RHYTHM, 0.9));
      detector.addSignal(makeSignal(SignalType.TYPING_RHYTHM, 0.9));
      detector.updateBaseline();
      const baseline = detector.getBaseline();
      const bl = baseline.signalBaselines.get(SignalType.TYPING_RHYTHM);
      expect(bl).toBeDefined();
      // Mean should have moved from 0.5 toward 0.9
      expect(bl!.mean).toBeGreaterThan(0.5);
    });

    it('baseline sampleCount increases after update', () => {
      detector.addSignal(makeSignal(SignalType.SCROLL_VELOCITY, 0.3));
      detector.addSignal(makeSignal(SignalType.SCROLL_VELOCITY, 0.4));
      detector.updateBaseline();
      const bl = detector
        .getBaseline()
        .signalBaselines.get(SignalType.SCROLL_VELOCITY);
      expect(bl!.sampleCount).toBeGreaterThan(0);
    });

    it('updateBaseline requires at least 2 samples for a type to update that type', () => {
      detector.addSignal(makeSignal(SignalType.HESITATION, 0.9));
      const before = detector.getBaseline().signalBaselines.get(SignalType.HESITATION)!.mean;
      detector.updateBaseline(); // only 1 sample — should be skipped
      const after = detector.getBaseline().signalBaselines.get(SignalType.HESITATION)!.mean;
      expect(after).toBe(before);
    });
  });

  describe('signal windowing', () => {
    it('prunes signals older than the 60-second window', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Add a signal with a timestamp well outside the 60s window
      detector.addSignal(makeSignal(SignalType.CURSOR_PATH, 0.8, now - 70_000));

      const result = detector.getStruggleScore();
      expect(result.signals).toHaveLength(0);
      expect(result.score).toBe(0);
    });

    it('keeps signals within the 60-second window', () => {
      vi.useFakeTimers();
      const now = Date.now();

      detector.addSignal(makeSignal(SignalType.CURSOR_PATH, 0.8, now - 30_000));

      const result = detector.getStruggleScore();
      expect(result.signals).toHaveLength(1);
    });
  });

  describe('reset', () => {
    it('clears all signals after reset', () => {
      detector.addSignal(makeSignal(SignalType.DWELL_TIME, 0.7));
      detector.addSignal(makeSignal(SignalType.ZOOM_EVENTS, 0.6));
      detector.reset();
      const result = detector.getStruggleScore();
      expect(result.signals).toHaveLength(0);
      expect(result.score).toBe(0);
    });
  });
});
