import type { InputChannel, ChannelQuality, UnifiedEvent, EnvironmentConditions } from './types.js';

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeSampleRate(events: UnifiedEvent[]): { sampleRate: number; lastSampledAt: number } {
  if (events.length === 0) return { sampleRate: 0, lastSampledAt: 0 };
  const ts = events.map((e) => e.t);
  const minT = Math.min(...ts);
  const maxT = Math.max(...ts);
  const lastSampledAt = maxT;
  const spanMs = maxT - minT;
  const spanSec = Math.max(1, spanMs) / 1000;
  const sampleRate = events.length / spanSec;
  return { sampleRate, lastSampledAt };
}

function emptyResult(channel: InputChannel): ChannelQuality {
  return { channel, confidence: 0, noise: 1, sampleRate: 0, lastSampledAt: 0 };
}

function estimateVoice(
  events: UnifiedEvent[],
  envConditions: EnvironmentConditions,
): { confidence: number; noise: number } {
  const snrValues = events.map((e) => (typeof e.data['snr'] === 'number' ? (e.data['snr'] as number) : 0.5));
  const confValues = events.map((e) =>
    typeof e.data['transcriptConfidence'] === 'number' ? (e.data['transcriptConfidence'] as number) : 0.5,
  );
  const avgSnr = mean(snrValues);
  const avgTranscriptConf = mean(confValues);
  const rawConfidence = 0.5 * avgSnr + 0.5 * avgTranscriptConf;

  const noiseLevel = envConditions.noise;
  let noisePenalty: number;
  if (noiseLevel === 'quiet') {
    noisePenalty = 1.0;
  } else if (noiseLevel === 'moderate') {
    noisePenalty = 0.7;
  } else if (noiseLevel === 'loud' || noiseLevel === 'noisy') {
    noisePenalty = 0.4;
  } else {
    noisePenalty = 1.0;
  }

  const confidence = clamp(rawConfidence * noisePenalty);
  return { confidence, noise: 1 - confidence };
}

function estimateGaze(
  events: UnifiedEvent[],
  envConditions: EnvironmentConditions,
): { confidence: number; noise: number } {
  const brightnessValues = events.map((e) =>
    typeof e.data['brightness'] === 'number' ? (e.data['brightness'] as number) : 0.5,
  );
  const faceDetectedValues = events.map((e) =>
    typeof e.data['faceDetected'] === 'boolean' ? (e.data['faceDetected'] as boolean) : true,
  );
  const blinkRates = events.map((e) =>
    typeof e.data['blinkRate'] === 'number' ? (e.data['blinkRate'] as number) : 0.25,
  );

  const avgBrightness = mean(brightnessValues);
  const faceDetectionRatio = faceDetectedValues.filter(Boolean).length / events.length;

  const latestBlinkRate = blinkRates[blinkRates.length - 1] ?? 0.25;
  let blinkStability: number;
  if (latestBlinkRate >= 0.15 && latestBlinkRate <= 0.5) {
    blinkStability = 1;
  } else {
    blinkStability = Math.max(0.2, 1 - Math.abs(latestBlinkRate - 0.325) * 2);
  }

  const lighting = envConditions.lighting;
  let lightingPenalty: number;
  if (lighting === 'dark') {
    lightingPenalty = 0.5;
  } else if (lighting === 'dim') {
    lightingPenalty = 0.7;
  } else {
    lightingPenalty = 1.0;
  }

  const confidence = clamp(avgBrightness * faceDetectionRatio * blinkStability * lightingPenalty);
  return { confidence, noise: 1 - confidence };
}

function estimateKeyboard(events: UnifiedEvent[]): { confidence: number; noise: number } {
  const sortedTs = [...events.map((e) => e.t)].sort((a, b) => a - b);
  let rateConsistency: number;

  if (sortedTs.length < 2) {
    rateConsistency = 0.7;
  } else {
    const intervals: number[] = [];
    for (let i = 1; i < sortedTs.length; i++) {
      intervals.push(sortedTs[i]! - sortedTs[i - 1]!);
    }
    const m = mean(intervals);
    const s = stddev(intervals);
    rateConsistency = Math.max(0, 1 - (s / Math.max(m, 0.001)) / 2);
  }

  const total = events.length;
  const backspaceCount = events.filter(
    (e) => e.data['key'] === 'Backspace' || e.data['key'] === 'Delete',
  ).length;
  const errorBackspaceRatio = backspaceCount / total;

  const confidence = clamp(rateConsistency * (1 - Math.min(errorBackspaceRatio, 0.5)));
  return { confidence, noise: 1 - confidence };
}

