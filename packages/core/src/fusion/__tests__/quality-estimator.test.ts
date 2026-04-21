import { describe, it, expect } from 'vitest';
import { estimateChannelQuality } from '../quality-estimator.js';
import type { UnifiedEvent, EnvironmentConditions, InputChannel } from '../types.js';

// ─── Test helper ───────────────────────────────────────────────────────────────
let counter = 0;
function makeEvent(
  channel: InputChannel,
  type: string,
  data: Record<string, unknown>,
  t: number,
): UnifiedEvent {
  return { id: `e-${++counter}`, t, channel, type, data, quality: 0.5 };
}

const defaultEnv: EnvironmentConditions = {
  lighting: 'bright',
  noise: 'quiet',
  network: 'good',
  timeOfDay: 'day',
};

// ─── Empty events → zero result ────────────────────────────────────────────────
describe('empty events', () => {
  const channels: InputChannel[] = ['voice', 'gaze', 'keyboard', 'mouse', 'pointer', 'env-light'];
  for (const ch of channels) {
    it(`${ch}: returns zero quality when no events`, () => {
      const result = estimateChannelQuality(ch, [], defaultEnv);
      expect(result).toEqual({ channel: ch, confidence: 0, noise: 1, sampleRate: 0, lastSampledAt: 0 });
    });
  }
});

// ─── Voice ─────────────────────────────────────────────────────────────────────
describe('voice channel', () => {
  it('single event snr=0.8 transcriptConfidence=0.9, quiet → confidence ≈ 0.85', () => {
    const events = [makeEvent('voice', 'final', { snr: 0.8, transcriptConfidence: 0.9 }, 1000)];
    const result = estimateChannelQuality('voice', events, { ...defaultEnv, noise: 'quiet' });
    expect(result.confidence).toBeCloseTo(0.85, 5);
    expect(result.noise).toBeCloseTo(0.15, 5);
  });

  it('noisy env → confidence halved from quiet baseline', () => {
    const events = [makeEvent('voice', 'final', { snr: 0.8, transcriptConfidence: 0.9 }, 1000)];
    const quiet = estimateChannelQuality('voice', events, { ...defaultEnv, noise: 'quiet' });
    const noisy = estimateChannelQuality('voice', events, { ...defaultEnv, noise: 'noisy' });
    // noisy penalty = 0.4, quiet = 1.0, so ratio is 0.4
    expect(noisy.confidence).toBeCloseTo(quiet.confidence * 0.4, 5);
  });

  it('loud env → confidence at 0.4× quiet baseline', () => {
    const events = [makeEvent('voice', 'final', { snr: 0.8, transcriptConfidence: 0.9 }, 1000)];
    const quiet = estimateChannelQuality('voice', events, { ...defaultEnv, noise: 'quiet' });
    const loud = estimateChannelQuality('voice', events, { ...defaultEnv, noise: 'loud' });
    expect(loud.confidence).toBeCloseTo(quiet.confidence * 0.4, 5);
  });

  it('confidence + noise = 1', () => {
    const events = [makeEvent('voice', 'final', { snr: 0.6, transcriptConfidence: 0.7 }, 500)];
    const result = estimateChannelQuality('voice', events, defaultEnv);
    expect(result.confidence + result.noise).toBeCloseTo(1, 10);
  });
});

