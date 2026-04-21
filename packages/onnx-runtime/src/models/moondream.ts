/**
 * MoondreamVision — Tier-4 on-device vision-language wrapper.
 *
 * Wraps the Moondream2 INT8 ONNX split (Xenova port, Apache 2.0):
 *   - Vision encoder  (`moondream2-int8`)        — pixel_values → image_embeds
 *   - Text decoder    (`moondream2-text-int8`)    — input_ids + image_embeds → logits
 *
 * The full pipeline:
 *   1. Resize ImageData to 378×378 (letterbox via image-preprocessor).
 *   2. Normalize with ImageNet means/std → CHW Float32Array (pixel_values).
 *   3. Vision encoder run → image_embeds tensor.
 *   4. Stub-tokenize the prompt (returns a fixed token sequence until real
 *      tokenizer ships); run text decoder conditioned on image_embeds.
 *   5. Greedy-decode up to 32 tokens; pull logits → caption string.
 *   6. Map caption keywords → ARIA role; condense to inferredLabel.
 *
 * Session 23 ships the contract + null paths. Real Moondream weights are
 * downloaded separately via tools/prepare-models/download-moondream.py.
 * Until they exist, describeElement returns a structured stub result so the
 * vision-recovery waterfall (Feature #5 Tier 3) can be wired end-to-end.
 *
 * Design notes (same pattern as minilm-embeddings.ts / indic-whisper.ts):
 *   - Injectable session loaders → tests mock without onnxruntime-web.
 *   - Null-safe load path: load() returns {ok:false} when any session fails.
 *   - Singleton-unload: unload() releases both sessions.
 *   - Proto-pollution guard: Object.prototype.hasOwnProperty.call, not `in`.
 */

import type { InferenceSessionLike, TensorLike } from '../types.js';
import { resize, normalize } from './image-preprocessor.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VisionDescription {
  caption: string;
  role: 'button' | 'link' | 'icon' | 'image' | 'unknown';
  inferredLabel: string;
  confidence: number;
  latencyMs: number;
}

export interface MoondreamLoadOptions {
  onProgress?: (p: { loaded: number; total: number; percent: number }) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Moondream2 expects 378×378 input. */
const INPUT_SIZE = 378;

/** ImageNet normalisation constants. */
const IMAGENET_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406];
const IMAGENET_STD: readonly [number, number, number] = [0.229, 0.224, 0.225];

/** Max greedy-decode steps. */
const MAX_DECODE_TOKENS = 32;

/** Maximum sane image dimension. */
const MAX_IMAGE_DIM = 4096;

