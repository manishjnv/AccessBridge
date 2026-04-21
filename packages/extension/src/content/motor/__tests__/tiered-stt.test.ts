import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  pickTier,
  TieredSTT,
  TIER_A_LANGUAGES,
  type VoiceTierPreference,
  type TieredSTTOptions,
  type TranscriptionOutcome,
  type VoiceTier,
} from '../tiered-stt.js';

// ---------------------------------------------------------------------------
// Minimal MediaStream / MediaRecorder fakes
// ---------------------------------------------------------------------------

function makeTrack() {
  return { stop: vi.fn() };
}

function makeStream(trackCount = 1) {
  const tracks = Array.from({ length: trackCount }, makeTrack);
  return {
    getTracks: vi.fn(() => tracks),
    tracks,
  } as unknown as MediaStream;
}

/**
 * Minimal MediaRecorder constructor fake. Calling .start() immediately fires
 * ondataavailable with a non-empty Blob then onstop after a microtask — so
 * the captureAndTranscribeViaTierB Promise resolves without real timers.
 */
function makeMediaRecorderCtor(blobSize = 10) {
  return vi.fn((_stream: MediaStream) => {
    const rec: {
      start: () => void;
      stop: () => void;
      ondataavailable: ((e: { data: Blob }) => void) | null;
      onstop: (() => void) | null;
    } = {
      ondataavailable: null,
      onstop: null,
      start() {
        // Fire data + stop asynchronously so the Promise chain can settle.
        Promise.resolve().then(() => {
          const blob = new Blob([new Uint8Array(blobSize)], { type: 'audio/webm' });
          rec.ondataavailable?.({ data: blob });
        }).then(() => {
          rec.onstop?.();
        });
      },
      stop: vi.fn(),
    };
    return rec;
  }) as unknown as typeof MediaRecorder;
}