// ─── Gaze ──────────────────────────────────────────────────────────────────────
describe('gaze channel', () => {
  it('brightness=0.8, faceDetected, blinkRate=0.3, bright → confidence > 0.7', () => {
    const events = [
      makeEvent('gaze', 'sample', { brightness: 0.8, faceDetected: true, blinkRate: 0.3 }, 1000),
    ];
    const result = estimateChannelQuality('gaze', events, { ...defaultEnv, lighting: 'bright' });
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('dark lighting → confidence ≤ 0.5× bright-lighting confidence', () => {
    const eventData = { brightness: 0.8, faceDetected: true, blinkRate: 0.3 };
    const bright = estimateChannelQuality(
      'gaze',
      [makeEvent('gaze', 'sample', eventData, 1000)],
      { ...defaultEnv, lighting: 'bright' },
    );
    const dark = estimateChannelQuality(
      'gaze',
      [makeEvent('gaze', 'sample', eventData, 2000)],
      { ...defaultEnv, lighting: 'dark' },
    );
    expect(dark.confidence).toBeLessThanOrEqual(bright.confidence * 0.5 + 1e-9);
  });

  it('high blink rate (0.8/sec) → reduced blinkStability', () => {
    const highBlink = [makeEvent('gaze', 'sample', { brightness: 0.8, faceDetected: true, blinkRate: 0.8 }, 1000)];
    const normalBlink = [makeEvent('gaze', 'sample', { brightness: 0.8, faceDetected: true, blinkRate: 0.3 }, 2000)];
    const high = estimateChannelQuality('gaze', highBlink, defaultEnv);
    const normal = estimateChannelQuality('gaze', normalBlink, defaultEnv);
    expect(high.confidence).toBeLessThan(normal.confidence);
  });

  it('normal blink rate (0.25) → blinkStability ≈ 1', () => {
    const events = [
      makeEvent('gaze', 'sample', { brightness: 1.0, faceDetected: true, blinkRate: 0.25 }, 1000),
    ];
    const result = estimateChannelQuality('gaze', events, { ...defaultEnv, lighting: 'bright' });
    // blinkStability=1, brightness=1, faceRatio=1, lightingPenalty=1 → confidence=1
    expect(result.confidence).toBeCloseTo(1.0, 5);
  });
});

// ─── Keyboard ──────────────────────────────────────────────────────────────────
describe('keyboard channel', () => {
  it('10 evenly spaced events, no backspace → high confidence', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent('keyboard', 'keydown', { key: 'a' }, i * 100),
    );
    const result = estimateChannelQuality('keyboard', events, defaultEnv);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('5 backspace out of 10 → confidence reduced (0.5 max penalty)', () => {
    const eventsNormal = Array.from({ length: 10 }, (_, i) =>
      makeEvent('keyboard', 'keydown', { key: 'a' }, i * 100),
    );
    const eventsWithBackspace = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeEvent('keyboard', 'keydown', { key: 'a' }, i * 100),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeEvent('keyboard', 'keydown', { key: 'Backspace' }, (5 + i) * 100),
      ),
    ];
    const normal = estimateChannelQuality('keyboard', eventsNormal, defaultEnv);
    const withBackspace = estimateChannelQuality('keyboard', eventsWithBackspace, defaultEnv);
    expect(withBackspace.confidence).toBeLessThan(normal.confidence);
    // With ratio=0.5, penalty is clamped at 0.5: confidence = rateConsistency * 0.5
    expect(withBackspace.confidence).toBeCloseTo(normal.confidence * 0.5, 5);
  });
});

