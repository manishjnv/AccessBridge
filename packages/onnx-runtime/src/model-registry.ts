/**
 * Static registry of on-device ONNX models the runtime knows how to fetch.
 *
 * Tier 0 — always-on classifier (bundled with the extension; no network fetch).
 * Tier 1 — on-demand embeddings (opt-in download from VPS CDN).
 * Tier 2 — on-demand summarization (opt-in download, still placeholder until
 *          the T5 beam-search decoder lands; hash intentionally null).
 *
 * Hashes + sizes for Tier 0 and Tier 1 were produced by
 * `tools/prepare-models/compute-hashes.sh` on 2026-04-21 and are pinned here
 * so any CDN tamper is detected at load time. The manifest that generated
 * these values lives at `tools/prepare-models/output/models-manifest.json`.
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
    // Ships bundled — runtime prefers the packaged URL so Tier 0 is offline.
    bundledPath: 'models/struggle-classifier-v1.onnx',
    sha256: '174695b3a7c3b2e1b42aa4ce72b827ea58e982954aa7a5fa434d2f780d810589',
    sizeBytes: 868691,
    loadTier: 0,
    inputNames: ['features'],
    // onnxmltools.convert_xgboost emits two heads: an argmax label (int64) and
    // the full softmax. Classifier code indexes by name to pick the probabilities.
    outputNames: ['label', 'probabilities'],
    description:
      'XGBoost struggle classifier: 10 signal types × 6 rolling stats = 60 features → 4-bucket softmax.',
  },
  [MINILM_EMBEDDINGS_ID]: {
    id: MINILM_EMBEDDINGS_ID,
    version: 'v1',
    url: `${VPS_MODEL_BASE}/all-MiniLM-L6-v2-int8.onnx`,
    bundledPath: null,
    sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
    sizeBytes: 22972370,
    loadTier: 1,
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: ['last_hidden_state'],
    description:
      'all-MiniLM-L6-v2 int8-quantized: 384-dim sentence embeddings for semantic cache + dedup.',
    tokenizer: {
      url: `${VPS_MODEL_BASE}/minilm-tokenizer.json`,
      bundledPath: null,
      sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
      sizeBytes: 711661,
    },
  },
  [T5_SUMMARIZER_ID]: {
    id: T5_SUMMARIZER_ID,
    version: 'v1',
    url: `${VPS_MODEL_BASE}/t5-small.onnx`,
    bundledPath: null,
    // Session 15 will upload T5 + ship the beam-search decoder. Until then
    // the null hash keeps the integrity gate armed — any tampered file fails
    // at load time once a real hash lands.
    sha256: null,
    sizeBytes: 242 * 1024 * 1024,
    loadTier: 2,
    inputNames: ['input_ids'],
    outputNames: ['logits'],
    description:
      'T5-small quantized: abstractive summarization (beam-search decoding required — deferred to Session 15).',
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
  0: 'Always-on baseline classifier (~0.9 MB, bundled). Loads instantly at startup.',
  1: 'On-demand semantic embeddings (~22 MB, downloads from CDN).',
  2: 'On-demand abstractive summarization (~242 MB). Deferred to Session 15.',
};