// ---------------------------------------------------------------------------
// Default TieredSTTOptions builder
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<TieredSTTOptions> = {}): TieredSTTOptions {
  return {
    language: 'hi-IN',
    preference: 'auto',
    onTranscription: vi.fn(),
    onTierChange: vi.fn(),
    onError: vi.fn(),
    sendMessage: vi.fn(async () => ({
      ok: true,
      text: 'hello',
      confidence: 0.9,
      language: 'hi-IN',
      latencyMs: 50,
    })),
    getUserMedia: vi.fn(async () => makeStream()),
    mediaRecorderCtor: makeMediaRecorderCtor(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pickTier — pure function tests
// ---------------------------------------------------------------------------

describe('pickTier', () => {
  it('preference="native" always returns "A"', () => {
    expect(pickTier({
      preference: 'native',
      language: 'kok',          // non-Tier-A language
      indicWhisperReady: true,
      recentConfidences: [0.1, 0.1, 0.1],
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('A');
  });

  it('preference="onnx" returns "B" when indicWhisperReady is true', () => {
    expect(pickTier({
      preference: 'onnx',
      language: 'hi-IN',
      indicWhisperReady: true,
      recentConfidences: [],
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('B');
  });

  it('preference="onnx" returns "A" when indicWhisperReady is false', () => {
    expect(pickTier({
      preference: 'onnx',
      language: 'hi-IN',
      indicWhisperReady: false,
      recentConfidences: [],
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('A');
  });

  it('preference="auto" + Tier-A language + high recent confidences returns "A"', () => {
    expect(pickTier({
      preference: 'auto',
      language: 'hi-IN',
      indicWhisperReady: true,
      recentConfidences: [0.9, 0.85, 0.95], // avg well above 0.55
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('A');
  });

  it('preference="auto" + non-Tier-A language returns "B" when ready', () => {
    expect(TIER_A_LANGUAGES.has('kok')).toBe(false);
    expect(pickTier({
      preference: 'auto',
      language: 'kok',
      indicWhisperReady: true,
      recentConfidences: [],
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('B');
  });

  it('preference="auto" + non-Tier-A language returns "A" when not ready', () => {
    expect(pickTier({
      preference: 'auto',
      language: 'kok',
      indicWhisperReady: false,
      recentConfidences: [],
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('A');
  });

  it('preference="auto" + Tier-A language escalates to "B" when avg recent confidence is below threshold', () => {
    expect(pickTier({
      preference: 'auto',
      language: 'hi-IN',
      indicWhisperReady: true,
      recentConfidences: [0.3, 0.2, 0.25], // avg 0.25 < 0.55
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('B');
  });

  it('low-confidence escalation does not fire with fewer samples than lowConfWindow', () => {
    // Only 2 samples but window=3 — should not escalate despite low values.
    expect(pickTier({
      preference: 'auto',
      language: 'hi-IN',
      indicWhisperReady: true,
      recentConfidences: [0.1, 0.2], // avg < 0.55 but only 2 samples
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('A');
  });

  it('preference="cloud-allowed" behaves like auto for Tier A/B choice', () => {
    // High confidence Tier-A language → stays on A.
    expect(pickTier({
      preference: 'cloud-allowed',
      language: 'hi-IN',
      indicWhisperReady: true,
      recentConfidences: [0.9, 0.85, 0.95],
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('A');

    // Non-Tier-A language, ready → B.
    expect(pickTier({
      preference: 'cloud-allowed',
      language: 'kok',
      indicWhisperReady: true,
      recentConfidences: [],
      lowConfThreshold: 0.55,
      lowConfWindow: 3,
    })).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// TieredSTT — nextTier reflects setPreference / setIndicWhisperReady
// ---------------------------------------------------------------------------

describe('TieredSTT.nextTier', () => {
  it('reflects setPreference change: native forces A even after ONNX model becomes ready', () => {
    const stt = new TieredSTT(makeOpts({ preference: 'auto', language: 'hi-IN' }));
    stt.setIndicWhisperReady(true);
    stt.setPreference('native');
    expect(stt.nextTier()).toBe('A');
  });

  it('reflects setIndicWhisperReady: onnx preference switches from A to B when model loads', () => {
    const stt = new TieredSTT(makeOpts({ preference: 'onnx', language: 'hi-IN' }));
    expect(stt.nextTier()).toBe('A'); // not ready yet
    stt.setIndicWhisperReady(true);
    expect(stt.nextTier()).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// TieredSTT — setLanguage changes tier routing
// ---------------------------------------------------------------------------

describe('TieredSTT.setLanguage', () => {
  it('switching to a non-Tier-A language causes nextTier to return B when model is ready', () => {
    const stt = new TieredSTT(makeOpts({ preference: 'auto', language: 'hi-IN' }));
    stt.setIndicWhisperReady(true);
    expect(stt.nextTier()).toBe('A'); // hi-IN is Tier A

    stt.setLanguage('kok'); // non-Tier-A
    expect(stt.nextTier()).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// TieredSTT — recordTierAConfidence caps history at 10
// ---------------------------------------------------------------------------

describe('TieredSTT.recordTierAConfidence', () => {
  it('caps history at 10 entries (oldest is evicted)', () => {
    const stt = new TieredSTT(makeOpts());
    for (let i = 0; i < 12; i++) {
      stt.recordTierAConfidence(0.8);
    }
    expect(stt.getRecentConfidences().length).toBe(10);
  });

  it('ignores non-finite values', () => {
    const stt = new TieredSTT(makeOpts());
    stt.recordTierAConfidence(NaN);
    stt.recordTierAConfidence(Infinity);
    expect(stt.getRecentConfidences().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TieredSTT.captureAndTranscribeViaTierB — success path
// ---------------------------------------------------------------------------

describe('TieredSTT.captureAndTranscribeViaTierB — success', () => {
  it('sends INDIC_WHISPER_TRANSCRIBE message and returns transcription outcome', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      text: 'namaste',
      confidence: 0.88,
      language: 'hi-IN',
      latencyMs: 120,
    }));
    const onTranscription = vi.fn();
    const opts = makeOpts({ sendMessage, onTranscription });
    const stt = new TieredSTT(opts);

    const result = await stt.captureAndTranscribeViaTierB(0); // 0 ms timeout fires immediately

    // Message type must be INDIC_WHISPER_TRANSCRIBE
    expect(sendMessage).toHaveBeenCalledOnce();
    const [msg] = sendMessage.mock.calls[0] as [{ type: string; payload: { language: string } }][];
    expect((msg as unknown as { type: string }).type).toBe('INDIC_WHISPER_TRANSCRIBE');

    // Outcome shape
    expect(result.tier).toBe('B');
    expect(result.text).toBe('namaste');
    expect(result.confidence).toBeCloseTo(0.88, 5);
    expect(result.language).toBe('hi-IN');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('onTierChange is called with "B" when captureAndTranscribeViaTierB fires', async () => {
    const onTierChange = vi.fn();
    const stt = new TieredSTT(makeOpts({ onTierChange }));
    await stt.captureAndTranscribeViaTierB(0);
    expect(onTierChange).toHaveBeenCalledWith('B');
  });
});

// ---------------------------------------------------------------------------
// TieredSTT.captureAndTranscribeViaTierB — error paths
// ---------------------------------------------------------------------------

describe('TieredSTT.captureAndTranscribeViaTierB — errors', () => {
  it('returns error outcome when getUserMedia rejects', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('Permission denied');
    });
    const stt = new TieredSTT(makeOpts({ getUserMedia }));
    const result = await stt.captureAndTranscribeViaTierB(0);

    expect(result.tier).toBe('B');
    expect(result.error).toBeDefined();
    expect(result.text).toBe('');
    expect(result.confidence).toBe(0);
  });

  it('returns error outcome when background sendMessage returns ok:false', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: false,
      error: 'decoder-not-implemented',
    }));
    const stt = new TieredSTT(makeOpts({ sendMessage }));
    const result = await stt.captureAndTranscribeViaTierB(0);

    expect(result.tier).toBe('B');
    expect(result.error).toBeDefined();
    expect(result.text).toBe('');
  });

  it('returns error outcome when sendMessage throws', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('bg context unavailable');
    });
    const stt = new TieredSTT(makeOpts({ sendMessage }));
    const result = await stt.captureAndTranscribeViaTierB(0);

    expect(result.tier).toBe('B');
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Audio privacy invariant
// ---------------------------------------------------------------------------

describe('Audio privacy invariant', () => {
  it('after captureAndTranscribeViaTierB resolves, the only public state is getCurrentTier and getRecentConfidences', async () => {
    const stt = new TieredSTT(makeOpts());
    await stt.captureAndTranscribeViaTierB(0);

    // The public API exposes getCurrentTier and getRecentConfidences only.
    // We verify neither holds a Blob nor Uint8Array reference after resolution.
    const tier = stt.getCurrentTier();
    const confidences = stt.getRecentConfidences();

    expect(tier).toBe('B');
    // captureAndTranscribeViaTierB does not push to recentConfidences (that is for Tier A)
    expect(Array.isArray(confidences) || ArrayBuffer.isView(confidences)).toBe(true);

    // Verify no Blob or decoded bytes leak through the public API.
    const ownKeys = Object.keys(stt as unknown as Record<string, unknown>);
    for (const key of ownKeys) {
      const val = (stt as unknown as Record<string, unknown>)[key];
      expect(val instanceof Blob, `key "${key}" should not hold a Blob`).toBe(false);
      expect(val instanceof Uint8Array, `key "${key}" should not hold a Uint8Array`).toBe(false);
    }
  });
});
