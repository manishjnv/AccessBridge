/**
 * AI Engine — the main orchestrator.
 *
 * Handles the full request lifecycle:
 *   1. Cache check
 *   2. Input normalisation
 *   3. Cost budget check (downgrade tier if needed)
 *   4. Provider dispatch with fallback chain
 *   5. Cache population
 *   6. Cost tracking
 */

import { AICache } from './cache.js';
import { CostTracker, estimateCost } from './cost-tracker.js';
import { normalizeText, estimateTokenCount } from './normalizer.js';
import { BaseAIProvider, LocalAIProvider, GeminiAIProvider, ClaudeAIProvider } from './providers/index.js';
import type {
  AIConfig,
  AIProvider,
  AIRequest,
  AIResponse,
  AITier,
  CacheStats,
  CostTrackerStats,
} from './types.js';
import { DEFAULT_AI_CONFIG } from './types.js';

// ---------------------------------------------------------------------------
// Ordered fallback chain — premium -> low-cost -> local
// ---------------------------------------------------------------------------

const TIER_ORDER: AITier[] = ['premium', 'low-cost', 'local'];

function tierIndex(tier: AITier): number {
  return TIER_ORDER.indexOf(tier);
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class AIEngine {
  private config: AIConfig;
  private readonly cache: AICache;
  private readonly costTracker: CostTracker;
  private readonly providers = new Map<AITier, BaseAIProvider>();

  constructor(config?: Partial<AIConfig>) {
    this.config = { ...DEFAULT_AI_CONFIG, ...config };
    this.cache = new AICache(this.config.cacheTTL);
    this.costTracker = new CostTracker(this.config.maxCostPerDay);

    // Always register the local provider — it is the ultimate fallback.
    this.providers.set('local', new LocalAIProvider());

    // Register remote providers if API keys are available.
    this.initRemoteProviders();
  }

  // -----------------------------------------------------------------------
  // Public API — main entry point
  // -----------------------------------------------------------------------

  async process(request: AIRequest): Promise<AIResponse> {
    const start = performance.now();

    // 1. Check cache.
    const cached = this.cache.get(request);
    if (cached) {
      if (this.config.costTrackingEnabled) this.costTracker.track(cached);
      return cached;
    }

    // 2. Normalise input.
    const normalisedInput =
      typeof request.input === 'string'
        ? normalizeText(request.input, 8000)
        : request.input;

    const normalisedRequest: AIRequest = { ...request, input: normalisedInput };

    // 3. Determine starting tier, downgrade if over budget.
    let startTier = this.config.tier;
    const estTokens = typeof normalisedInput === 'string'
      ? estimateTokenCount(normalisedInput) * 2 // rough input+output estimate
      : 1000;

    if (
      this.config.costTrackingEnabled &&
      !this.costTracker.canAfford(estTokens, startTier, this.config.provider)
    ) {
      // Downgrade tier to save budget.
      const idx = tierIndex(startTier);
      for (let i = idx + 1; i < TIER_ORDER.length; i++) {
        if (this.costTracker.canAfford(estTokens, TIER_ORDER[i])) {
          startTier = TIER_ORDER[i];
          break;
        }
      }
    }

    // 4. Try configured tier, then fall back.
    const startIdx = tierIndex(startTier);
    let lastError: Error | undefined;

    for (let i = startIdx; i < TIER_ORDER.length; i++) {
      const tier = TIER_ORDER[i];
      const provider = this.providers.get(tier);
      if (!provider) continue;

      try {
        const output = await this.dispatch(provider, normalisedRequest);
        const elapsed = performance.now() - start;

        const tokens = typeof normalisedInput === 'string'
          ? estimateTokenCount(normalisedInput + output)
          : 0;

        const response: AIResponse = {
          id: generateId(),
          requestId: request.id,
          output,
          tier,
          provider: provider.name,
          cached: false,
          tokensUsed: tokens,
          estimatedCost: provider.getCost() - (provider.getTokensUsed() - tokens >= 0 ? 0 : 0),
          latencyMs: Math.round(elapsed),
        };

        // Recalculate cost properly based on this request's tokens.
        response.estimatedCost = estimateCost(tokens, tier, provider.name);

        // 5. Cache the response.
        this.cache.set(request, response);

        // 6. Track cost.
        if (this.config.costTrackingEnabled) this.costTracker.track(response);

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Fall through to next tier.
      }
    }

    // Should never reach here because local provider never throws,
    // but just in case:
    throw lastError ?? new Error('All AI providers failed');
  }

  // -----------------------------------------------------------------------
  // Convenience methods
  // -----------------------------------------------------------------------

  async summarize(text: string): Promise<string> {
    const resp = await this.process({
      id: generateId(),
      type: 'summarize',
      input: text,
    });
    return resp.output;
  }

  async simplify(text: string): Promise<string> {
    const resp = await this.process({
      id: generateId(),
      type: 'simplify',
      input: text,
    });
    return resp.output;
  }

  async classify(text: string, categories: string[]): Promise<string> {
    const resp = await this.process({
      id: generateId(),
      type: 'classify',
      input: text,
      metadata: { categories },
    });
    return resp.output;
  }

  async translate(text: string, from: string, to: string): Promise<string> {
    const resp = await this.process({
      id: generateId(),
      type: 'translate',
      input: text,
      language: to,
      metadata: { from, to },
    });
    return resp.output;
  }

  async recoverUILabel(input: {
    screenshot: string;
    domContext: string;
  }): Promise<string> {
    const resp = await this.process({
      id: generateId(),
      type: 'vision',
      input: input.domContext,
      metadata: { screenshot: input.screenshot },
    });
    return resp.output;
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  setTier(tier: AITier): void {
    this.config = { ...this.config, tier };
  }

  setApiKey(provider: AIProvider, key: string): void {
    if (provider === 'gemini') {
      const existing = this.providers.get('low-cost');
      if (existing && existing instanceof GeminiAIProvider) {
        existing.setApiKey(key);
      } else {
        this.providers.set('low-cost', new GeminiAIProvider(key));
      }
    } else if (provider === 'claude') {
      // Register both tiers.
      const lowCost = this.providers.get('low-cost');
      if (lowCost && lowCost instanceof ClaudeAIProvider) {
        lowCost.setApiKey(key);
      } else if (!this.providers.has('low-cost')) {
        this.providers.set('low-cost', new ClaudeAIProvider('low-cost', key));
      }

      const premium = this.providers.get('premium');
      if (premium && premium instanceof ClaudeAIProvider) {
        premium.setApiKey(key);
      } else {
        this.providers.set('premium', new ClaudeAIProvider('premium', key));
      }
    }
    this.config = { ...this.config, apiKey: key, provider };
  }

  getStats(): { cache: CacheStats; cost: CostTrackerStats } {
    return {
      cache: this.cache.getStats(),
      cost: this.costTracker.getStats(),
    };
  }

  /** Direct handle on the always-present local provider (Session 12 ONNX wiring). */
  getLocalProvider(): LocalAIProvider {
    return this.providers.get('local') as LocalAIProvider;
  }

  /** Direct handle on the cache (Session 12: semantic cache key generation). */
  getCache(): AICache {
    return this.cache;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private initRemoteProviders(): void {
    if (!this.config.apiKey) return;

    if (this.config.provider === 'gemini') {
      this.providers.set(
        'low-cost',
        new GeminiAIProvider(this.config.apiKey, this.config.apiEndpoint),
      );
    } else if (this.config.provider === 'claude') {
      this.providers.set(
        'low-cost',
        new ClaudeAIProvider('low-cost', this.config.apiKey, this.config.apiEndpoint),
      );
      this.providers.set(
        'premium',
        new ClaudeAIProvider('premium', this.config.apiKey, this.config.apiEndpoint),
      );
    }
  }

  private async dispatch(
    provider: BaseAIProvider,
    request: AIRequest,
  ): Promise<string> {
    const text = typeof request.input === 'string' ? request.input : '';

    switch (request.type) {
      case 'summarize':
        return provider.summarize(text, request.maxLength);
      case 'simplify':
        return provider.simplify(
          text,
          (request.metadata?.level as 'mild' | 'strong') ?? 'mild',
        );
      case 'classify':
        return provider.classify(
          text,
          (request.metadata?.categories as string[]) ?? [],
        );
      case 'translate':
        return provider.translate(
          text,
          (request.metadata?.from as string) ?? 'auto',
          request.language ?? 'en',
        );
      case 'vision': {
        const screenshot =
          (request.metadata?.screenshot as string | undefined) ?? '';
        try {
          return await provider.vision(text, screenshot);
        } catch {
          return provider.summarize(text, request.maxLength);
        }
      }
      default:
        // For unsupported types (tts, stt, vision) — return empty string
        // from local, let API providers handle if they can.
        return provider.summarize(text, request.maxLength);
    }
  }
}
