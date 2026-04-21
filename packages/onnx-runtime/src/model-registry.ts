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
// --- Session 17: Indic Whisper STT ---
export const INDIC_WHISPER_ID = 'indic-whisper-small';
// --- Session 23: Moondream2 Vision-Language ---
export const MOONDREAM_VISION_ID = 'moondream2-int8';
export const MOONDREAM_TEXT_ID = 'moondream2-text-int8';

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
  // --- Session 17: Indic Whisper STT ---
  // Upstream: openai/whisper-small (MIT, 99-language multilingual incl. all
  // 22 Indian languages). Branded indic-whisper-* on disk for AccessBridge
  // spec compatibility + future swap to AI4Bharat IndicConformer without
  // caller churn. Sha null until tools/prepare-models/download-indicwhisper.py
  // runs + upload-to-vps.sh + compute-hashes.sh populates it.
  [INDIC_WHISPER_ID]: {
    id: INDIC_WHISPER_ID,
    version: 'v1',
    url: `${VPS_MODEL_BASE}/indic-whisper-small-int8.onnx`,
    bundledPath: null,
    sha256: null,
    sizeBytes: 80 * 1024 * 1024,
    loadTier: 3,
    inputNames: ['input_features'],
    outputNames: ['last_hidden_state'],
    description:
      'Whisper-small int8: STT for 22 Indian languages (decoder loop deferred to Session 18).',
    tokenizer: {
      url: `${VPS_MODEL_BASE}/indic-whisper-tokenizer.json`,
      bundledPath: null,
      sha256: null,
      sizeBytes: 2 * 1024 * 1024,
    },
  },
  // --- Session 23: Moondream2 Vision-Language ---
  // Vision encoder (Apache 2.0, Xenova ONNX port). SHA-256 null until
  // tools/prepare-models/download-moondream.py uploads + compute-hashes.sh runs.
  [MOONDREAM_VISION_ID]: {
    id: MOONDREAM_VISION_ID,
    version: 'v1',
    url: `${VPS_MODEL_BASE}/moondream2-vision-int8.onnx`,
    bundledPath: null,
    sha256: null,
    sizeBytes: 90 * 1024 * 1024,
    loadTier: 4,
    inputNames: ['pixel_values'],
    outputNames: ['image_embeds'],
    description:
      'Moondream2 INT8 vision encoder (Apache 2.0, Xenova port). Pairs with text decoder for on-device semantic element captioning.',
    tokenizer: {
      url: `${VPS_MODEL_BASE}/moondream2-tokenizer.json`,
      bundledPath: null,
      sha256: null,
      sizeBytes: 2 * 1024 * 1024,
    },
  },
  [MOONDREAM_TEXT_ID]: {
    id: MOONDREAM_TEXT_ID,
    version: 'v1',
    url: `${VPS_MODEL_BASE}/moondream2-text-int8.onnx`,
    bundledPath: null,
    sha256: null,
    sizeBytes: 90 * 1024 * 1024,
    loadTier: 4,
    inputNames: ['input_ids', 'image_embeds'],
    outputNames: ['logits'],
    description:
      'Moondream2 INT8 text decoder. Conditioned on image_embeds from the vision encoder for greedy-decode captioning.',
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
  3: 'Voice STT (IndicWhisper)',
  4: 'Vision-Language (Moondream2)',
};

export const TIER_DESCRIPTIONS: Record<ModelTier, string> = {
  0: 'Always-on baseline classifier (~0.9 MB, bundled). Loads instantly at startup.',
  1: 'On-demand semantic embeddings (~22 MB, downloads from CDN).',
  2: 'On-demand abstractive summarization (~242 MB). Deferred to Session 15.',
  3: 'On-demand 22-language voice STT (~80 MB). Opt-in download; decoder loop Session 18.',
  4: 'On-device vision-language model for semantic element recovery (~180 MB, opt-in download). Tier 3 of the vision-recovery waterfall.',
};
