import type {
  UnlabeledElement,
  RecoveredLabel,
  VisionRecoveryConfig,
  RecoveryCache,
  ApiVisionClient,
  OnDeviceVisionClient,
  ScreenshotProvider,
  LabelEmbedder,
  ScreenshotHasher,
  ImageDataLike,
} from './types.js';
import { composeHeuristicLabel } from './heuristics.js';
import { SemanticVocabulary } from './recovery.js';

export interface VisionEngineDeps {
  apiClient?: ApiVisionClient | null;
  onDeviceClient?: OnDeviceVisionClient | null;
  screenshotProvider?: ScreenshotProvider | null;
  screenshotHasher?: ScreenshotHasher | null;
  labelEmbedder?: LabelEmbedder | null;
  now?: () => number;
}

export class VisionRecoveryEngine {
  private readonly config: VisionRecoveryConfig;
  private readonly apiClient: ApiVisionClient | null;
  private readonly onDeviceClient: OnDeviceVisionClient | null;
  private readonly screenshotProvider: ScreenshotProvider | null;
  private readonly screenshotHasher: ScreenshotHasher | null;
  private readonly now: () => number;
  private readonly vocab: SemanticVocabulary;

  private readonly cache: Map<string, RecoveryCache> = new Map();
  /** hash → {recovered, lastSeen} — prevents re-inference on identical pixels within dedup TTL. */
  private readonly screenshotDedup: Map<string, { recovered: RecoveredLabel; lastSeen: number }> = new Map();
  /** Per-day Tier 3 inference counter; bucketed by YYYY-MM-DD string. */
  private tier3DayKey = '';
  private tier3DayCount = 0;
  /** Per-scan Tier 3 counter; reset by callers at the start of recoverLabels(). */
  private tier3ScanCount = 0;

  private stats = { hits: 0, tier1: 0, tier2: 0, tier3: 0, semanticReuse: 0, dedupHits: 0 };

  constructor(
    config: VisionRecoveryConfig,
    apiClient?: ApiVisionClient | null,
    deps?: VisionEngineDeps,
  ) {
    this.config = config;
    this.apiClient = apiClient ?? deps?.apiClient ?? null;
    this.onDeviceClient = deps?.onDeviceClient ?? null;
    this.screenshotProvider = deps?.screenshotProvider ?? null;
    this.screenshotHasher = deps?.screenshotHasher ?? null;
    this.now = deps?.now ?? (() => Date.now());
    this.vocab = new SemanticVocabulary(deps?.labelEmbedder ?? null, config.semanticSimilarityThreshold);
  }