/** Batch ceiling — never more than 4 concurrent describe calls. */
const BATCH_SIZE = 4;

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface MoondreamDeps {
  /** Returns a loaded vision-encoder InferenceSessionLike, or null if unavailable. */
  loadVisionSession: () => Promise<InferenceSessionLike | null>;
  /** Returns a loaded text-decoder InferenceSessionLike, or null if unavailable. */
  loadTextSession: () => Promise<InferenceSessionLike | null>;
  /** Wall-clock in ms — injectable for tests. */
  now?: () => number;
  /** Diagnostic logger — injectable for tests. */
  logger?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// MoondreamVision
// ---------------------------------------------------------------------------

export class MoondreamVision {
  private visionSession: InferenceSessionLike | null = null;
  private textSession: InferenceSessionLike | null = null;
  private readonly deps: Required<MoondreamDeps>;

  constructor(deps: MoondreamDeps) {
    this.deps = {
      loadVisionSession: deps.loadVisionSession,
      loadTextSession: deps.loadTextSession,
      now: deps.now ?? defaultNow,
      logger: deps.logger ?? (() => { /* no-op */ }),
    };
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  /**
   * Load both sessions (vision encoder + text decoder).
   * Progress is reported at 0–50% while the vision session loads, 50–100%
   * for the text session. Returns {ok:false, error:'ort-unavailable'} if
   * either session fails to initialise.
   */
  async load(options?: MoondreamLoadOptions): Promise<{ ok: boolean; error?: string }> {
    const onProgress = options?.onProgress;

    // Report initial progress.
    onProgress?.({ loaded: 0, total: 2, percent: 0 });

    this.deps.logger('[MoondreamVision] loading vision encoder...');
    const visionSess = await this.deps.loadVisionSession();
    if (!visionSess) {
      this.deps.logger('[MoondreamVision] vision encoder unavailable');
      return { ok: false, error: 'ort-unavailable' };
    }
    this.visionSession = visionSess;
    onProgress?.({ loaded: 1, total: 2, percent: 50 });

    this.deps.logger('[MoondreamVision] loading text decoder...');
    const textSess = await this.deps.loadTextSession();
    if (!textSess) {
      this.deps.logger('[MoondreamVision] text decoder unavailable');
      // Release already-loaded vision session to avoid leak.
      this.visionSession?.release?.();
      this.visionSession = null;
      return { ok: false, error: 'ort-unavailable' };
    }
    this.textSession = textSess;
    onProgress?.({ loaded: 2, total: 2, percent: 100 });

    this.deps.logger('[MoondreamVision] both sessions ready');
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // isLoaded
  // -------------------------------------------------------------------------

  isLoaded(): boolean {
    return this.visionSession !== null && this.textSession !== null;
  }

  // -------------------------------------------------------------------------
  // describeElement
  // -------------------------------------------------------------------------

  /**
   * Produce a VisionDescription for a single ImageData element snapshot.
   *
   * Returns null when:
   *   - Sessions not loaded.
   *   - ImageData is 0×0 or exceeds MAX_IMAGE_DIM in either dimension.
   *   - Any inference step throws.
   */
  async describeElement(
    image: ImageData,
    prompt: string,
  ): Promise<VisionDescription | null> {
    if (!this.visionSession || !this.textSession) return null;
    if (image.width <= 0 || image.height <= 0) return null;
    if (image.width > MAX_IMAGE_DIM || image.height > MAX_IMAGE_DIM) return null;

    const started = this.deps.now();

    try {
      // 1. Resize to 378×378 (letterbox).
      const resized = resize(image, INPUT_SIZE, INPUT_SIZE);

      // 2. Normalize → CHW Float32 tensor (1 × 3 × 378 × 378).
      const chw = normalize(resized, IMAGENET_MEAN, IMAGENET_STD);
      const pixelValues: TensorLike = {
        type: 'float32',
        data: chw,
        dims: [1, 3, INPUT_SIZE, INPUT_SIZE],
      };

      // 3. Vision encoder → image_embeds.
      const visionOut = await this.visionSession.run({ pixel_values: pixelValues });
      const imageEmbeds = visionOut['image_embeds'];
      if (!imageEmbeds) return null;

      // 4. Stub-tokenize prompt (placeholder until real tokenizer ships).
      const inputIds = stubTokenize(prompt);
      const inputIdsTensor: TensorLike = {
        type: 'int32',
        data: new Int32Array(inputIds),
        dims: [1, inputIds.length],
      };

      // 5. Text decoder — greedy decode up to MAX_DECODE_TOKENS.
      let caption = '';
      let confidence = 0.5;

      for (let step = 0; step < MAX_DECODE_TOKENS; step++) {
        const decOut = await this.textSession.run({
          input_ids: inputIdsTensor,
          image_embeds: imageEmbeds,
        });

        const logits = decOut['logits'];
        if (!logits) break;

        // Pick the argmax token at the last position.
        const { token, maxProb } = greedyArgmax(logits);
        if (step === 0) confidence = maxProb;

        // EOS token (1) or padding (0) → stop.
        if (token === 0 || token === 1) break;

        caption += detokenStub(token);
      }

      // Fallback caption when decoder returned empty.
      if (caption.length === 0) caption = 'mocked-caption';

      const latencyMs = Math.max(0, this.deps.now() - started);

      return {
        caption,
        role: mapRole(caption),
        inferredLabel: makeLabel(caption),
        confidence,
        latencyMs,
      };
    } catch (err) {
      this.deps.logger(`[MoondreamVision] inference error: ${String(err)}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // describeBatch
  // -------------------------------------------------------------------------

  /**
   * Describe multiple images, batched by BATCH_SIZE (4).
   * Never more than BATCH_SIZE concurrent describe calls.
   */
  async describeBatch(
    images: ImageData[],
    prompt: string,
  ): Promise<Array<VisionDescription | null>> {
    if (images.length === 0) return [];

    const results: Array<VisionDescription | null> = new Array(images.length).fill(null);

    for (let i = 0; i < images.length; i += BATCH_SIZE) {
      const batchSlice = images.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batchSlice.map((img) => this.describeElement(img, prompt)),
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // unload
  // -------------------------------------------------------------------------

  unload(): void {
    this.visionSession?.release?.();
    this.textSession?.release?.();
    this.visionSession = null;
    this.textSession = null;
    this.deps.logger('[MoondreamVision] sessions released');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Minimal stub tokenizer — returns a fixed small token array representing the
 * prompt. Real tokenizer (moondream2-tokenizer.json) lands in Session 24.
 */
function stubTokenize(prompt: string): number[] {
  // One token per word, mapped to char-code of first char + 100. Deterministic.
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [2]; // BOS
  return [2, ...words.map((w) => (w.charCodeAt(0) % 1000) + 100), 3];
}

/**
 * Greedy argmax over the last-position logits in a [1, seq, vocab] or [1, vocab] tensor.
 * Returns the winning token id and its softmax max probability.
 */
function greedyArgmax(logits: TensorLike): { token: number; maxProb: number } {
  const data = logits.data as Float32Array | Int32Array;
  const dims = logits.dims;

  // Support shapes [1, seq, vocab] and [1, vocab].
  let vocabSize: number;
  let offset: number;

  if (dims.length === 3) {
    const seq = dims[1];
    vocabSize = dims[2];
    offset = (seq - 1) * vocabSize; // last token position
  } else if (dims.length === 2) {
    vocabSize = dims[1];
    offset = 0;
  } else {
    vocabSize = data.length;
    offset = 0;
  }

  let maxVal = -Infinity;
  let maxIdx = 0;
  for (let i = 0; i < vocabSize && offset + i < data.length; i++) {
    const v = Number(data[offset + i]);
    if (v > maxVal) {
      maxVal = v;
      maxIdx = i;
    }
  }

  // Softmax over the range to compute a probability estimate.
  // For efficiency we use a numerically stable 2-pass only if small vocab.
  const maxProb = vocabSize <= 50000
    ? softmaxMaxProb(data, offset, vocabSize)
    : 0.5;

  return { token: maxIdx, maxProb };
}

function softmaxMaxProb(data: Float32Array | Int32Array, offset: number, vocabSize: number): number {
  let maxLogit = -Infinity;
  for (let i = 0; i < vocabSize && offset + i < data.length; i++) {
    const v = Number(data[offset + i]);
    if (v > maxLogit) maxLogit = v;
  }
  let sumExp = 0;
  let maxExp = 0;
  for (let i = 0; i < vocabSize && offset + i < data.length; i++) {
    const e = Math.exp(Number(data[offset + i]) - maxLogit);
    sumExp += e;
    if (i === 0 || Number(data[offset + i]) - maxLogit > Math.log(maxExp || 1e-38)) maxExp = e;
  }
  // maxExp is exp(maxLogit - maxLogit) = 1 always. Return 1/sumExp.
  return sumExp > 0 ? 1 / sumExp : 0.5;
}

/**
 * Map a stub token id to a single character for the caption stub.
 * In production this would be a real BPE decode step.
 */
function detokenStub(token: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz ';
  return chars[token % chars.length];
}

// ---------------------------------------------------------------------------
// Role mapping  (< 20 lines)
// ---------------------------------------------------------------------------

const ROLE_PATTERNS: Array<[RegExp, VisionDescription['role']]> = [
  [/button/i, 'button'],
  [/link|url/i, 'link'],
  [/icon|arrow|menu/i, 'icon'],
  [/image|photo/i, 'image'],
];

function mapRole(caption: string): VisionDescription['role'] {
  for (const [re, role] of ROLE_PATTERNS) {
    if (re.test(caption)) return role;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// inferredLabel — 1-3 words, ≤ 40 chars
// ---------------------------------------------------------------------------

function makeLabel(caption: string): string {
  const words = caption.trim().split(/\s+/).filter(Boolean);
  let label = '';
  for (const word of words) {
    const candidate = label ? `${label} ${word}` : word;
    if (candidate.length > 40) break;
    label = candidate;
    if (label.split(' ').length >= 3) break;
  }
  return label || caption.slice(0, 40);
}
