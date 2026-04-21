import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizeFloat32,
  resampleLinear,
  chunkAudio,
  preprocessAudio,
  WHISPER_SAMPLE_RATE,
  WHISPER_CHUNK_SAMPLES,
  DEFAULT_CHUNK_OVERLAP,
  type AudioBufferLike,
} from '../models/audio-preprocessor.js';

// ---------------------------------------------------------------------------
// normalizeFloat32
// ---------------------------------------------------------------------------

describe('normalizeFloat32', () => {
  it('peak magnitude is 1.0 after scaling a mixed-amplitude array', () => {
    const samples = new Float32Array([0.1, -0.5, 0.3, -0.2]);
    const out = normalizeFloat32(samples);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const abs = Math.abs(out[i]);
      if (abs > peak) peak = abs;
    }
    expect(peak).toBeCloseTo(1.0, 5);
  });

  it('zero-length input is returned unchanged (same reference)', () => {
    const samples = new Float32Array(0);
    const out = normalizeFloat32(samples);
    expect(out).toBe(samples);
    expect(out.length).toBe(0);
  });

  it('all-zero input is returned unchanged (peak === 0 guard)', () => {
    const samples = new Float32Array([0, 0, 0]);
    const out = normalizeFloat32(samples);
    expect(out).toBe(samples);
  });

  it('preserves sign of samples (positive stays positive, negative stays negative)', () => {
    const samples = new Float32Array([0.25, -0.5, 0.125]);
    const out = normalizeFloat32(samples);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(0);
    expect(out[2]).toBeGreaterThan(0);
  });

  it('output values are clamped to [-1, 1]', () => {
    // All values already at peak — scaling brings exactly ±1.
    const samples = new Float32Array([0.8, -0.8, 0.4]);
    const out = normalizeFloat32(samples);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(-1);
      expect(out[i]).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// resampleLinear
// ---------------------------------------------------------------------------

describe('resampleLinear', () => {
  it('downsamples 44100 → 16000: output length matches floor(inLen * 16000/44100)', () => {
    const inLen = 44100; // 1 second at 44.1 kHz
    const samples = new Float32Array(inLen).fill(0.5);
    const out = resampleLinear(samples, 44100, 16000);
    const expectedLen = Math.floor(inLen / (44100 / 16000));
    expect(out.length).toBe(expectedLen);
  });

  it('same-rate short-circuits: returns a copy, not the original reference', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    const out = resampleLinear(samples, 16000, 16000);
    expect(out).not.toBe(samples);
    expect(Array.from(out)).toEqual(Array.from(samples));
  });

  it('empty input returns empty output', () => {
    const out = resampleLinear(new Float32Array(0), 44100, 16000);
    expect(out.length).toBe(0);
  });

  it('invalid fromRate (0) returns empty output', () => {
    const out = resampleLinear(new Float32Array([0.1, 0.2]), 0, 16000);
    expect(out.length).toBe(0);
  });

  it('invalid fromRate (NaN) returns empty output', () => {
    const out = resampleLinear(new Float32Array([0.1]), NaN, 16000);
    expect(out.length).toBe(0);
  });

  it('invalid toRate (negative) returns empty output', () => {
    const out = resampleLinear(new Float32Array([0.1]), 44100, -1);
    expect(out.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// chunkAudio
// ---------------------------------------------------------------------------

describe('chunkAudio', () => {
  it('exactly-window-sized input returns a single zero-padded chunk of chunkSize', () => {
    const size = WHISPER_CHUNK_SAMPLES;
    const samples = new Float32Array(size).fill(1);
    const chunks = chunkAudio(samples, size, 0);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(size);
  });

  it('larger-than-window input with default overlap produces multiple chunks all of length chunkSize', () => {
    // 2.5 windows worth of audio
    const samples = new Float32Array(Math.floor(WHISPER_CHUNK_SAMPLES * 2.5)).fill(0.5);
    const chunks = chunkAudio(samples, WHISPER_CHUNK_SAMPLES, DEFAULT_CHUNK_OVERLAP);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(WHISPER_CHUNK_SAMPLES);
    }
  });

  it('overlap >= chunkSize is coerced to 0 (no overlap)', () => {
    const chunkSize = 100;
    const samples = new Float32Array(250).fill(1);
    // With coerced overlap=0, step=100; produces 3 chunks (0-99, 100-199, 200-249 padded)
    const chunks = chunkAudio(samples, chunkSize, chunkSize); // overlap === chunkSize
    const chunksNoOverlap = chunkAudio(samples, chunkSize, 0);
    expect(chunks.length).toBe(chunksNoOverlap.length);
  });

  it('zero-length input returns empty array', () => {
    const chunks = chunkAudio(new Float32Array(0));
    expect(chunks).toEqual([]);
  });

  it('last chunk is zero-padded to full chunkSize when audio does not fill the window', () => {
    const chunkSize = 1000;
    // 1500 samples → chunk 0 covers 0-999, chunk 1 covers 1000-1499 (padded to 1000)
    const samples = new Float32Array(1500).fill(0.7);
    const chunks = chunkAudio(samples, chunkSize, 0);
    const last = chunks[chunks.length - 1];
    expect(last.length).toBe(chunkSize);
    // Tail of last chunk should be 0-padded (positions 500-999)
    for (let i = 500; i < chunkSize; i++) {
      expect(last[i]).toBe(0);
    }
  });

  it('sub-window input is returned as single chunk zero-padded to full chunkSize', () => {
    const chunkSize = 1000;
    const samples = new Float32Array(400).fill(0.3);
    const chunks = chunkAudio(samples, chunkSize, 0);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(chunkSize);
    for (let i = 400; i < chunkSize; i++) {
      expect(chunks[0][i]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// preprocessAudio — Float32Array path
// ---------------------------------------------------------------------------

describe('preprocessAudio (Float32Array path)', () => {
  it('throws when sampleRate is missing for Float32Array input', async () => {
    const samples = new Float32Array(100).fill(0.5);
    await expect(preprocessAudio(samples, undefined)).rejects.toThrow('sampleRate');
  });

  it('same-rate input skips resample and returns normalized output', async () => {
    const samples = new Float32Array(100).fill(0.4);
    const out = await preprocessAudio(samples, WHISPER_SAMPLE_RATE);
    // Normalized: peak should be ~1.0
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const abs = Math.abs(out[i]);
      if (abs > peak) peak = abs;
    }
    expect(peak).toBeCloseTo(1.0, 5);
  });

  it('normalize: false preserves values without scaling', async () => {
    const samples = new Float32Array([0.1, 0.2, 0.1]);
    const out = await preprocessAudio(samples, WHISPER_SAMPLE_RATE, { normalize: false });
    expect(out[0]).toBeCloseTo(0.1, 5);
    expect(out[1]).toBeCloseTo(0.2, 5);
  });
});

// ---------------------------------------------------------------------------
// preprocessAudio — AudioBufferLike path (multi-channel downmix)
// ---------------------------------------------------------------------------

describe('preprocessAudio (AudioBufferLike multi-channel downmix)', () => {
  function makeAudioBuffer(channels: Float32Array[]): AudioBufferLike {
    return {
      sampleRate: WHISPER_SAMPLE_RATE,
      numberOfChannels: channels.length,
      length: channels[0].length,
      getChannelData: (ch: number) => channels[ch],
    };
  }

  it('two-channel input is downmixed to mono (average of channels)', async () => {
    const ch0 = new Float32Array([0.8, 0.4]);
    const ch1 = new Float32Array([0.4, 0.8]);
    const buf = makeAudioBuffer([ch0, ch1]);
    // normalize:false so we can inspect raw mono values before scaling
    const out = await preprocessAudio(buf, undefined, { normalize: false });
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.6, 5); // (0.8 + 0.4) / 2
    expect(out[1]).toBeCloseTo(0.6, 5); // (0.4 + 0.8) / 2
  });

  it('single-channel AudioBufferLike is passed through without averaging', async () => {
    const ch0 = new Float32Array([0.3, 0.5, 0.1]);
    const buf = makeAudioBuffer([ch0]);
    const out = await preprocessAudio(buf, undefined, { normalize: false });
    expect(out[0]).toBeCloseTo(0.3, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
  });
});
