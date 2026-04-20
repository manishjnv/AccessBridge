import type {
  EnvironmentSnapshot,
  LightingCondition,
  NetworkQuality,
  NoiseEnvironment,
  TimeOfDay,
} from '../types/signals.js';

/**
 * Average luminance of RGBA pixels, normalized to 0-1.
 * Uses Rec. 709 luma weights (0.2126 R + 0.7152 G + 0.0722 B) for perceptual accuracy.
 * Works on any ImageData buffer regardless of resolution; returns 0 for empty.
 */
export function calculateBrightness(imageData: { data: ArrayLike<number>; width: number; height: number }): number {
  const { data } = imageData;
  if (!data || data.length < 4) return 0;

  let sum = 0;
  let pixelCount = 0;
  // RGBA, stride 4. Ignore alpha.
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    pixelCount++;
  }
  if (pixelCount === 0) return 0;
  const avg = sum / pixelCount;
  return Math.max(0, Math.min(1, avg / 255));
}

/**
 * Root-mean-square of normalized audio samples, clamped to 0-1.
 * Input samples should be Web Audio-style Float32 in the range [-1, 1].
 * Returns 0 for empty buffer. Accepts any indexable number sequence so callers
 * can pass Float32Array variants without generic-parameter friction.
 */
export function calculateNoiseLevel(audioBuffer: ArrayLike<number>): number {
  if (!audioBuffer || audioBuffer.length === 0) return 0;

  let sumSquares = 0;
  const n = audioBuffer.length;
  for (let i = 0; i < n; i++) {
    const s = audioBuffer[i];
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / n);
  // Typical ambient room RMS sits around 0.02-0.1; scale so that RMS ≥ 0.3 reads as "very noisy".
  const scaled = rms / 0.3;
  return Math.max(0, Math.min(1, scaled));
}

/**
 * Maps normalized brightness 0-1 to a qualitative lighting bucket.
 * Boundaries: <0.2 dark, <0.5 dim, <0.8 normal, ≥0.8 bright.
 */
export function inferLightingCondition(brightness: number): LightingCondition {
  if (brightness < 0.2) return 'dark';
  if (brightness < 0.5) return 'dim';
  if (brightness < 0.8) return 'normal';
  return 'bright';
}

/**
 * Maps normalized noise level 0-1 to a qualitative noise bucket.
 * Boundaries: <0.2 quiet, <0.5 moderate, <0.8 noisy, ≥0.8 very_noisy.
 */
export function inferNoiseEnvironment(noiseLevel: number): NoiseEnvironment {
  if (noiseLevel < 0.2) return 'quiet';
  if (noiseLevel < 0.5) return 'moderate';
  if (noiseLevel < 0.8) return 'noisy';
  return 'very_noisy';
}

/** 05-11 morning, 12-16 afternoon, 17-20 evening, else night. */
export function inferTimeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

/**
 * Adaptation hints derived from the current environment snapshot.
 * - suggestedContrast: 1.0 at normal light; ramps up to 1.8 in a dark room, down to 0.9 in bright light.
 * - suggestedFontScale: 1.0 at normal light; 1.15 in dim; 1.0 in bright; late-evening nudge.
 * - voiceReliability: 1.0 in a quiet room, drops toward 0.1 as noise rises.
 */
export function computeEnvironmentalAdaptationHints(snapshot: EnvironmentSnapshot): {
  suggestedContrast: number;
  suggestedFontScale: number;
  voiceReliability: number;
} {
  const light = snapshot.lightLevel;
  const noise = snapshot.noiseLevel;

  let suggestedContrast = 1.0;
  let suggestedFontScale = 1.0;
  if (light !== null) {
    const cond = inferLightingCondition(light);
    if (cond === 'dark') {
      suggestedContrast = 1.8;
      suggestedFontScale = 1.15;
    } else if (cond === 'dim') {
      suggestedContrast = 1.3;
      suggestedFontScale = 1.1;
    } else if (cond === 'bright') {
      suggestedContrast = 0.9;
    }
  }

  // Late evening / night → bias fatigue detection via a small contrast/font nudge.
  if (snapshot.timeOfDay === 'night') {
    suggestedFontScale = Math.max(suggestedFontScale, 1.1);
    suggestedContrast = Math.max(suggestedContrast, 1.2);
  }

  let voiceReliability = 1.0;
  if (noise !== null) {
    // Linear drop: 0 noise → 1.0; 1.0 noise → 0.1.
    voiceReliability = Math.max(0.1, 1 - 0.9 * noise);
  }
  if (snapshot.networkQuality === 'poor') {
    // Cloud STT degrades on a poor link — clip voice reliability.
    voiceReliability = Math.min(voiceReliability, 0.4);
  } else if (snapshot.networkQuality === 'fair') {
    voiceReliability = Math.min(voiceReliability, 0.7);
  }

  return { suggestedContrast, suggestedFontScale, voiceReliability };
}

/** Maps navigator.connection.effectiveType to our quality bucket. */
export function inferNetworkQualityFromEffectiveType(
  effectiveType: string | undefined,
  downlinkMbps?: number,
): NetworkQuality {
  if (effectiveType === '4g') {
    if (downlinkMbps !== undefined && downlinkMbps >= 10) return 'excellent';
    return 'good';
  }
  if (effectiveType === '3g') return 'fair';
  if (effectiveType === '2g' || effectiveType === 'slow-2g') return 'poor';
  // Unknown / offline — assume fair so adaptation doesn't over-react.
  return 'fair';
}
