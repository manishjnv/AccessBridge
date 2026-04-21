/**
 * T5Summarizer — wraps the Tier-2 T5-small quantized ONNX.
 *
 * Full beam-search decoding requires:
 *   - SentencePiece tokenizer (BPE vocab as JSON/TS data).
 *   - Autoregressive decode loop with past-key-value caching.
 *   - Beam-width 4 is the hackathon default.
 *
 * The MVP wiring is intentionally incomplete: the runtime side-loads
 * the .onnx bytes, caches them, and exposes a session, but the TS
 * decode loop is not implemented. `summarize()` returns null when
 * no model is loaded so LocalAIProvider.summarize() falls back to
 * the existing extractive sentence-scoring summarizer.
 */

import type { ONNXRuntime } from '../runtime.js';
import { T5_SUMMARIZER_ID } from '../model-registry.js';

export interface SummarizeOptions {
  maxLength: number;
  beams?: number;
}

export class T5Summarizer {
  constructor(
    private readonly runtime: ONNXRuntime,
    private readonly modelId: string = T5_SUMMARIZER_ID,
  ) {}

  async load(
    onProgress?: (p: { percent: number }) => void,
  ): Promise<boolean> {
    const r = await this.runtime.loadModel(this.modelId, onProgress);
    return r.ok;
  }

  ready(): boolean {
    return this.runtime.hasModel(this.modelId);
  }

  /**
   * Produce an abstractive summary, or null when no model is loaded.
   * TODO(session-13): wire SentencePiece tokenizer + beam-search decode loop.
   */
  async summarize(
    text: string,
    options: SummarizeOptions,
  ): Promise<string | null> {
    const session = this.runtime.getModel(this.modelId);
    if (!session) return null;
    if (typeof text !== 'string' || text.length === 0) return null;
    if (!Number.isFinite(options.maxLength) || options.maxLength <= 0) {
      return null;
    }
    this.runtime.recordFallback();
    return null;
  }
}
