/**
 * @accessbridge/ai-engine — Core AI types and configuration.
 *
 * Tiered AI strategy:
 *   local (free) -> low-cost (Gemini Flash) -> premium (Claude Sonnet)
 */

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

/** Processing tier — determines cost and capability level. */
export type AITier = 'local' | 'low-cost' | 'premium';

/** Supported AI provider backends. */
export type AIProvider = 'local' | 'gemini' | 'claude' | 'openai' | 'custom';

/** The kind of work the AI engine can perform. */
export type AIRequestType =
  | 'summarize'
  | 'simplify'
  | 'classify'
  | 'translate'
  | 'action-items'
  | 'tts'
  | 'stt'
  | 'vision';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AIConfig {
  /** Which tier to prefer for requests. */
  tier: AITier;
  /** Which provider backend to use. */
  provider: AIProvider;
  /** API key (if using a remote provider). */
  apiKey?: string;
  /** Custom API endpoint override. */
  apiEndpoint?: string;
  /** Maximum tokens to generate per response. */
  maxTokens: number;
  /** Sampling temperature (0-1). */
  temperature: number;
  /** How long to cache responses, in milliseconds. */
  cacheTTL: number;
  /** Maximum daily API spend in USD. */
  maxCostPerDay: number;
  /** Whether cost tracking is enabled. */
  costTrackingEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

export interface AIRequest {
  /** Unique request identifier. */
  id: string;
  /** The type of AI operation. */
  type: AIRequestType;
  /** Text (or binary) input to process. */
  input: string | ArrayBuffer;
  /** Target language code (for translate / tts). */
  language?: string;
  /** Maximum output length hint (chars or tokens). */
  maxLength?: number;
  /** Arbitrary metadata attached to the request. */
  metadata?: Record<string, unknown>;
}

export interface AIResponse {
  /** Unique response identifier. */
  id: string;
  /** The request this responds to. */
  requestId: string;
  /** The generated output text. */
  output: string;
  /** Which tier handled this request. */
  tier: AITier;
  /** Which provider handled this request. */
  provider: AIProvider;
  /** Whether the result came from cache. */
  cached: boolean;
  /** Tokens consumed (input + output). */
  tokensUsed: number;
  /** Estimated cost in USD. */
  estimatedCost: number;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

export interface CacheEntry {
  key: string;
  response: AIResponse;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

export interface TierCostStats {
  tokens: number;
  cost: number;
  count: number;
}

export interface CostTrackerStats {
  totalTokens: number;
  totalCost: number;
  requestCount: number;
  cacheHits: number;
  cacheMisses: number;
  byTier: Record<AITier, TierCostStats>;
}

// ---------------------------------------------------------------------------
// Cache stats (returned by AICache)
// ---------------------------------------------------------------------------

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_AI_CONFIG: AIConfig = {
  tier: 'local',
  provider: 'local',
  maxTokens: 1024,
  temperature: 0.3,
  cacheTTL: 300_000, // 5 minutes
  maxCostPerDay: 1.0, // USD
  costTrackingEnabled: true,
};
