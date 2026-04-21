/**
 * MiniLMEmbeddings — wraps the Tier-1 all-MiniLM-L6-v2 quantized ONNX.
 *
 * The real inference pipeline is:
 *   1. WordPiece-tokenize the input string.
 *   2. Build input_ids + attention_mask int64 tensors.
 *   3. session.run({input_ids, attention_mask}).
 *   4. Mean-pool the `last_hidden_state` along the token axis.
 *   5. L2-normalize the resulting 384-dim vector.
 *
 * The MVP wiring is intentionally incomplete: steps 1-4 require a
 * tokenizer (vocab.txt + WordPiece trie) and the real model bytes,
 * neither of which ships in this session. `embed()` returns null when
 * the model is not available; callers (LocalAIProvider.embed) then fall
 * back to a deterministic trigram pseudo-embedding.
 *
 * The L2-normalize helper is exported because both the real and pseudo
 * path share it.
 */

import type { ONNXRuntime } from '../runtime.js';
import { MINILM_EMBEDDINGS_ID } from '../model-registry.js';

export const MINILM_DIM = 384;

export class MiniLMEmbeddings {
  constructor(
    private readonly runtime: ONNXRuntime,
    private readonly modelId: string = MINILM_EMBEDDINGS_ID,
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
   * Produce a 384-dim L2-normalised embedding, or null if no model is loaded.
   * TODO(session-13): implement WordPiece tokenizer + mean-pool decode.
   */
  async embed(text: string): Promise<Float32Array | null> {
    const session = this.runtime.getModel(this.modelId);
    if (!session) return null;
    if (typeof text !== 'string' || text.length === 0) return null;

    // Placeholder — see module docstring. When weights + tokenizer ship:
    //   const { ids, mask } = tokenize(text);
    //   const run = await session.run({ input_ids: ids, attention_mask: mask });
    //   const hidden = run.last_hidden_state;
    //   const pooled = meanPool(hidden, mask);
    //   return l2normalize(pooled);
    this.runtime.recordFallback();
    return null;
  }
}

/** L2-normalize a vector in place and return it. */
export function l2normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm;
  return v;
}

/** Cosine similarity for two equal-length L2-normalized vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Deterministic trigram-hash pseudo-embedding used when no real model is
 * loaded.  Matches the 384-dim shape so downstream code (semantic cache
 * buckets, cosine similarity) never needs to branch on "real vs. fake".
 */
export function pseudoEmbedding(text: string, dim = MINILM_DIM): Float32Array {
  const v = new Float32Array(dim);
  const lower = text.toLowerCase();
  if (lower.length < 3) {
    // Pad short inputs by character.
    for (let i = 0; i < lower.length; i++) {
      const idx = lower.charCodeAt(i) % dim;
      v[idx] += 1;
    }
    return l2normalize(v);
  }
  for (let i = 0; i <= lower.length - 3; i++) {
    const h = hashTrigram(lower.charCodeAt(i), lower.charCodeAt(i + 1), lower.charCodeAt(i + 2));
    v[h % dim] += 1;
  }
  return l2normalize(v);
}

function hashTrigram(a: number, b: number, c: number): number {
  let h = 2166136261 ^ a;
  h = Math.imul(h, 16777619) ^ b;
  h = Math.imul(h, 16777619) ^ c;
  h = Math.imul(h, 16777619);
  // Convert to unsigned 32-bit
  return h >>> 0;
}
