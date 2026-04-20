import { describe, it, expect } from 'vitest';
import {
  calculateBrightness,
  calculateNoiseLevel,
  inferLightingCondition,
  inferNoiseEnvironment,
  inferTimeOfDay,
  inferNetworkQualityFromEffectiveType,
  computeEnvironmentalAdaptationHints,
} from '../signals/environment.js';
import type { EnvironmentSnapshot } from '../types/signals.js';

function makeImage(w: number, h: number, filler: (i: number) => [number, number, number, number]): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const [r, g, b, a] = filler(p);
    data[p * 4] = r;
    data[p * 4 + 1] = g;
    data[p * 4 + 2] = b;
    data[p * 4 + 3] = a;
  }
  return { data, width: w, height: h };
}

describe('calculateBrightness', () => {
  it('returns 0 for pure black image', () => {
    const img = makeImage(4, 4, () => [0, 0, 0, 255]);
    expect(calculateBrightness(img)).toBe(0);
  });

  it('returns 1 for pure white image', () => {
    const img = makeImage(4, 4, () => [255, 255, 255, 255]);
    expect(calculateBrightness(img)).toBeCloseTo(1, 10);
  });

  it('returns ~0.5 for midtone image', () => {
    const img = makeImage(4, 4, () => [128, 128, 128, 255]);
    const b = calculateBrightness(img);
    expect(b).toBeGreaterThan(0.49);
    expect(b).toBeLessThan(0.52);
  });

  it('ignores alpha channel (same RGB regardless of alpha)', () => {
    const fullA = makeImage(4, 4, () => [200, 200, 200, 255]);
    const lowA = makeImage(4, 4, () => [200, 200, 200, 10]);
    expect(calculateBrightness(fullA)).toBe(calculateBrightness(lowA));
  });

  it('returns value in [0,1] for all inputs', () => {
    const imgs = [
      makeImage(2, 2, () => [0, 0, 0, 255]),
      makeImage(2, 2, () => [50, 100, 200, 255]),
      makeImage(2, 2, () => [255, 0, 0, 255]),
      makeImage(2, 2, () => [255, 255, 255, 0]),
    ];
    for (const img of imgs) {
      const b = calculateBrightness(img);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });

  it('returns 0 for empty data buffer', () => {
    expect(calculateBrightness({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBe(0);
  });

  it('weights green higher than red and blue (Rec. 709)', () => {
    const greenOnly = makeImage(4, 4, () => [0, 255, 0, 255]);
    const redOnly = makeImage(4, 4, () => [255, 0, 0, 255]);
    const blueOnly = makeImage(4, 4, () => [0, 0, 255, 255]);
    const g = calculateBrightness(greenOnly);
    const r = calculateBrightness(redOnly);
    const b = calculateBrightness(blueOnly);
    expect(g).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(b);
  });
});

describe('calculateNoiseLevel', () => {
  it('returns 0 for silence (all-zero buffer)', () => {
    expect(calculateNoiseLevel(new Float32Array(256))).toBe(0);
  });

  it('returns 0 for empty buffer', () => {
    expect(calculateNoiseLevel(new Float32Array(0))).toBe(0);
  });

  it('returns a small nonzero value for low-amplitude noise', () => {
    const buf = new Float32Array(1024);
    for (let i = 0; i < buf.length; i++) buf[i] = 0.03 * (i % 2 === 0 ? 1 : -1);
    const v = calculateNoiseLevel(buf);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.3);
  });

  it('clamps to 1.0 for very loud input', () => {
    const buf = new Float32Array(1024);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? 0.95 : -0.95;
    expect(calculateNoiseLevel(buf)).toBe(1);
  });

  it('accepts number[] arrays as well as Float32Array', () => {
    const a = calculateNoiseLevel([0.1, -0.1, 0.1, -0.1]);
    const b = calculateNoiseLevel(new Float32Array([0.1, -0.1, 0.1, -0.1]));
    expect(a).toBeCloseTo(b, 6);
  });

  it('returns value in [0,1] always', () => {
    const samples = [
      new Float32Array([0]),
      new Float32Array([0.5]),
      new Float32Array(100).fill(0.9),
    ];
    for (const s of samples) {
      const v = calculateNoiseLevel(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('inferLightingCondition', () => {
  it('classifies 0 as dark', () => {
    expect(inferLightingCondition(0)).toBe('dark');
  });

  it('classifies 0.15 as dark, 0.2 as dim (boundary inclusive on the upper side)', () => {
    expect(inferLightingCondition(0.15)).toBe('dark');
    expect(inferLightingCondition(0.2)).toBe('dim');
  });

  it('classifies 0.3 as dim, 0.5 as normal', () => {
    expect(inferLightingCondition(0.3)).toBe('dim');
    expect(inferLightingCondition(0.5)).toBe('normal');
  });

  it('classifies 0.7 as normal, 0.8 as bright', () => {
    expect(inferLightingCondition(0.7)).toBe('normal');
    expect(inferLightingCondition(0.8)).toBe('bright');
  });

  it('classifies 1.0 as bright', () => {
    expect(inferLightingCondition(1.0)).toBe('bright');
  });
});

describe('inferNoiseEnvironment', () => {
  it('classifies 0 as quiet', () => {
    expect(inferNoiseEnvironment(0)).toBe('quiet');
  });

  it('classifies 0.2 as moderate (boundary)', () => {
    expect(inferNoiseEnvironment(0.15)).toBe('quiet');
    expect(inferNoiseEnvironment(0.2)).toBe('moderate');
  });

  it('classifies 0.3 as moderate, 0.5 as noisy', () => {
    expect(inferNoiseEnvironment(0.3)).toBe('moderate');
    expect(inferNoiseEnvironment(0.5)).toBe('noisy');
  });

  it('classifies 0.7 as noisy, 0.8 as very_noisy', () => {
    expect(inferNoiseEnvironment(0.7)).toBe('noisy');
    expect(inferNoiseEnvironment(0.8)).toBe('very_noisy');
  });
});

describe('inferTimeOfDay', () => {
  it('maps 8 to morning, 14 to afternoon', () => {
    expect(inferTimeOfDay(8)).toBe('morning');
    expect(inferTimeOfDay(14)).toBe('afternoon');
  });

  it('maps 19 to evening, 23 to night, 3 to night', () => {
    expect(inferTimeOfDay(19)).toBe('evening');
    expect(inferTimeOfDay(23)).toBe('night');
    expect(inferTimeOfDay(3)).toBe('night');
  });
});

describe('inferNetworkQualityFromEffectiveType', () => {
  it('maps 4g + high downlink to excellent', () => {
    expect(inferNetworkQualityFromEffectiveType('4g', 15)).toBe('excellent');
  });

  it('maps 4g + moderate downlink to good', () => {
    expect(inferNetworkQualityFromEffectiveType('4g', 5)).toBe('good');
    expect(inferNetworkQualityFromEffectiveType('4g')).toBe('good');
  });

  it('maps 3g to fair, 2g to poor, slow-2g to poor', () => {
    expect(inferNetworkQualityFromEffectiveType('3g')).toBe('fair');
    expect(inferNetworkQualityFromEffectiveType('2g')).toBe('poor');
    expect(inferNetworkQualityFromEffectiveType('slow-2g')).toBe('poor');
  });

  it('maps unknown/undefined to fair (safe default)', () => {
    expect(inferNetworkQualityFromEffectiveType(undefined)).toBe('fair');
    expect(inferNetworkQualityFromEffectiveType('bluetooth')).toBe('fair');
  });
});

describe('computeEnvironmentalAdaptationHints', () => {
  function snap(overrides: Partial<EnvironmentSnapshot>): EnvironmentSnapshot {
    return {
      lightLevel: 0.5,
      noiseLevel: 0.1,
      networkQuality: 'good',
      timeOfDay: 'afternoon',
      sampledAt: Date.now(),
      ...overrides,
    };
  }

  it('dark room → high contrast + larger font, high voice reliability when quiet', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ lightLevel: 0.1, noiseLevel: 0.05 }));
    expect(h.suggestedContrast).toBeCloseTo(1.8, 5);
    expect(h.suggestedFontScale).toBeCloseTo(1.15, 5);
    expect(h.voiceReliability).toBeGreaterThan(0.9);
  });

  it('bright room → reduced contrast', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ lightLevel: 0.9 }));
    expect(h.suggestedContrast).toBeCloseTo(0.9, 5);
    expect(h.suggestedFontScale).toBe(1.0);
  });

  it('noisy environment drops voice reliability sharply', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ noiseLevel: 0.9 }));
    expect(h.voiceReliability).toBeLessThan(0.25);
  });

  it('quiet environment keeps voice reliability at 1.0', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ noiseLevel: 0 }));
    expect(h.voiceReliability).toBe(1);
  });

  it('night timeOfDay nudges font and contrast up', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ lightLevel: 0.6, timeOfDay: 'night' }));
    expect(h.suggestedFontScale).toBeGreaterThanOrEqual(1.1);
    expect(h.suggestedContrast).toBeGreaterThanOrEqual(1.2);
  });

  it('poor network caps voice reliability at 0.4', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ noiseLevel: 0, networkQuality: 'poor' }));
    expect(h.voiceReliability).toBeLessThanOrEqual(0.4);
  });

  it('fair network caps voice reliability at 0.7', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ noiseLevel: 0, networkQuality: 'fair' }));
    expect(h.voiceReliability).toBeLessThanOrEqual(0.7);
  });

  it('null lightLevel → neutral contrast and font scale', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ lightLevel: null }));
    expect(h.suggestedContrast).toBe(1);
    expect(h.suggestedFontScale).toBe(1);
  });

  it('null noiseLevel → perfect voice reliability', () => {
    const h = computeEnvironmentalAdaptationHints(snap({ noiseLevel: null }));
    expect(h.voiceReliability).toBe(1);
  });

  it('combined dark + noisy + night → bumpy contrast, cautious voice', () => {
    const h = computeEnvironmentalAdaptationHints(
      snap({ lightLevel: 0.1, noiseLevel: 0.8, timeOfDay: 'night', networkQuality: 'fair' }),
    );
    expect(h.suggestedContrast).toBeGreaterThanOrEqual(1.8);
    expect(h.suggestedFontScale).toBeGreaterThanOrEqual(1.15);
    expect(h.voiceReliability).toBeLessThanOrEqual(0.4);
  });
});