// ─── Mouse ─────────────────────────────────────────────────────────────────────
describe('mouse channel', () => {
  it('data.smoothness=0.9 → confidence ≈ 0.9', () => {
    const events = [
      makeEvent('mouse', 'mousemove', { smoothness: 0.9 }, 1000),
      makeEvent('mouse', 'mousemove', { smoothness: 0.9 }, 1100),
    ];
    const result = estimateChannelQuality('mouse', events, defaultEnv);
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('erratic deltas (high variance) → confidence < 0.5', () => {
    // velocities alternate wildly: 1 and 100
    const events = [
      makeEvent('mouse', 'mousemove', { velocityX: 1, velocityY: 0 }, 1000),
      makeEvent('mouse', 'mousemove', { velocityX: 100, velocityY: 0 }, 1100),
      makeEvent('mouse', 'mousemove', { velocityX: 1, velocityY: 0 }, 1200),
      makeEvent('mouse', 'mousemove', { velocityX: 100, velocityY: 0 }, 1300),
    ];
    const result = estimateChannelQuality('mouse', events, defaultEnv);
    expect(result.confidence).toBeLessThan(0.5);
  });
});

// ─── Pointer/Touch ─────────────────────────────────────────────────────────────
describe('pointer channel', () => {
  it('gestureConfidence=0.85 → confidence=0.85', () => {
    const events = [makeEvent('pointer', 'tap', { gestureConfidence: 0.85 }, 1000)];
    const result = estimateChannelQuality('pointer', events, defaultEnv);
    expect(result.confidence).toBeCloseTo(0.85, 5);
  });

  it('no gestureConfidence → confidence=0.7', () => {
    const events = [makeEvent('pointer', 'tap', {}, 1000)];
    const result = estimateChannelQuality('pointer', events, defaultEnv);
    expect(result.confidence).toBeCloseTo(0.7, 5);
  });
});

// ─── env-light passthrough ─────────────────────────────────────────────────────
describe('env-light passthrough', () => {
  it('data.value=0.3 → confidence=0.3', () => {
    const events = [makeEvent('env-light', 'reading', { value: 0.3 }, 1000)];
    const result = estimateChannelQuality('env-light', events, defaultEnv);
    expect(result.confidence).toBeCloseTo(0.3, 5);
    expect(result.noise).toBeCloseTo(0.7, 5);
  });
});

// ─── sampleRate ────────────────────────────────────────────────────────────────
describe('sampleRate', () => {
  it('50 events in 1000ms span → sampleRate ≈ 50', () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent('keyboard', 'keydown', { key: 'a' }, i * 20), // 0 to 980ms
    );
    const result = estimateChannelQuality('keyboard', events, defaultEnv);
    // span = 980ms → 0.98s; sampleRate = 50/max(1, 0.98) ≈ 51.02
    // But spec says: if only 1 event, span=1. For 50 events, span=980ms.
    // sampleRate = 50 / (980/1000) = 50/0.98 ≈ 51.02
    expect(result.sampleRate).toBeGreaterThan(40);
    expect(result.sampleRate).toBeLessThan(60);
  });

  it('5 events at t=0 to t=100 (100ms span) → sampleRate ≈ 50', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent('keyboard', 'keydown', { key: 'a' }, i * 25), // 0, 25, 50, 75, 100
    );
    const result = estimateChannelQuality('keyboard', events, defaultEnv);
    // span=100ms=0.1s; sampleRate=5/max(1,0.1)=5/0.1=50
    expect(result.sampleRate).toBeCloseTo(50, 0);
  });
});

// ─── Filter: wrong channel events ──────────────────────────────────────────────
describe('channel filtering', () => {
  it('estimateChannelQuality("voice", [gaze events only], env) → confidence=0', () => {
    const events = [
      makeEvent('gaze', 'sample', { brightness: 0.8 }, 1000),
      makeEvent('gaze', 'sample', { brightness: 0.9 }, 2000),
    ];
    const result = estimateChannelQuality('voice', events, defaultEnv);
    expect(result).toEqual({ channel: 'voice', confidence: 0, noise: 1, sampleRate: 0, lastSampledAt: 0 });
  });
});

// ─── lastSampledAt ─────────────────────────────────────────────────────────────
describe('lastSampledAt', () => {
  it('returns max(event.t)', () => {
    const events = [
      makeEvent('keyboard', 'keydown', { key: 'a' }, 500),
      makeEvent('keyboard', 'keydown', { key: 'b' }, 1500),
      makeEvent('keyboard', 'keydown', { key: 'c' }, 1000),
    ];
    const result = estimateChannelQuality('keyboard', events, defaultEnv);
    expect(result.lastSampledAt).toBe(1500);
  });
});

// ─── confidence and noise bounds ───────────────────────────────────────────────
describe('confidence/noise bounds', () => {
  it('confidence and noise always in [0,1] for extreme inputs', () => {
    const channels: InputChannel[] = ['voice', 'gaze', 'keyboard', 'mouse', 'pointer', 'env-light'];
    const extremeEnv: EnvironmentConditions = { lighting: 'dark', noise: 'loud', network: 'none', timeOfDay: 'night' };

    for (const ch of channels) {
      const events = [
        makeEvent(ch, 'test', { snr: 0, transcriptConfidence: 0, brightness: 0, faceDetected: false, blinkRate: 5, smoothness: 1.5, value: 2 }, 100),
      ];
      const result = estimateChannelQuality(ch, events, extremeEnv);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.noise).toBeGreaterThanOrEqual(0);
      expect(result.noise).toBeLessThanOrEqual(1);
    }
  });
});
