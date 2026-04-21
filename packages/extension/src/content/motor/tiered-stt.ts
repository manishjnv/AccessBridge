/**
 * TieredSTT — three-tier Speech-To-Text strategy-picker.
 *
 *   Tier A (fastest, free): Chrome Web Speech API for the 11 Indian
 *                            languages with native locale support.
 *   Tier B (on-device ONNX): IndicWhisper-small (int8) for the remaining
 *                            Indic codes + quality-upgrade for Tier A
 *                            languages when the last few results had
 *                            low confidence.
 *   Tier C (cloud fallback): Gemini Flash multimodal audio — only fired
 *                            when the profile permits it.
 *
 * The actual speech recognition for Tier A is delegated to the existing
 * VoiceCommandSystem; TieredSTT routes audio into MediaRecorder + a
 * chrome.runtime.sendMessage('INDIC_WHISPER_TRANSCRIBE') path for Tier B.
 * This keeps the fast path (Hindi / Bengali / Tamil / ...) untouched and
 * opts-in additional languages per the profile.voiceQualityTier setting.
 *
 * Session 17 marker: // --- Session 17: TieredSTT ---
 */

export type VoiceTier = 'A' | 'B' | 'C';
export type VoiceTierPreference = 'auto' | 'native' | 'onnx' | 'cloud-allowed';

/** Chrome-native Web Speech API locales (BCP-47) for the 11 natively supported. */
export const TIER_A_LANGUAGES: ReadonlySet<string> = new Set([
  'hi-IN',
  'bn-IN',
  'ta-IN',
  'te-IN',
  'mr-IN',
  'gu-IN',
  'kn-IN',
  'ml-IN',
  'pa-IN',
  'ur-IN',
  'as-IN',
  'en-US',
  'en-GB',
  'en-IN',
]);

export interface TranscriptionOutcome {
  tier: VoiceTier;
  text: string;
  confidence: number;
  language: string;
  latencyMs: number;
  error?: string;
}

export interface TieredSTTOptions {
  language: string;
  preference: VoiceTierPreference;
  /** Called when a transcription arrives; shape matches VoiceCommandSystem.onCommand. */
  onTranscription: (outcome: TranscriptionOutcome) => void;
  /** Tier badge hook — called with 'A' | 'B' | 'C' so the UI can flip the pill label. */
  onTierChange?: (tier: VoiceTier) => void;
  onError?: (msg: string) => void;
  /**
   * Rolling-window size for low-confidence escalation from Tier A → B.
   * If the last N Tier-A transcriptions average below the threshold we
   * switch to Tier B on the next utterance. Default 3.
   */
  lowConfidenceWindow?: number;
  /** Confidence threshold below which we consider escalating. Default 0.55. */
  lowConfidenceThreshold?: number;
  /** Override chrome.runtime.sendMessage for tests. */
  sendMessage?: (msg: unknown) => Promise<unknown>;
  /** Override navigator.mediaDevices.getUserMedia for tests. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Override MediaRecorder for tests. */
  mediaRecorderCtor?: typeof MediaRecorder;
}

/**
 * Picks which tier should serve the next utterance given profile + history.
 * Pure function — exported for tests.
 */
export function pickTier(params: {
  preference: VoiceTierPreference;
  language: string;
  indicWhisperReady: boolean;
  recentConfidences: number[];
  lowConfThreshold: number;
  lowConfWindow: number;
}): VoiceTier {
  const { preference, language, indicWhisperReady, recentConfidences, lowConfThreshold, lowConfWindow } = params;

  if (preference === 'native') return 'A';
  if (preference === 'onnx') return indicWhisperReady ? 'B' : 'A';

  // auto + cloud-allowed both prefer A first, falling back to B on gap/low-confidence.
  const hasTierA = TIER_A_LANGUAGES.has(language);
  if (!hasTierA) return indicWhisperReady ? 'B' : 'A';

  // Low-confidence escalation.
  if (
    recentConfidences.length >= lowConfWindow &&
    indicWhisperReady
  ) {
    const window = recentConfidences.slice(-lowConfWindow);
    const avg = window.reduce((s, v) => s + v, 0) / window.length;
    if (avg < lowConfThreshold) return 'B';
  }

  return 'A';
}

