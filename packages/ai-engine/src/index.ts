// @accessbridge/ai-engine — public API surface

// Core engine
export { AIEngine } from './engine.js';

// Types & config
export type {
  AITier,
  AIProvider,
  AIConfig,
  AIRequest,
  AIRequestType,
  AIResponse,
  CacheEntry,
  CacheStats,
  CostTrackerStats,
  TierCostStats,
} from './types.js';
export { DEFAULT_AI_CONFIG } from './types.js';

// Cache
export { AICache } from './cache.js';

// Normaliser utilities
export {
  normalizeText,
  truncateForSummarization,
  extractKeyContent,
  deduplicateEmailThread,
  estimateTokenCount,
} from './normalizer.js';

// Cost tracking
export { CostTracker, estimateCost } from './cost-tracker.js';

// Providers
export {
  BaseAIProvider,
  LocalAIProvider,
  GeminiAIProvider,
  ClaudeAIProvider,
} from './providers/index.js';

// High-level services
export { SummarizerService, SimplifierService } from './services/index.js';
