import { describe, it, expect } from 'vitest';
import { SemanticVocabulary, cosineSimilarity } from '../recovery.js';
import type { LabelEmbedder, RecoveredLabel, UnlabeledElement } from '../types.js';

function rec(label: string): RecoveredLabel {
  const el: UnlabeledElement = {
    nodeHint: 'button',
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    computedRole: 'button',
    currentAriaLabel: null,
    textContent: '',
    siblingContext: '',
    classSignature: 'cs',
    backgroundImageUrl: null,
  };
  return {
    element: el,
    inferredRole: 'button',
    inferredLabel: label,
    inferredDescription: label,
    confidence: 0.8,
    source: 'on-device-vlm',
    tier: 3,
  };
}

function unitVec(angleDeg: number): Float32Array {
  const r = (angleDeg * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0]);
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const a = unitVec(0);
    const b = unitVec(0);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = unitVec(0);
    const b = unitVec(90);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('returns -1 for antiparallel vectors', () => {
    const a = unitVec(0);
    const b = unitVec(180);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it('returns 0 when lengths differ', () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toBe(0);
  });

  it('returns 0 on zero-length vectors', () => {
    expect(cosineSimilarity(new Float32Array([0, 0, 0]), new Float32Array([1, 2, 3]))).toBe(0);
  });
});

describe('SemanticVocabulary', () => {
  it('null embedder → register + findSimilar are no-ops', async () => {
    const vocab = new SemanticVocabulary(null, 0.5);
    await vocab.register(rec('submit'), 'v1');
    const r = await vocab.findSimilar(rec('submit'), 'v1');
    expect(r).toBeNull();
    expect(vocab.size('v1')).toBe(0);
  });

  it('embedder returning null → registration is no-op', async () => {
    const embedder: LabelEmbedder = { embed: async () => null };
    const vocab = new SemanticVocabulary(embedder, 0.5);
    await vocab.register(rec('submit'), 'v1');
    expect(vocab.size('v1')).toBe(0);
  });

  it('similar labels collapse via findSimilar', async () => {
    const vec = new Float32Array([1, 0, 0]);
    const embedder: LabelEmbedder = { embed: async () => vec };
    const vocab = new SemanticVocabulary(embedder, 0.5);
    await vocab.register(rec('submit button'), 'v1');
    const match = await vocab.findSimilar(rec('submit'), 'v1');
    expect(match).not.toBeNull();
    expect(match?.inferredLabel).toBe('submit button');
  });

  it('below threshold → no match', async () => {
    let toggle = 0;
    const embedder: LabelEmbedder = {
      embed: async () => (toggle++ === 0 ? new Float32Array([1, 0, 0]) : new Float32Array([0, 1, 0])),
    };
    const vocab = new SemanticVocabulary(embedder, 0.5);
    await vocab.register(rec('submit'), 'v1');
    const match = await vocab.findSimilar(rec('dismiss'), 'v1');
    expect(match).toBeNull();
  });

  it('per-app namespacing — v1 labels invisible to v2 lookups', async () => {
    const embedder: LabelEmbedder = { embed: async () => new Float32Array([1, 0, 0]) };
    const vocab = new SemanticVocabulary(embedder, 0.5);
    await vocab.register(rec('submit'), 'v1');
    const match = await vocab.findSimilar(rec('submit'), 'v2');
    expect(match).toBeNull();
  });

  it('appVersion lookup is case-insensitive (same app, mixed case)', async () => {
    const embedder: LabelEmbedder = { embed: async () => new Float32Array([1, 0, 0]) };
    const vocab = new SemanticVocabulary(embedder, 0.5);
    await vocab.register(rec('submit'), 'Gmail.v2');
    const match = await vocab.findSimilar(rec('submit'), 'GMAIL.V2');
    expect(match).not.toBeNull();
  });

  it('clear empties all vocab entries', async () => {
    const embedder: LabelEmbedder = { embed: async () => new Float32Array([1, 0, 0]) };
    const vocab = new SemanticVocabulary(embedder, 0.5);
    await vocab.register(rec('submit'), 'v1');
    vocab.clear();
    expect(vocab.size('v1')).toBe(0);
  });

  it('embedder throwing mid-register → registration no-op, no throw bubbles up', async () => {
    const embedder: LabelEmbedder = {
      embed: async () => {
        throw new Error('boom');
      },
    };
    const vocab = new SemanticVocabulary(embedder, 0.5);
    await expect(vocab.register(rec('submit'), 'v1')).resolves.toBeUndefined();
    expect(vocab.size('v1')).toBe(0);
  });

  it('capped at MAX_ENTRIES_PER_APP (LRU eviction)', async () => {
    const embedder: LabelEmbedder = { embed: async () => new Float32Array([Math.random(), Math.random(), Math.random()]) };
    const vocab = new SemanticVocabulary(embedder, 0.5);
    const N = SemanticVocabulary.MAX_ENTRIES_PER_APP + 20;
    for (let i = 0; i < N; i++) await vocab.register(rec('l' + i), 'v1');
    expect(vocab.size('v1')).toBeLessThanOrEqual(SemanticVocabulary.MAX_ENTRIES_PER_APP);
  });
});