export class TieredSTT {
  private readonly opts: Required<
    Omit<TieredSTTOptions, 'onTierChange' | 'onError' | 'sendMessage' | 'getUserMedia' | 'mediaRecorderCtor'>
  > & {
    onTierChange: (tier: VoiceTier) => void;
    onError: (msg: string) => void;
    sendMessage: (msg: unknown) => Promise<unknown>;
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    mediaRecorderCtor: typeof MediaRecorder;
  };

  private recentConfidences: number[] = [];
  private indicWhisperReady = false;
  private currentTier: VoiceTier = 'A';
  private activeRecorder: MediaRecorder | null = null;
  private activeStream: MediaStream | null = null;

  constructor(options: TieredSTTOptions) {
    this.opts = {
      language: options.language,
      preference: options.preference,
      onTranscription: options.onTranscription,
      onTierChange: options.onTierChange ?? (() => {}),
      onError: options.onError ?? (() => {}),
      lowConfidenceWindow: options.lowConfidenceWindow ?? 3,
      lowConfidenceThreshold: options.lowConfidenceThreshold ?? 0.55,
      sendMessage:
        options.sendMessage ??
        (async (msg: unknown) => {
          if (
            typeof chrome !== 'undefined' &&
            chrome.runtime &&
            typeof chrome.runtime.sendMessage === 'function'
          ) {
            return chrome.runtime.sendMessage(msg);
          }
          throw new Error('chrome.runtime.sendMessage unavailable');
        }),
      getUserMedia:
        options.getUserMedia ??
        ((constraints: MediaStreamConstraints) => {
          if (
            typeof navigator !== 'undefined' &&
            navigator.mediaDevices &&
            typeof navigator.mediaDevices.getUserMedia === 'function'
          ) {
            return navigator.mediaDevices.getUserMedia(constraints);
          }
          return Promise.reject(new Error('mediaDevices.getUserMedia unavailable'));
        }),
      mediaRecorderCtor:
        options.mediaRecorderCtor ??
        (typeof MediaRecorder !== 'undefined' ? MediaRecorder : (null as unknown as typeof MediaRecorder)),
    };
  }

  /** Notify the picker that the IndicWhisper Tier B model is ready (loaded in background). */
  setIndicWhisperReady(ready: boolean): void {
    this.indicWhisperReady = ready;
  }

  /** Record a Tier A confidence so future picks can escalate. */
  recordTierAConfidence(confidence: number): void {
    if (!Number.isFinite(confidence)) return;
    this.recentConfidences.push(confidence);
    if (this.recentConfidences.length > 10) {
      this.recentConfidences.shift();
    }
  }

  /** Update the profile-derived language live. */
  setLanguage(language: string): void {
    this.opts.language = language;
  }

  /** Update the tier preference live. */
  setPreference(preference: VoiceTierPreference): void {
    this.opts.preference = preference;
  }

  /** Which tier will serve the next utterance? */
  nextTier(): VoiceTier {
    return pickTier({
      preference: this.opts.preference,
      language: this.opts.language,
      indicWhisperReady: this.indicWhisperReady,
      recentConfidences: this.recentConfidences,
      lowConfThreshold: this.opts.lowConfidenceThreshold,
      lowConfWindow: this.opts.lowConfidenceWindow,
    });
  }

  /**
   * Caller invokes this when Tier A isn't going to serve the utterance
   * (because nextTier() !== 'A') — records audio via MediaRecorder and
   * hands the encoded blob to the background for ONNX transcription.
   */
  async captureAndTranscribeViaTierB(
    durationMs = 5_000,
  ): Promise<TranscriptionOutcome> {
    // Session 17 adversarial finding: clamp recording duration so a
    // hostile caller can't request a 1-hour MediaRecorder buffer.
    // Range [0 ms, 30 s] — 30 s matches Whisper's native window length.
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      durationMs = 0;
    } else if (durationMs > 30_000) {
      durationMs = 30_000;
    }
    const tier: VoiceTier = 'B';
    this.currentTier = tier;
    this.opts.onTierChange(tier);
    const started = nowMs();

