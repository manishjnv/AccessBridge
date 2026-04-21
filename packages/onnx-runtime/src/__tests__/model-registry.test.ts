/**
 * Session 12 — model registry lookup contract.
 */

import { describe, it, expect } from 'vitest';
import {
  MODEL_REGISTRY,
  STRUGGLE_CLASSIFIER_ID,
  MINILM_EMBEDDINGS_ID,
  T5_SUMMARIZER_ID,
  TIER_LABELS,
  TIER_DESCRIPTIONS,
  getModelMetadata,
  getModelsForTier,
} from '../model-registry.js';

describe('model-registry', () => {
  it('has exactly three canonical models keyed by their ids', () => {
    const keys = Object.keys(MODEL_REGISTRY).sort();
    expect(keys).toEqual(
      [STRUGGLE_CLASSIFIER_ID, MINILM_EMBEDDINGS_ID, T5_SUMMARIZER_ID].sort(),
    );
  });

  it('each model has one entry per tier (0, 1, 2)', () => {
    expect(MODEL_REGISTRY[STRUGGLE_CLASSIFIER_ID].loadTier).toBe(0);
    expect(MODEL_REGISTRY[MINILM_EMBEDDINGS_ID].loadTier).toBe(1);
    expect(MODEL_REGISTRY[T5_SUMMARIZER_ID].loadTier).toBe(2);
  });

  it('every URL is a VPS CDN path (port 8300), never the raw api port', () => {
    for (const model of Object.values(MODEL_REGISTRY)) {
      expect(model.url).toMatch(/72\.61\.227\.64:8300\/models\//);
      // Must NOT hit port 8100 (api) or 8200 (observatory)
      expect(model.url).not.toMatch(/:8100/);
      expect(model.url).not.toMatch(/:8200/);
    }
  });

  it('MVP ships no sha256 hashes yet — real weights gate on hash presence', () => {
    // When real weights ship, populate MODEL_REGISTRY[id].sha256 + update this test.
    for (const model of Object.values(MODEL_REGISTRY)) {
      expect(model.sha256).toBeNull();
    }
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
    expect(tier0).toHaveLength(1);
    expect(tier1).toHaveLength(1);
    expect(tier2).toHaveLength(1);
    expect(tier0[0].id).toBe(STRUGGLE_CLASSIFIER_ID);
    expect(tier1[0].id).toBe(MINILM_EMBEDDINGS_ID);
    expect(tier2[0].id).toBe(T5_SUMMARIZER_ID);
  });

  it('tier labels + descriptions cover all three tiers', () => {
    for (const tier of [0, 1, 2] as const) {
      expect(typeof TIER_LABELS[tier]).toBe('string');
      expect(TIER_LABELS[tier].length).toBeGreaterThan(0);
      expect(typeof TIER_DESCRIPTIONS[tier]).toBe('string');
      expect(TIER_DESCRIPTIONS[tier].length).toBeGreaterThan(0);
    }
  });
});
