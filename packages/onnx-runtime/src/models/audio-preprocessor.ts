/**
 * audio-preprocessor — Whisper-compatible audio preparation for the Tier-3
 * IndicWhisper ONNX pipeline.
 *
 * Whisper requires 16 kHz mono Float32 audio clipped to 30-second windows.
 * These helpers are pure functions so tests can run them without a DOM:
 *
 *   - resampleLinear   : simple linear resampler for raw Float32 arrays (tests)
 *   - resample         : browser OfflineAudioContext wrapper (runtime)
 *   - normalizeFloat32 : clamp to [-1, 1] and scale to peak
 *   - chunkAudio       : split into N-sample windows with overlap
 *   - preprocessAudio  : end-to-end (AudioBuffer | Float32Array) -> Float32Array
 *
 * The browser-only path (OfflineAudioContext) is guarded; when the global
 * is unavailable we fall back to the pure-JS linear resampler. Tests stub
 * it directly. Note: the linear resampler is adequate for speech (Whisper
 * handles typical resampling artefacts); high-fidelity downstream tasks
 * should prefer the OfflineAudioContext path which the browser implements
 * with proper sinc interpolation.
 */

export const WHISPER_SAMPLE_RATE = 16_000;
/** Whisper's input window length: 30 seconds @ 16 kHz = 480 000 samples. */
export const WHISPER_CHUNK_SAMPLES = 30 * WHISPER_SAMPLE_RATE;
/**
 * Default overlap between consecutive chunks. 5 s at 16 kHz. Prevents
 * word boundaries from being clipped at the 30 s seam.
 */
export const DEFAULT_CHUNK_OVERLAP = 5 * WHISPER_SAMPLE_RATE;

/** Clamp + normalize a Float32Array so its peak magnitude is ~1.0. */
export function normalizeFloat32(samples: Float32Array): Float32Array {
  if (samples.length === 0) return samples;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
  }
  if (peak === 0) return samples;
  const scale = 1 / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * scale;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

/**
 * Pure linear resampler. Not high-fidelity; Whisper tolerates it for
 * speech. When running in a browser prefer `resample()` below which uses
 * OfflineAudioContext's native sinc resampler.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0) return new Float32Array(0);
  if (!Number.isFinite(toRate) || toRate <= 0) return new Float32Array(0);
  if (samples.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return new Float32Array(samples);

  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = src - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}

interface OfflineAudioContextCtor {
  new (channels: number, length: number, sampleRate: number): {
    createBufferSource(): {
      buffer: unknown;
      connect(destination: unknown): void;
      start(when?: number): void;
    };
    createBuffer(
      channels: number,
      length: number,
      sampleRate: number,
    ): {
      getChannelData(channel: number): Float32Array;
      copyToChannel?(source: Float32Array, channel: number): void;
    };
    readonly destination: unknown;
    startRendering(): Promise<{
      getChannelData(channel: number): Float32Array;
      length: number;
    }>;
  };
}

/**
 * Browser resampler using OfflineAudioContext. Falls back to the pure
 * linear resampler when the global is unavailable (tests, service worker).
 */
export async function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
  offlineCtxCtor?: OfflineAudioContextCtor,
): Promise<Float32Array> {
  const Ctor =
    offlineCtxCtor ??
    ((globalThis as { OfflineAudioContext?: OfflineAudioContextCtor })
      .OfflineAudioContext);
  if (!Ctor) return resampleLinear(samples, fromRate, toRate);
  if (fromRate === toRate) return new Float32Array(samples);
  if (samples.length === 0) return new Float32Array(0);

  const srcCtx = new Ctor(1, samples.length, fromRate);
  const srcBuf = srcCtx.createBuffer(1, samples.length, fromRate);
  if (srcBuf.copyToChannel) {
    srcBuf.copyToChannel(samples, 0);
  } else {
    const ch = srcBuf.getChannelData(0);
    ch.set(samples);
  }

  const outLen = Math.max(1, Math.floor((samples.length * toRate) / fromRate));
  const dstCtx = new Ctor(1, outLen, toRate);
  const src = dstCtx.createBufferSource();
  src.buffer = srcBuf;
  src.connect(dstCtx.destination);
  src.start(0);
  const rendered = await dstCtx.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

/**
 * Split audio into overlapping fixed-size windows. The last chunk is
 * returned full-length (zero-padded) so downstream inference always sees
 * a 30-second input.
 */
export function chunkAudio(
  samples: Float32Array,
  chunkSize = WHISPER_CHUNK_SAMPLES,
  overlap = DEFAULT_CHUNK_OVERLAP,
): Float32Array[] {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) return [];
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= chunkSize) {
    overlap = 0;
  }
  if (samples.length === 0) return [];
  if (samples.length <= chunkSize) {
    const single = new Float32Array(chunkSize);
    single.set(samples);
    return [single];
  }

  const chunks: Float32Array[] = [];
  const step = chunkSize - overlap;
  let start = 0;
  while (start < samples.length) {
    const window = new Float32Array(chunkSize);
    const slice = samples.subarray(start, Math.min(start + chunkSize, samples.length));
    window.set(slice);
    chunks.push(window);
    if (start + chunkSize >= samples.length) break;
    start += step;
  }
  return chunks;
}

export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * End-to-end preprocessor: downmix to mono, resample to 16 kHz, normalize
 * to [-1, 1], return a single Float32Array. Resampling can be overridden
 * for tests.
 */
export async function preprocessAudio(
  source: AudioBufferLike | Float32Array,
  sampleRate?: number,
  options: {
    offlineCtxCtor?: OfflineAudioContextCtor;
    normalize?: boolean;
  } = {},
): Promise<Float32Array> {
  let mono: Float32Array;
  let inRate: number;

  if (source instanceof Float32Array) {
    if (!Number.isFinite(sampleRate) || (sampleRate ?? 0) <= 0) {
      throw new Error('preprocessAudio: sampleRate required for Float32Array input');
    }
    mono = source;
    inRate = sampleRate as number;
  } else {
    inRate = source.sampleRate;
    if (source.numberOfChannels === 1) {
      mono = source.getChannelData(0);
    } else {
      // Downmix to mono by averaging channels.
      mono = new Float32Array(source.length);
      for (let c = 0; c < source.numberOfChannels; c++) {
        const ch = source.getChannelData(c);
        for (let i = 0; i < source.length; i++) mono[i] += ch[i];
      }
      const inv = 1 / source.numberOfChannels;
      for (let i = 0; i < mono.length; i++) mono[i] *= inv;
    }
  }

  const resampled =
    inRate === WHISPER_SAMPLE_RATE
      ? mono
      : await resample(mono, inRate, WHISPER_SAMPLE_RATE, options.offlineCtxCtor);

  return options.normalize === false ? resampled : normalizeFloat32(resampled);
}