    if (!this.opts.mediaRecorderCtor) {
      const error = 'MediaRecorder unavailable in this context';
      this.opts.onError(error);
      return {
        tier,
        text: '',
        confidence: 0,
        language: this.opts.language,
        latencyMs: 0,
        error,
      };
    }

    let stream: MediaStream;
    try {
      stream = await this.opts.getUserMedia({ audio: true, video: false });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.opts.onError(`mic denied: ${error}`);
      return { tier, text: '', confidence: 0, language: this.opts.language, latencyMs: 0, error };
    }
    this.activeStream = stream;

    let chunks: BlobPart[] = [];
    const rec = new this.opts.mediaRecorderCtor(stream);
    this.activeRecorder = rec;

    const blob: Blob = await new Promise((resolve) => {
      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        const type = chunks.length > 0 && chunks[0] instanceof Blob
          ? (chunks[0] as Blob).type || 'audio/webm'
          : 'audio/webm';
        resolve(new Blob(chunks, { type }));
      };
      try {
        rec.start();
      } catch (err) {
        this.opts.onError(`recorder start: ${String(err)}`);
        resolve(new Blob([], { type: 'audio/webm' }));
        return;
      }
      setTimeout(() => {
        try {
          rec.stop();
        } catch {
          // already stopped — ignore
        }
      }, durationMs);
    });

    stream.getTracks().forEach((t) => t.stop());
    this.activeStream = null;
    this.activeRecorder = null;

    // Invariant (RCA + security-adjacent): clear the local chunk buffer as soon
    // as the Blob is constructed so raw PCM/WebM never outlives the request.
    chunks = [];

    if (blob.size === 0) {
      const error = 'recording-empty';
      this.opts.onError(error);
      return { tier, text: '', confidence: 0, language: this.opts.language, latencyMs: nowMs() - started, error };
    }

    const arrayBuf = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    // Encode to base64 for message transport (chrome.runtime.sendMessage is
    // JSON-serialized — binary goes through as an array otherwise).
    const b64 = bytesToBase64(bytes);

    let response: unknown;
    try {
      response = await this.opts.sendMessage({
        type: 'INDIC_WHISPER_TRANSCRIBE',
        payload: {
          audioBase64: b64,
          mime: blob.type || 'audio/webm',
          language: this.opts.language,
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.opts.onError(`transcribe bg: ${error}`);
      return { tier, text: '', confidence: 0, language: this.opts.language, latencyMs: nowMs() - started, error };
    }

    const r = response as {
      ok?: boolean;
      text?: string;
      confidence?: number;
      language?: string;
      latencyMs?: number;
      error?: string;
    } | null | undefined;
    if (!r || r.ok === false) {
      const error = r?.error ?? 'no-response';
      return { tier, text: '', confidence: 0, language: this.opts.language, latencyMs: nowMs() - started, error };
    }

    const outcome: TranscriptionOutcome = {
      tier,
      text: r.text ?? '',
      confidence: typeof r.confidence === 'number' ? r.confidence : 0,
      language: r.language ?? this.opts.language,
      latencyMs: typeof r.latencyMs === 'number' ? r.latencyMs : nowMs() - started,
    };
    this.opts.onTranscription(outcome);
    return outcome;
  }

  /** Stop any in-flight recording and release the mic. */
  abort(): void {
    try {
      this.activeRecorder?.stop();
    } catch {
      // ignore
    }
    this.activeStream?.getTracks().forEach((t) => t.stop());
    this.activeRecorder = null;
    this.activeStream = null;
  }

  /** For tests + debug UI. */
  getRecentConfidences(): readonly number[] {
    return this.recentConfidences;
  }

  getCurrentTier(): VoiceTier {
    return this.currentTier;
  }
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid "Maximum call stack" on large audio buffers.
  const CHUNK = 0x8000;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    result += String.fromCharCode(...sub);
  }
  if (typeof btoa === 'function') return btoa(result);
  // Node fallback — tests run in jsdom which has btoa, but be defensive.
  return Buffer.from(result, 'binary').toString('base64');
}
