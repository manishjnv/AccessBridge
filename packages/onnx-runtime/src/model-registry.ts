/**
 * Static registry of on-device ONNX models the runtime knows how to fetch.
 *
 * Tier 0 — always-on classifier (small, loads on service-worker startup).
 * Tier 1 — on-demand embeddings (opt-in download).
 * Tier 2 — on-demand summarization (opt-in download).
 *
 * URLs point at the VPS nginx CDN (port 8300, same host as the version API).
 * `sha256` is intentionally null in the MVP — once the training/upload
 * pipeline publishes real weights, populate the hash here in the same
 * commit that ships the binary.
 */

import type { ModelMetadata, ModelTier } from './types.js';

const VPS_MODEL_BASE = 'http://72.61.227.64:8300/models';

export const STRUGGLE_CLASSIFIER_ID = 'struggle-classifier-v1';
export const MINILM_EMBEDDINGS_ID = 'minilm-l6-v2';
export const T5_SUMMARIZER_ID = 't5-small';

export const MODEL_REGISTRY: Record<string, ModelMetadata> = {
  [STRUGGLE_CLASSIFIER_ID]: {
    id: STRUGGLE_CLASSIFIER_ID,
    version: 'v1',
    url: `${VPS_MODEL_BASE}/struggle-classifier-v1.onnx`,
    bundledPath: null,
    sha256: null,
    sizeBytes: 3 * 1024 * 1024,
    loadTier: 0,
    inputNames: ['features'],
    outputNames: ['probabilities'],
    description:
      'XGBoost struggle classifier: 10 signal types × 6 rolling stats = 60 features → 4-bucket softmax.',
  },
  [MINILM_EMBEDDINGS_ID]: {
    id: MINILM_EMBEDDINGS_ID,
    version: 'v1',
    url: `${VPS_MODEL_BASE}/all-MiniLM-L6-v2.onnx`,
    bundledPath: null,
    sha256: null,
    sizeBytes: 80 * 1024 * 1024,
    loadTier: 1,
    inputNames: ['input_ids', 'attention_mask'],
    outputNames: ['last_hidden_state'],
    description:
      'all-MiniLM-L6-v2 quantized: 384-dim sentence embeddings for semantic cache + dedup.',
  },
  [T5_SUMMARIZER_ID]: {
    id: T5_SUMMARIZER_ID,
    version: 'v1',
    url: `${VPS_MODEL_BASE}/t5-small.onnx`,
    bundledPath: null,
    sha256: null,
    sizeBytes: 242 * 1024 * 1024,
    loadTier: 2,
    inputNames: ['input_ids'],
    outputNames: ['logits'],
    description:
      'T5-small quantized: abstractive summarization (beam-search decoding required).',
  },
};

export function getModelMetadata(id: string): ModelMetadata | null {
  return MODEL_REGISTRY[id] ?? null;
}

export function getModelsForTier(tier: ModelTier): ModelMetadata[] {
  return Object.values(MODEL_REGISTRY).filter((m) => m.loadTier === tier);
}

export const TIER_LABELS: Record<ModelTier, string> = {
  0: 'Struggle Classifier',
  1: 'Embeddings (MiniLM)',
  2: 'Summarizer (T5-small)',
};

export const TIER_DESCRIPTIONS: Record<ModelTier, string> = {
  0: 'Always-on baseline classifier (~3 MB). Loads automatically.',
  1: 'On-demand semantic embeddings (~80 MB).',
  2: 'On-demand abstractive summarization (~242 MB).',
};