function estimateMouse(events: UnifiedEvent[]): { confidence: number; noise: number } {
  if (events.length < 2) {
    return { confidence: 0.5, noise: 0.5 };
  }

  // Use data.smoothness if present on any event
  const firstWithSmoothness = events.find((e) => typeof e.data['smoothness'] === 'number');
  if (firstWithSmoothness !== undefined) {
    const s = firstWithSmoothness.data['smoothness'] as number;
    const confidence = clamp(s);
    return { confidence, noise: 1 - confidence };
  }

  // Compute from velocity vectors
  const magnitudes: number[] = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const curr = events[i]!;
    let mag: number;

    if (typeof curr.data['velocityX'] === 'number' && typeof curr.data['velocityY'] === 'number') {
      const vx = curr.data['velocityX'] as number;
      const vy = curr.data['velocityY'] as number;
      mag = Math.sqrt(vx * vx + vy * vy);
    } else if (typeof curr.data['dx'] === 'number' && typeof curr.data['dy'] === 'number') {
      const dx = curr.data['dx'] as number;
      const dy = curr.data['dy'] as number;
      mag = Math.sqrt(dx * dx + dy * dy);
    } else if (typeof prev.data['dx'] === 'number' && typeof curr.data['dx'] === 'number') {
      const dx = (curr.data['dx'] as number) - (prev.data['dx'] as number);
      const dy = ((curr.data['dy'] as number) ?? 0) - ((prev.data['dy'] as number) ?? 0);
      mag = Math.sqrt(dx * dx + dy * dy);
    } else {
      mag = 0;
    }
    magnitudes.push(mag);
  }

  const m = mean(magnitudes);
  const s = stddev(magnitudes);
  const smoothness = Math.max(0, 1 - s / Math.max(m, 0.01));
  const confidence = clamp(smoothness);
  return { confidence, noise: 1 - confidence };
}

function estimatePointer(events: UnifiedEvent[]): { confidence: number; noise: number } {
  const latest = events[events.length - 1];
  let confidence: number;
  if (latest !== undefined && typeof latest.data['gestureConfidence'] === 'number') {
    confidence = clamp(latest.data['gestureConfidence'] as number);
  } else {
    confidence = 0.7;
  }
  return { confidence, noise: 1 - confidence };
}

function estimatePassthrough(events: UnifiedEvent[]): { confidence: number; noise: number } {
  // latest event's data.value
  const latest = events[events.length - 1];
  let confidence: number;
  if (latest !== undefined && typeof latest.data['value'] === 'number') {
    confidence = clamp(latest.data['value'] as number);
  } else {
    confidence = 0.5;
  }
  return { confidence, noise: 1 - confidence };
}

export function estimateChannelQuality(
  channel: InputChannel,
  recentEvents: UnifiedEvent[],
  envConditions: EnvironmentConditions,
): ChannelQuality {
  const filtered = recentEvents.filter((e) => e.channel === channel);

  if (filtered.length === 0) {
    return emptyResult(channel);
  }

  const { sampleRate, lastSampledAt } = computeSampleRate(filtered);

  let confidence: number;
  let noise: number;

  switch (channel) {
    case 'voice': {
      ({ confidence, noise } = estimateVoice(filtered, envConditions));
      break;
    }
    case 'gaze': {
      ({ confidence, noise } = estimateGaze(filtered, envConditions));
      break;
    }
    case 'keyboard': {
      ({ confidence, noise } = estimateKeyboard(filtered));
      break;
    }
    case 'mouse': {
      ({ confidence, noise } = estimateMouse(filtered));
      break;
    }
    case 'pointer':
    case 'touch': {
      ({ confidence, noise } = estimatePointer(filtered));
      break;
    }
    case 'env-light':
    case 'env-noise':
    case 'env-network':
    case 'screen': {
      ({ confidence, noise } = estimatePassthrough(filtered));
      break;
    }
    default: {
      confidence = 0.5;
      noise = 0.5;
    }
  }

  return { channel, confidence, noise, sampleRate, lastSampledAt };
}
