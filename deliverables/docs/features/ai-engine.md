# AI Engine

**Status:** In Progress  
**Package:** `@accessbridge/ai-engine`  
**Source:** `packages/ai-engine/src/`

## Overview

The AI Engine provides intelligent text processing capabilities to AccessBridge -- summarization, simplification, classification, and translation. It uses a 3-tier provider strategy to balance cost, latency, and capability, with built-in request deduplication, caching, and daily budget enforcement.

## 3-Tier Provider Strategy

```
Request ──> Cache Check ──> Tier Selection ──> Provider Call ──> Cache Store ──> Response
                |                                                    |
                └── Cache Hit ──────────────────────────────────────-┘
```

| Tier | Provider | Cost | Latency | Capability | Use Case |
|------|----------|------|---------|------------|----------|
| Local | Browser APIs | Free | <10ms | Basic | Short text classification, simple transforms |
| Low-cost | Google Gemini Flash | ~$0.001/req | 200-500ms | Good | Email summarization, text simplification |
| Premium | Anthropic Claude | ~$0.01/req | 500-2000ms | Excellent | Complex document analysis, nuanced simplification |

### Tier Selection Logic

1. The user's profile specifies a preferred tier (default: `local`).
2. If the local tier cannot handle the request type (e.g., summarization of long text), the engine escalates to low-cost.
3. If the low-cost provider fails or returns low-quality results, the engine escalates to premium.
4. If the daily budget is exhausted, the engine falls back to the highest available tier that is still within budget.

## Request Deduplication and Caching

The `AICache` class prevents redundant API calls through two mechanisms:

### Input Normalization

Before generating a cache key, the input is normalized:
1. **Trim** leading/trailing whitespace
2. **Collapse** multiple whitespace characters to single spaces
3. **Lowercase** the entire input
4. **Truncate** to 500 characters for key generation

This means two requests that differ only in whitespace, casing, or trailing content will share a cache slot.

### Cache Key Generation

The cache key is a hash of: `requestType | normalizedInput | language | maxLength`

The hash uses a fast non-cryptographic algorithm (dual-multiply with bit mixing) that produces string keys in base-36. Collisions result in cache misses, not data corruption.

### Cache TTL

Cached responses expire after a configurable TTL (default: 5 minutes / 300,000ms). Expired entries are evicted lazily on the next cache access. The cache also tracks hit/miss statistics for monitoring.

```typescript
const stats = cache.getStats();
// { hits: 42, misses: 7, size: 35, hitRate: 0.857 }
```

## Input Normalization (Pre-Processing)

Before sending text to any AI provider, the engine applies normalization:

- **Truncation:** Input is capped at a provider-appropriate token limit to avoid wasted tokens and excessive costs.
- **HTML stripping:** HTML tags are removed, leaving only text content. This prevents the AI from wasting tokens on markup.
- **Email thread dedup:** For email summarization, quoted reply chains (lines starting with `>`) are collapsed. Only the most recent message and a summary reference to the thread are sent.
- **Whitespace normalization:** Multiple newlines, tabs, and spaces are collapsed.

## Cost Tracking and Daily Budget

The AI engine tracks every API call's cost:

```typescript
interface CostTrackerStats {
  totalTokens: number;      // Total tokens consumed across all tiers
  totalCost: number;         // Total spend in USD
  requestCount: number;      // Total API calls made
  cacheHits: number;         // Requests served from cache (free)
  cacheMisses: number;       // Requests that required an API call
  byTier: {
    local:    { tokens, cost, count };
    'low-cost': { tokens, cost, count };
    premium:  { tokens, cost, count };
  };
}
```

### Daily Budget

The `maxCostPerDay` configuration (default: $1.00 USD) is enforced before every API call. When the budget is exhausted:
1. Premium-tier requests are downgraded to low-cost
2. Low-cost requests are downgraded to local
3. If local cannot handle the request, it is queued until the next day's budget reset

The cost tracker resets at midnight UTC. All tracking is local-only -- no cost data leaves the browser.

## Fallback Chain

When a provider call fails, the engine follows a fallback chain:

```
Local ──(fail)──> Gemini Flash ──(fail)──> Claude ──(fail)──> Error with last attempt info
```

Failure conditions that trigger fallback:
- Network error (provider unreachable)
- Rate limit (HTTP 429)
- Budget exhausted for the current tier
- Response quality below threshold (planned)

Each fallback attempt is logged locally for debugging. The response always includes which tier and provider ultimately handled the request.

## Supported Request Types

| Type | Description | Typical Tier |
|------|-------------|-------------|
| `summarize` | Condense long text to key points | Low-cost or Premium |
| `simplify` | Rewrite text at a lower reading level | Low-cost |
| `classify` | Categorize content (e.g., importance level) | Local or Low-cost |
| `translate` | Translate text to target language | Low-cost or Premium |
| `tts` | Text-to-speech synthesis | Local (Web Speech API) |
| `stt` | Speech-to-text recognition | Local (Web Speech API) |
| `vision` | Image description for screen readers | Premium |

## How to Configure API Keys

API keys are stored in the extension's local storage (never synced). Configure them through the extension popup's Settings tab:

1. Open the AccessBridge popup
2. Navigate to the **Settings** tab
3. Under **AI Providers**, enter your keys:
   - **Gemini API Key:** Get one from [Google AI Studio](https://aistudio.google.com/)
   - **Claude API Key:** Get one from [Anthropic Console](https://console.anthropic.com/)
4. Set your **Daily Budget** (default: $1.00)
5. Choose your **Preferred Tier** (local, low-cost, or premium)

Without API keys, the engine operates in local-only mode using browser-native APIs (Web Speech API for TTS/STT, basic heuristic-based classification).

## Configuration Reference

```typescript
interface AIConfig {
  tier: 'local' | 'low-cost' | 'premium';  // Preferred tier
  provider: 'local' | 'gemini' | 'claude' | 'openai' | 'custom';
  apiKey?: string;              // API key for remote provider
  apiEndpoint?: string;         // Custom endpoint override
  maxTokens: number;            // Max tokens per response (default: 1024)
  temperature: number;          // Sampling temperature (default: 0.3)
  cacheTTL: number;             // Cache TTL in ms (default: 300000)
  maxCostPerDay: number;        // Daily budget in USD (default: 1.00)
  costTrackingEnabled: boolean; // Enable cost tracking (default: true)
}
```
