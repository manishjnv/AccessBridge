/**
 * Session 12 — model registry lookup contract.
 */

import { describe, it, expect } from 'vitest';
import {
  MODEL_REGISTRY,
  STRUGGLE_CLASSIFIER_ID,
  MINILM_EMBEDDINGS_ID,
  T5_SUMMARIZER_ID,
  INDIC_WHISPER_ID,
  MOONDREAM_VISION_ID,
  MOONDREAM_TEXT_ID,
  TIER_LABELS,
  TIER_DESCRIPTIONS,
  getModelMetadata,
  getModelsForTier,
} from '../model-registry.js';

describe('model-registry', () => {
  it('has exactly six canonical models keyed by their ids (Session 23 adds Moondream2 vision+text)', () => {
    const keys = Object.keys(MODEL_REGISTRY).sort();
    expect(keys).toEqual(
      [
        STRUGGLE_CLASSIFIER_ID,
        MINILM_EMBEDDINGS_ID,
        T5_SUMMARIZER_ID,
        INDIC_WHISPER_ID,
        MOONDREAM_VISION_ID,
        MOONDREAM_TEXT_ID,
      ].sort(),
    );
  });

  it('each model has one entry per tier (0, 1, 2, 3, 4)', () => {
    expect(MODEL_REGISTRY[STRUGGLE_CLASSIFIER_ID].loadTier).toBe(0);
    expect(MODEL_REGISTRY[MINILM_EMBEDDINGS_ID].loadTier).toBe(1);
    expect(MODEL_REGISTRY[T5_SUMMARIZER_ID].loadTier).toBe(2);
    expect(MODEL_REGISTRY[INDIC_WHISPER_ID].loadTier).toBe(3);
    expect(MODEL_REGISTRY[MOONDREAM_VISION_ID].loadTier).toBe(4);
    expect(MODEL_REGISTRY[MOONDREAM_TEXT_ID].loadTier).toBe(4);
  });

  it('every URL is a VPS CDN path (port 8300), never the raw api port', () => {
    for (const model of Object.values(MODEL_REGISTRY)) {
      expect(model.url).toMatch(/72\.61\.227\.64:8300\/models\//);
      // Must NOT hit port 8100 (api) or 8200 (observatory)
      expect(model.url).not.toMatch(/:8100/);
      expect(model.url).not.toMatch(/:8200/);
    }
  });

  it('Tier 0 (struggle-classifier) has a real sha256 hex and a bundledPath', () => {
    const m = MODEL_REGISTRY[STRUGGLE_CLASSIFIER_ID];
    expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.bundledPath).toBe('models/struggle-classifier-v1.onnx');
  });

  it('Tier 1 (minilm-l6-v2) has a real sha256 hex, no bundledPath, and a tokenizer with sha256', () => {
    const m = MODEL_REGISTRY[MINILM_EMBEDDINGS_ID];
    expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.bundledPath).toBeNull();
    expect(m.tokenizer).toBeDefined();
    expect(m.tokenizer).toHaveProperty('url');
    expect(m.tokenizer).toHaveProperty('sizeBytes');
    expect((m.tokenizer as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('Tier 2 (t5-small) still has sha256: null and no bundledPath (deferred to Session 15)', () => {
    const m = MODEL_REGISTRY[T5_SUMMARIZER_ID];
    expect(m.sha256).toBeNull();
    expect(m.bundledPath).toBeNull();
  });

  it('getModelMetadata returns the right entry for a known id', () => {
    const meta = getModelMetadata(STRUGGLE_CLASSIFIER_ID);
    expect(meta).not.toBeNull();
    expect(meta!.loadTier).toBe(0);
    expect(meta!.inputNames).toContain('features');
  });

  it('getModelMetadata returns null for unknown ids', () => {
    expect(getModelMetadata('bogus-model')).toBeNull();
    expect(getModelMetadata('')).toBeNull();
  });

  it('getModelsForTier filters correctly', () => {
    const tier0 = getModelsForTier(0);
    const tier1 = getModelsForTier(1);
    const tier2 = getModelsForTier(2);
    const tier3 = getModelsForTier(3);
    const tier4 = getModelsForTier(4);
    expect(tier0).toHaveLength(1);
    expect(tier1).toHaveLength(1);
    expect(tier2).toHaveLength(1);
    expect(tier3).toHaveLength(1);
    expect(tier4).toHaveLength(2); // Moondream vision + text
    expect(tier0[0].id).toBe(STRUGGLE_CLASSIFIER_ID);
    expect(tier1[0].id).toBe(MINILM_EMBEDDINGS_ID);
    expect(tier2[0].id).toBe(T5_SUMMARIZER_ID);
    expect(tier3[0].id).toBe(INDIC_WHISPER_ID);
    const tier4Ids = tier4.map((m) => m.id).sort();
    expect(tier4Ids).toEqual([MOONDREAM_TEXT_ID, MOONDREAM_VISION_ID].sort());
  });

  it('tier labels + descriptions cover all five tiers', () => {
    for (const tier of [0, 1, 2, 3, 4] as const) {
      expect(typeof TIER_LABELS[tier]).toBe('string');
      expect(TIER_LABELS[tier].length).toBeGreaterThan(0);
      expect(typeof TIER_DESCRIPTIONS[tier]).toBe('string');
      expect(TIER_DESCRIPTIONS[tier].length).toBeGreaterThan(0);
    }
  });

  it('Tier 4 (Moondream2) has null sha256 pending upload + loadTier 4', () => {
    const v = MODEL_REGISTRY[MOONDREAM_VISION_ID];
    const t = MODEL_REGISTRY[MOONDREAM_TEXT_ID];
    expect(v.sha256).toBeNull();
    expect(t.sha256).toBeNull();
    expect(v.bundledPath).toBeNull();
    expect(t.bundledPath).toBeNull();
    expect(v.loadTier).toBe(4);
    expect(t.loadTier).toBe(4);
  });

  it('Tier 3 (indic-whisper-small) has null sha256 and tokenizer metadata pending upload', () => {
    const m = MODEL_REGISTRY[INDIC_WHISPER_ID];
    expect(m.sha256).toBeNull();
    expect(m.bundledPath).toBeNull();
    expect(m.tokenizer).toBeDefined();
    expect(m.tokenizer?.url).toMatch(/indic-whisper-tokenizer\.json$/);
  });
});