  async recoverSingle(element: UnlabeledElement, appVersion: string = 'unknown'): Promise<RecoveredLabel | null> {
    // 1. DOM-keyed cache (cheapest)
    const key = this.cacheKey(element, appVersion);
    const cached = this.cache.get(key);
    if (cached && (this.now() - cached.cachedAt) < this.config.cacheTTLms) {
      this.stats.hits++;
      return { ...cached.recovered, source: 'cached' };
    }

    // 2. Tier 1 heuristic
    let result: RecoveredLabel | null = null;
    if (this.config.tierEnabled[1]) {
      result = composeHeuristicLabel(element);
      if (result !== null) this.stats.tier1++;
    }

    // 3. Tier 2 API (if enabled + apiClient present + still below threshold)
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
        this.stats.tier2++;
      } catch {
        // keep tier-1 result when present
      }
    }

    // 4. Tier 3 on-device VLM — only if enabled AND still below threshold AND model loaded
    if (
      this.config.tierEnabled[3] &&
      this.onDeviceClient !== null &&
      this.onDeviceClient.isLoaded() &&
      this.screenshotProvider !== null &&
      (result === null || result.confidence < this.config.minConfidence) &&
      this.tier3QuotaAvailable()
    ) {
      const tier3 = await this.runTier3(element, appVersion);
      if (tier3 !== null) {
        result = tier3;
      }
    }

    if (result === null || result.confidence < this.config.minConfidence) return null;

    // Register in semantic vocabulary (skip cached / semantic-similar to avoid self-reinforcement)
    if (result.source !== 'cached' && result.source !== 'semantic-similar') {
      await this.vocab.register(result, appVersion);
    }

    this.cache.set(key, { key, recovered: result, cachedAt: this.now(), appVersion });
    return result;
  }

  async recoverLabels(candidates: UnlabeledElement[], appVersion: string = 'unknown'): Promise<RecoveredLabel[]> {
    this.tier3ScanCount = 0;
    const results: RecoveredLabel[] = [];
    for (const c of candidates) {
      const r = await this.recoverSingle(c, appVersion);
      if (r !== null) results.push(r);
    }
    return results;
  }

  getCacheStats(): {
    hits: number;
    entries: number;
    sizeBytes: number;
    tier1: number;
    tier2: number;
    tier3: number;
    semanticReuse: number;
    dedupHits: number;
    tier3Today: number;
  } {
    let sizeBytes = 0;
    for (const v of this.cache.values()) sizeBytes += JSON.stringify(v).length;
    return {
      hits: this.stats.hits,
      entries: this.cache.size,
      sizeBytes,
      tier1: this.stats.tier1,
      tier2: this.stats.tier2,
      tier3: this.stats.tier3,
      semanticReuse: this.stats.semanticReuse,
      dedupHits: this.stats.dedupHits,
      tier3Today: this.tier3DayCount,
    };
  }

  async clearCache(): Promise<void> {
    this.cache.clear();
    this.screenshotDedup.clear();
    this.vocab.clear();
    this.stats = { hits: 0, tier1: 0, tier2: 0, tier3: 0, semanticReuse: 0, dedupHits: 0 };
  }

  // ---------- Tier 3 internals ----------

  private async runTier3(element: UnlabeledElement, appVersion: string): Promise<RecoveredLabel | null> {
    // Per-scan cap takes precedence over per-day cap so a single pathological
    // page can't exhaust the daily budget.
    if (this.tier3ScanCount >= this.config.maxPerPageScan) return null;

    const screenshot = await this.safeScreenshot(element);
    if (screenshot === null) return null;

    // Dedup: hash the downsampled screenshot. Prune stale dedup entries opportunistically
    // on the write path (invariant codified by RCA BUG-013).
    const hash = await this.safeHash(screenshot);
    if (hash !== null) {
      this.pruneDedup();
      const dedupHit = this.screenshotDedup.get(hash);
      if (dedupHit !== null && dedupHit !== undefined && (this.now() - dedupHit.lastSeen) < this.config.screenshotDedupTTLms) {
        this.stats.dedupHits++;
        dedupHit.lastSeen = this.now();
        return { ...dedupHit.recovered, element, screenshotHash: hash, source: 'cached' };
      }
    }

    const prompt = this.buildTier3Prompt(element);
    const inference = await this.safeInfer(screenshot, prompt);
    if (inference === null) return null;

    this.tier3IncrementCounters();
    this.stats.tier3++;

    const tier3: RecoveredLabel = {
      element,
      inferredRole: inference.role,
      inferredLabel: inference.inferredLabel,
      inferredDescription: inference.caption,
      confidence: Math.min(1, Math.max(0, inference.confidence)),
      source: 'on-device-vlm',
      tier: 3,
      ...(hash !== null ? { screenshotHash: hash } : {}),
    };

    // Semantic reuse: is this label near-duplicate of one we've already seen
    // in this app? If so, collapse to the existing label (source: 'semantic-similar')
    // so downstream surfaces treat them as the same semantic token.
    const similar = await this.vocab.findSimilar(tier3, appVersion);
    if (similar !== null) {
      this.stats.semanticReuse++;
      if (hash !== null) {
        this.screenshotDedup.set(hash, { recovered: similar, lastSeen: this.now() });
      }
      return {
        ...similar,
        element,
        source: 'semantic-similar',
        tier: 3,
        similarTo: similar.inferredLabel,
        ...(hash !== null ? { screenshotHash: hash } : {}),
      };
    }

    if (hash !== null) {
      this.screenshotDedup.set(hash, { recovered: tier3, lastSeen: this.now() });
    }
    return tier3;
  }

  private async safeScreenshot(element: UnlabeledElement): Promise<ImageDataLike | null> {
    if (this.screenshotProvider === null) return null;
    try {
      return await this.screenshotProvider.screenshot(element);
    } catch {
      return null;
    }
  }

  private async safeHash(image: ImageDataLike): Promise<string | null> {
    if (this.screenshotHasher === null) return null;
    try {
      return await this.screenshotHasher.hash(image);
    } catch {
      return null;
    }
  }

  private async safeInfer(
    image: ImageDataLike,
    prompt: string,
  ): Promise<{ caption: string; role: string; inferredLabel: string; confidence: number; latencyMs: number } | null> {
    if (this.onDeviceClient === null) return null;
    try {
      return await this.onDeviceClient.describeElement(image, prompt);
    } catch {
      return null;
    }
  }

  private buildTier3Prompt(element: UnlabeledElement): string {
    // Profile-driven: 'speed' uses a classification-style short prompt, 'accuracy'
    // uses a captioning-style long prompt.
    if (this.config.tier3Priority === 'speed') {
      return 'What UI control is this? One or two words.';
    }
    const role = element.computedRole ?? 'unknown';
    return `Describe the role and purpose of this UI element. Computed role: ${role}. Nearby text: ${element.siblingContext.slice(0, 120)}.`;
  }

  private tier3QuotaAvailable(): boolean {
    if (this.tier3ScanCount >= this.config.maxPerPageScan) return false;
    const today = this.todayKey();
    if (this.tier3DayKey !== today) {
      this.tier3DayKey = today;
      this.tier3DayCount = 0;
    }
    return this.tier3DayCount < this.config.maxTier3PerDay;
  }

  private tier3IncrementCounters(): void {
    this.tier3ScanCount++;
    const today = this.todayKey();
    if (this.tier3DayKey !== today) {
      this.tier3DayKey = today;
      this.tier3DayCount = 0;
    }
    this.tier3DayCount++;
  }

  private todayKey(): string {
    const d = new Date(this.now());
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** Bounded-write-side prune per RCA BUG-013: prevent unbounded growth when
   *  getCacheStats() / clearCache() are never called. */
  private pruneDedup(): void {
    const cutoff = this.now() - this.config.screenshotDedupTTLms;
    if (this.screenshotDedup.size < 256) return;
    for (const [k, v] of this.screenshotDedup) {
      if (v.lastSeen < cutoff) this.screenshotDedup.delete(k);
    }
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
