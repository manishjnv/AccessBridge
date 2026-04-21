import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  IndicWhisper,
  BCP47_TO_WHISPER,
  FALLBACK_LANGUAGES,
  type TranscribeOptions,
} from '../models/indic-whisper.js';
import type { ONNXRuntime } from '../runtime.js';
import { INDIC_WHISPER_ID } from '../model-registry.js';

// ---------------------------------------------------------------------------
// Mock runtime factory
// ---------------------------------------------------------------------------

function makeMockRuntime(opts: { loaded: boolean } = { loaded: false }) {
  const session = opts.loaded ? { inputNames: [], outputNames: [] } : null;
  return {
    loadModel: vi.fn(async (_id: string, _onProgress?: unknown) => ({
      ok: true,
      session,
      cached: false,
    })),
    hasModel: vi.fn(() => opts.loaded),
    getModel: vi.fn(() => session),
    unloadModel: vi.fn(),
    recordFallback: vi.fn(),
    recordInference: vi.fn(),
    createTensor: vi.fn(),
  } as unknown as ONNXRuntime;
}

// ---------------------------------------------------------------------------
// IndicWhisper — delegation surface
// ---------------------------------------------------------------------------

describe('IndicWhisper — delegation surface', () => {
  let runtime: ReturnType<typeof makeMockRuntime>;
  let whisper: IndicWhisper;

  beforeEach(() => {
    runtime = makeMockRuntime({ loaded: false });
    whisper = new IndicWhisper(runtime);
  });

  it('load() delegates to runtime.loadModel with INDIC_WHISPER_ID', async () => {
    await whisper.load();
    expect(runtime.loadModel).toHaveBeenCalledWith(INDIC_WHISPER_ID, undefined);
  });

  it('load() passes onProgress callback to runtime.loadModel', async () => {
    const onProgress = vi.fn();
    await whisper.load(onProgress);
    expect(runtime.loadModel).toHaveBeenCalledWith(INDIC_WHISPER_ID, onProgress);
  });

  it('ready() returns runtime.hasModel result (false when not loaded)', () => {
    expect(whisper.ready()).toBe(false);
    expect(runtime.hasModel).toHaveBeenCalledWith(INDIC_WHISPER_ID);
  });

  it('ready() returns true when runtime.hasModel returns true', () => {
    const loadedRuntime = makeMockRuntime({ loaded: true });
    const loadedWhisper = new IndicWhisper(loadedRuntime);
    expect(loadedWhisper.ready()).toBe(true);
  });

  it('unload() delegates to runtime.unloadModel with INDIC_WHISPER_ID', () => {
    whisper.unload();
    expect(runtime.unloadModel).toHaveBeenCalledWith(INDIC_WHISPER_ID);
  });

  it('sampleRate getter returns 16000', () => {
    expect(whisper.sampleRate).toBe(16000);
  });
});

// ---------------------------------------------------------------------------
// isSupported — all 22 BCP-47 codes + unknown codes
// ---------------------------------------------------------------------------

