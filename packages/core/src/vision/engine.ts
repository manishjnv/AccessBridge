import type { UnlabeledElement, RecoveredLabel, VisionRecoveryConfig, RecoveryCache, ApiVisionClient } from './types.js';
import { composeHeuristicLabel } from './heuristics.js';

export class VisionRecoveryEngine {
  private readonly config: VisionRecoveryConfig;
  private readonly apiClient: ApiVisionClient | null;
  private readonly cache: Map<string, RecoveryCache> = new Map();
  private stats = { hits: 0 };

  constructor(config: VisionRecoveryConfig, apiClient?: ApiVisionClient) {
    this.config = config;
    this.apiClient = apiClient ?? null;
  }

  async recoverSingle(element: UnlabeledElement, appVersion: string = 'unknown'): Promise<RecoveredLabel | null> {
    const key = this.cacheKey(element, appVersion);
    const cached = this.cache.get(key);
    if (cached && (Date.now() - cached.cachedAt) < this.config.cacheTTLms) {
      this.stats.hits++;
      return { ...cached.recovered, source: 'cached' };
    }
    let result: RecoveredLabel | null = null;
    if (this.config.tierEnabled[1]) {
      result = composeHeuristicLabel(element);
    }
    if (
      this.config.tierEnabled[2] &&
      this.apiClient !== null &&
      (result === null || result.confidence < this.config.minConfidence)
    ) {
      try {
        const api = await this.apiClient.inferElementMeaning('', this.buildDomContext(element));
        result = {
          element,
          inferredRole: api.role,
          inferredLabel: api.label,
          inferredDescription: api.description,
          confidence: Math.min(1, Math.max(0, api.confidence)),
          source: 'api-vision',
          tier: 2,
        };
      } catch {
        // keep tier-1 result when present
      }
    }
    if (result === null || result.confidence < this.config.minConfidence) return null;
    this.cache.set(key, { key, recovered: result, cachedAt: Date.now(), appVersion });
    return result;
  }

  async recoverLabels(candidates: UnlabeledElement[], appVersion: string = 'unknown'): Promise<RecoveredLabel[]> {
    const results: RecoveredLabel[] = [];
    for (const c of candidates) {
      const r = await this.recoverSingle(c, appVersion);
      if (r !== null) results.push(r);
    }
    return results;
  }

  getCacheStats(): { hits: number; entries: number; sizeBytes: number } {
    let sizeBytes = 0;
    for (const v of this.cache.values()) sizeBytes += JSON.stringify(v).length;
    return { hits: this.stats.hits, entries: this.cache.size, sizeBytes };
  }

  async clearCache(): Promise<void> {
    this.cache.clear();
    this.stats = { hits: 0 };
  }

  private cacheKey(el: UnlabeledElement, appVersion: string): string {
    return appVersion + '::' + el.nodeHint + '::' + el.classSignature + '::' + (el.backgroundImageUrl ?? '') + '::' + el.textContent.slice(0, 40);
  }

  private buildDomContext(el: UnlabeledElement): string {
    const lines = [
      'tag/classes: ' + el.nodeHint,
      'role: ' + (el.computedRole ?? 'none'),
      'text: ' + el.textContent,
      'sibling context: ' + el.siblingContext,
    ];
    if (el.backgroundImageUrl !== null) lines.push('bg-image: ' + el.backgroundImageUrl);
    return lines.join('\n');
  }
}
