import type { RecoveredLabel, LabelEmbedder } from './types.js';

interface VocabEntry {
  embedding: Float32Array;
  recovered: RecoveredLabel;
  lastSeenAt: number;
}

/**
 * Builds a per-app "semantic vocabulary" of recovered labels.
 *
 * When a new Tier-3 (or Tier-2) label is produced, the engine asks this
 * vocabulary whether the new caption is already covered by a prior label
 * (cosine ≥ threshold). If yes, the engine returns the prior label with
 * source='semantic-similar' instead of treating the two labels as distinct
 * semantic tokens. This stabilises UI naming across repeated visits to the
 * same app without burning a fresh Tier-3 inference each time.
 *
 * Graceful-fallback invariants:
 *  - If `embedder` is null, every call becomes a no-op (register stores
 *    nothing, findSimilar returns null). Engine still works; no convergence.
 *  - If `embedder.embed(...)` returns null, that single call becomes a no-op.
 *  - Size bound: MAX_ENTRIES_PER_APP entries per (appVersion, domainKey);
 *    LRU eviction on write.
 */
export class SemanticVocabulary {
  private readonly embedder: LabelEmbedder | null;
  private readonly threshold: number;
  private readonly perApp: Map<string, VocabEntry[]> = new Map();

  static readonly MAX_ENTRIES_PER_APP = 512;

  constructor(embedder: LabelEmbedder | null, threshold: number) {
    this.embedder = embedder;
    this.threshold = threshold;
  }

  async register(recovered: RecoveredLabel, appVersion: string): Promise<void> {
    if (this.embedder === null) return;
    const text = this.textFor(recovered);
    if (text.length === 0) return;
    let embedding: Float32Array | null;
    try {
      embedding = await this.embedder.embed(text);
    } catch {
      return;
    }
    if (embedding === null || embedding.length === 0) return;
    const key = this.appKey(appVersion);
    const list = this.perApp.get(key) ?? [];
    list.push({ embedding, recovered, lastSeenAt: Date.now() });
    if (list.length > SemanticVocabulary.MAX_ENTRIES_PER_APP) {
      list.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      list.splice(0, list.length - SemanticVocabulary.MAX_ENTRIES_PER_APP);
    }
    this.perApp.set(key, list);
  }

  async findSimilar(candidate: RecoveredLabel, appVersion: string): Promise<RecoveredLabel | null> {
    if (this.embedder === null) return null;
    const list = this.perApp.get(this.appKey(appVersion));
    if (list === undefined || list.length === 0) return null;
    const text = this.textFor(candidate);
    if (text.length === 0) return null;
    let embedding: Float32Array | null;
    try {
      embedding = await this.embedder.embed(text);
    } catch {
      return null;
    }
    if (embedding === null || embedding.length === 0) return null;

    let best: VocabEntry | null = null;
    let bestSim = this.threshold;
    for (const entry of list) {
      if (entry.embedding.length !== embedding.length) continue;
      const sim = cosineSimilarity(embedding, entry.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = entry;
      }
    }
    if (best === null) return null;
    best.lastSeenAt = Date.now();
    return best.recovered;
  }

  clear(): void {
    this.perApp.clear();
  }

  size(appVersion: string): number {
    return this.perApp.get(this.appKey(appVersion))?.length ?? 0;
  }

  private textFor(r: RecoveredLabel): string {
    const parts = [r.inferredLabel, r.inferredDescription, r.inferredRole]
      .filter((s) => typeof s === 'string' && s.length > 0);
    return parts.join(' | ').slice(0, 256);
  }

  private appKey(appVersion: string): string {
    return appVersion.toLowerCase();
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}