describe('IndicWhisper — isSupported', () => {
  let whisper: IndicWhisper;

  beforeEach(() => {
    whisper = new IndicWhisper(makeMockRuntime());
  });

  const supported22 = [
    'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'kn-IN',
    'ml-IN', 'pa-IN', 'ur-IN', 'as-IN', 'sa-IN', 'ne-IN', 'or-IN',
    'si-IN', 'kok', 'ks', 'mni', 'brx', 'sat', 'mai', 'doi', 'sd',
  ];

  it('returns true for all 22 BCP-47 codes in the registry', () => {
    for (const code of supported22) {
      expect(whisper.isSupported(code), `expected ${code} to be supported`).toBe(true);
    }
  });

  it('returns false for unknown code "xx"', () => {
    expect(whisper.isSupported('xx')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(whisper.isSupported('')).toBe(false);
  });

  it('returns false for "zh-CN"', () => {
    expect(whisper.isSupported('zh-CN')).toBe(false);
  });

  it('returns false for Object.prototype keys (proto-pollution guard)', () => {
    // Session 17 adversarial finding: the `in` operator accepts inherited
    // keys. hasOwnProperty.call is the correct check so the language gate
    // does not let 'toString' / 'hasOwnProperty' through.
    expect(whisper.isSupported('toString')).toBe(false);
    expect(whisper.isSupported('hasOwnProperty')).toBe(false);
    expect(whisper.isSupported('__proto__')).toBe(false);
    expect(whisper.isSupported('constructor')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFallbackLanguage
// ---------------------------------------------------------------------------

describe('IndicWhisper — isFallbackLanguage', () => {
  let whisper: IndicWhisper;

  beforeEach(() => {
    whisper = new IndicWhisper(makeMockRuntime());
  });

  it('returns true for ks (Kashmiri — fallback to Urdu)', () => {
    expect(whisper.isFallbackLanguage('ks')).toBe(true);
  });

  it('returns true for kok (Konkani — fallback to Marathi)', () => {
    expect(whisper.isFallbackLanguage('kok')).toBe(true);
  });

  it('returns true for mni, brx, sat, mai, doi, sd', () => {
    for (const code of ['mni', 'brx', 'sat', 'mai', 'doi', 'sd']) {
      expect(whisper.isFallbackLanguage(code), `${code} should be fallback`).toBe(true);
    }
  });

  it('returns false for hi-IN (natively supported)', () => {
    expect(whisper.isFallbackLanguage('hi-IN')).toBe(false);
  });

  it('returns false for bn-IN (natively supported)', () => {
    expect(whisper.isFallbackLanguage('bn-IN')).toBe(false);
  });

  it('returns false for ta-IN (natively supported)', () => {
    expect(whisper.isFallbackLanguage('ta-IN')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transcribe — guard conditions
// ---------------------------------------------------------------------------

describe('IndicWhisper — transcribe guards', () => {
  let notLoadedWhisper: IndicWhisper;

  beforeEach(() => {
    notLoadedWhisper = new IndicWhisper(makeMockRuntime({ loaded: false }));
  });

  it('returns null when model is not loaded (runtime.getModel returns null)', async () => {
    const audio = new Float32Array(16000).fill(0.1);
    const result = await notLoadedWhisper.transcribe(audio, 16000, { language: 'hi-IN' });
    expect(result).toBeNull();
  });

  it('returns null for non-Float32Array audio (Uint8Array)', async () => {
    const loadedWhisper = new IndicWhisper(makeMockRuntime({ loaded: true }));
    const result = await loadedWhisper.transcribe(
      new Uint8Array(16000) as unknown as Float32Array,
      16000,
      { language: 'hi-IN' },
    );
    expect(result).toBeNull();
  });

  it('returns null for zero-length Float32Array', async () => {
    const loadedWhisper = new IndicWhisper(makeMockRuntime({ loaded: true }));
    const result = await loadedWhisper.transcribe(new Float32Array(0), 16000, { language: 'hi-IN' });
    expect(result).toBeNull();
  });

  it('returns null for sampleRate === 0', async () => {
    const loadedWhisper = new IndicWhisper(makeMockRuntime({ loaded: true }));
    const result = await loadedWhisper.transcribe(new Float32Array(100).fill(0.1), 0, { language: 'hi-IN' });
    expect(result).toBeNull();
  });

  it('returns null for sampleRate === NaN', async () => {
    const loadedWhisper = new IndicWhisper(makeMockRuntime({ loaded: true }));
    const result = await loadedWhisper.transcribe(new Float32Array(100).fill(0.1), NaN, { language: 'hi-IN' });
    expect(result).toBeNull();
  });

  it('throws for unsupported language code', async () => {
    const loadedWhisper = new IndicWhisper(makeMockRuntime({ loaded: true }));
    await expect(
      loadedWhisper.transcribe(new Float32Array(100).fill(0.1), 16000, { language: 'xx' }),
    ).rejects.toThrow('unsupported language');
  });
});

// ---------------------------------------------------------------------------
// transcribe — happy-path stub behavior (Session 17)
// ---------------------------------------------------------------------------

describe('IndicWhisper — transcribe stub result (Session 17)', () => {
  let loadedWhisper: IndicWhisper;
  let loadedRuntime: ReturnType<typeof makeMockRuntime>;

  beforeEach(() => {
    loadedRuntime = makeMockRuntime({ loaded: true });
    loadedWhisper = new IndicWhisper(loadedRuntime);
  });

  it('returns {real: false, text: "", confidence: 0, language: requested, latencyMs >= 0}', async () => {
    const audio = new Float32Array(16000).fill(0.2);
    const result = await loadedWhisper.transcribe(audio, 16000, { language: 'hi-IN' });
    expect(result).not.toBeNull();
    expect(result!.real).toBe(false);
    expect(result!.text).toBe('');
    expect(result!.confidence).toBe(0);
    expect(result!.language).toBe('hi-IN');
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses options.chunks directly when provided (skips preprocessAudio)', async () => {
    const preChunked = [new Float32Array(480000).fill(0.1)];
    const options: TranscribeOptions = { language: 'ta-IN', chunks: preChunked };
    const result = await loadedWhisper.transcribe(new Float32Array(100).fill(0.1), 16000, options);
    // Stub still returns the structured result regardless of chunk source
    expect(result).not.toBeNull();
    expect(result!.language).toBe('ta-IN');
    expect(result!.real).toBe(false);
  });

  it('calls runtime.recordFallback once per transcribe call', async () => {
    const audio = new Float32Array(16000).fill(0.3);
    await loadedWhisper.transcribe(audio, 16000, { language: 'bn-IN' });
    expect(loadedRuntime.recordFallback).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// BCP47_TO_WHISPER — fallback code mapping
// ---------------------------------------------------------------------------

describe('BCP47_TO_WHISPER fallback mapping', () => {
  it('kok maps to mr (Konkani → Marathi)', () => {
    expect(BCP47_TO_WHISPER['kok']).toBe('mr');
  });

  it('ks maps to ur (Kashmiri → Urdu)', () => {
    expect(BCP47_TO_WHISPER['ks']).toBe('ur');
  });

  it('mni maps to hi (Manipuri → Hindi)', () => {
    expect(BCP47_TO_WHISPER['mni']).toBe('hi');
  });

  it('brx maps to hi (Bodo → Hindi)', () => {
    expect(BCP47_TO_WHISPER['brx']).toBe('hi');
  });

  it('sat maps to hi (Santali → Hindi)', () => {
    expect(BCP47_TO_WHISPER['sat']).toBe('hi');
  });

  it('mai maps to hi (Maithili → Hindi)', () => {
    expect(BCP47_TO_WHISPER['mai']).toBe('hi');
  });

  it('doi maps to hi (Dogri → Hindi)', () => {
    expect(BCP47_TO_WHISPER['doi']).toBe('hi');
  });

  it('sd maps to ur (Sindhi → Urdu)', () => {
    expect(BCP47_TO_WHISPER['sd']).toBe('ur');
  });
});
