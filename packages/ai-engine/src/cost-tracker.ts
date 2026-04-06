/**
 * Cost tracking and daily budget enforcement.
 *
 * Maintains running totals of tokens and estimated spend so the engine
 * can automatically downgrade to a cheaper tier when the budget is
 * exhausted.
 */

import type { AIResponse, AITier, CostTrackerStats, TierCostStats } from './types.js';

// ---------------------------------------------------------------------------
// Cost table — USD per 1 M tokens (combined input + output average)
// ---------------------------------------------------------------------------

const COST_PER_MILLION_TOKENS: Record<string, number> = {
  local: 0,
  'gemini-flash': 0.10,
  'claude-haiku': 0.25,
  'claude-sonnet': 3.00,
  'gpt-4o-mini': 0.15,
};

/**
 * Map (tier, provider) to a cost-table key.
 */
function costKey(tier: AITier, provider?: string): string {
  if (tier === 'local') return 'local';
  if (provider === 'gemini') return 'gemini-flash';
  if (provider === 'claude' && tier === 'low-cost') return 'claude-haiku';
  if (provider === 'claude' && tier === 'premium') return 'claude-sonnet';
  if (provider === 'openai') return 'gpt-4o-mini';
  return 'local';
}

/**
 * Estimate the USD cost for a given number of tokens at a specific tier.
 */
export function estimateCost(tokens: number, tier: AITier, provider?: string): number {
  const rate = COST_PER_MILLION_TOKENS[costKey(tier, provider)] ?? 0;
  return (tokens / 1_000_000) * rate;
}

// ---------------------------------------------------------------------------
// Tracker class
// ---------------------------------------------------------------------------

function emptyTierStats(): TierCostStats {
  return { tokens: 0, cost: 0, count: 0 };
}

function emptyStats(): CostTrackerStats {
  return {
    totalTokens: 0,
    totalCost: 0,
    requestCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    byTier: {
      local: emptyTierStats(),
      'low-cost': emptyTierStats(),
      premium: emptyTierStats(),
    },
  };
}

const STORAGE_KEY = 'accessbridge:ai-engine:daily-cost';

export class CostTracker {
  private stats: CostTrackerStats;
  private readonly maxDailyCost: number;
  private dayKey: string;

  constructor(maxDailyCost: number) {
    this.maxDailyCost = maxDailyCost;
    this.dayKey = this.todayKey();
    this.stats = this.loadFromStorage();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Record a completed response's cost. */
  track(response: AIResponse): void {
    this.ensureSameDay();

    this.stats.totalTokens += response.tokensUsed;
    this.stats.totalCost += response.estimatedCost;
    this.stats.requestCount++;

    if (response.cached) {
      this.stats.cacheHits++;
    } else {
      this.stats.cacheMisses++;
    }

    const tier = this.stats.byTier[response.tier];
    tier.tokens += response.tokensUsed;
    tier.cost += response.estimatedCost;
    tier.count++;

    this.saveToStorage();
  }

  /**
   * Return `true` if the daily budget still has room for a request that
   * is expected to consume `estimatedTokens` tokens at the given tier.
   */
  canAfford(estimatedTokens: number, tier: AITier, provider?: string): boolean {
    this.ensureSameDay();
    const projected = estimateCost(estimatedTokens, tier, provider);
    return this.stats.totalCost + projected <= this.maxDailyCost;
  }

  getStats(): CostTrackerStats {
    this.ensureSameDay();
    return { ...this.stats };
  }

  reset(): void {
    this.stats = emptyStats();
    this.dayKey = this.todayKey();
    this.saveToStorage();
  }

  /** How many USD remain in today's budget. */
  getDailyRemaining(): number {
    this.ensureSameDay();
    return Math.max(0, this.maxDailyCost - this.stats.totalCost);
  }

  // -----------------------------------------------------------------------
  // Persistence helpers (localStorage — no-op when unavailable)
  // -----------------------------------------------------------------------

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private ensureSameDay(): void {
    const today = this.todayKey();
    if (this.dayKey !== today) {
      this.stats = emptyStats();
      this.dayKey = today;
      this.saveToStorage();
    }
  }

  private loadFromStorage(): CostTrackerStats {
    try {
      if (typeof globalThis.localStorage === 'undefined') return emptyStats();
      const raw = globalThis.localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyStats();
      const parsed = JSON.parse(raw) as { day: string; stats: CostTrackerStats };
      if (parsed.day !== this.dayKey) return emptyStats();
      return parsed.stats;
    } catch {
      return emptyStats();
    }
  }

  private saveToStorage(): void {
    try {
      if (typeof globalThis.localStorage === 'undefined') return;
      globalThis.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ day: this.dayKey, stats: this.stats }),
      );
    } catch {
      // Storage unavailable — silently continue.
    }
  }
}
