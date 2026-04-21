# AI Pipeline Guide — Fail-Safe, Cost-Efficient

**Status:** Design doc (target architecture — not yet fully implemented)
**Owner:** `@accessbridge/ai-engine`
**Complements:** [ai-engine.md](ai-engine.md) (current implementation), [decision-engine.md](decision-engine.md) (routing signals)

This guide describes the end-to-end AI request pipeline: how a user-facing request flows through caches, heuristics, cheap models, quality gates, and escalation paths — and how each step handles its own failure so the caller never sees a broken experience. Optimise for three goals in order: **correctness → availability → cost**. Anything that trades the first two for the third is wrong.

---

## 1. Goals and non-goals

**Goals**
- Zero single-point-of-failure: any one provider down is invisible to users.
- Lowest-cost model that clears the quality bar for the task — not the cheapest overall.
- Every request observable: provider, tokens, latency, cache hit, quality outcome, cost.
- Swap a model in one file without touching callers.

**Non-goals**
- Multi-tenant isolation (single-user extension).
- Guaranteed SLA latency (best-effort; providers vary).
- Perfect quality parity with premium on every request (verified trade).

---

## 2. Design principles

1. **Defence in depth.** Cache → heuristic → cheap model → mid → premium. Each layer reduces the population reaching the next.
2. **Fail forward to cheaper first, then up.** A 429 on Haiku goes to a Haiku backup (Llama 3.3 70B), not straight to Sonnet.
3. **Quality is a gate, not a hope.** No escalation path trusts a model's output blindly — every layer has a local verifier.
4. **Every layer measurable.** If you can't see its hit rate, escalation rate, or failure rate, it doesn't exist.
5. **One config file owns routing.** `routing/task-chains.ts` is the only place a model swap happens.
6. **Bounded user wait.** A pipeline-wide 8-second deadline caps end-to-end latency; layers abort early rather than chaining worst-case timeouts (§6.1).

---

## 3. Pipeline architecture

```
                 ┌─────────────────────────────────────────────────────────┐
  Request ─────▶ │ L0 Normalize: strip HTML, collapse WS, truncate, PII    │
                 └─────────────────────────────────────────────────────────┘
                                           │
                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ L1 Exact cache (hash key, TTL 5 min)                    │──▶ hit: return
                 └─────────────────────────────────────────────────────────┘
                                           │ miss
                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ L2 Semantic cache (embedding cos ≥ 0.95, TTL 1 h)       │──▶ hit: return
                 └─────────────────────────────────────────────────────────┘
                                           │ miss
                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ L3 Heuristic handler (regex/TextRank/Chrome APIs)       │──▶ confident: return
                 └─────────────────────────────────────────────────────────┘
                                           │ not confident
                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ L4 Task-specialist model (primary → backup)             │
                 │    Circuit breaker, 429-aware, budget-gated              │
                 └─────────────────────────────────────────────────────────┘
                                           │
                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ L5 Quality verifier (local heuristic per task type)     │──▶ pass: return
                 └─────────────────────────────────────────────────────────┘
                                           │ fail (once)
                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ L6 Mid-tier escalation (Haiku primary, Llama 70B backup)│
                 │    Re-verify                                             │
                 └─────────────────────────────────────────────────────────┘
                                           │ fail
                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ L7 Premium escalation (Sonnet primary, Llama 90B backup)│
                 │    Final answer; user-visible toast: "used premium"     │
                 └─────────────────────────────────────────────────────────┘
                                           │
                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │ L8 Persist: write caches, record cost, emit telemetry   │
                 └─────────────────────────────────────────────────────────┘
                                           │
                                           ▼
                                       Response
```

Each layer is a pure function of `(request, context)` and returns `{ handled: true, response } | { handled: false, reason }`. No layer can skip a downstream layer — the pipeline composes them in order.

---

## 4. Request lifecycle (concrete)

### L0 — Normalize

Purpose: make cache keys stable, strip content models shouldn't see.

- HTML strip via DOMParser `textContent`.
- Collapse runs of whitespace to single space, trim.
- Truncate to task-specific input cap (`classify`: 500 chars, `simplify`: 4k tokens, `summarize`: 8k tokens).
- Run PII scrubber: regex + `pii-guard` (emails, phones, card-like number patterns) — replace with typed placeholders (`<EMAIL_1>`, `<PHONE_2>`). The `placeholder→original` map is attached to the request context and carried through all layers to L8 for reverse substitution.
- Compute `requestType | normalizedInput | language | maxLength` hash over the **scrubbed** text for L1. Exact-cache entries are keyed by scrubbed content so two users with different PII but identical intent can share a cache slot — but the cached **response** also stores placeholders, re-substituted per-request at L8.
- Compute embedding of the scrubbed text for L2 (deferred until L1 misses).
- Attach `request.deadline_ms = now + 8000` — the pipeline-wide wall-clock budget propagated to every downstream layer (§6.1).

### L1 — Exact cache

- LRU-backed map keyed by the L0 hash, 5-minute TTL.
- Stored in `chrome.storage.session` (tab-local, survives popup close, wiped on browser restart).
- Hit → return cached response with `cache_hit: "exact"`, cost 0.

### L2 — Semantic cache

- Only engages for tasks where paraphrase is common: `simplify`, `summarize`, `classify`.
- Embedder: `Transformers.js` with `all-MiniLM-L6-v2` loaded once on background worker startup (offline, ~20 MB quantised, ~50 ms per embed on CPU). Backup: Titan Embeddings v2 ($0.02/M).
- Index: flat IndexedDB store of `{ embedding_float32, response, requestType, timestamp }`. Periodic compaction drops entries older than 1 h.
- Lookup: cosine against last 500 same-`requestType` entries (flat scan is fine at this scale — upgrade to HNSW if > 10k).
- Hit condition: cosine ≥ 0.95 **and** same `requestType` **and** same target language.
- Hit → return with `cache_hit: "semantic"`, cost = embedding cost only.

### L3 — Heuristic handler

For tasks where a model is overkill:

| Task | Heuristic | Confidence signal |
|---|---|---|
| `classify:urgency` | Keyword list ("urgent", "asap", "deadline") + ALL-CAPS ratio | ≥ 2 signals → confident |
| `classify:language` | n-gram detector (compact-language-detector-3) | Score ≥ 0.9 |
| `translate:en↔common` | Chrome Translator API (Chrome 128+) | API returns non-empty |
| `simplify:short` | Readability rewrite (Flesch-Kincaid + 1200-word synonym dict) | Input < 200 chars and grade-level drop ≥ 2 |
| `summarize:short` | TextRank extractive top-3 sentences | Input < 500 words |

Confidence below threshold → proceed to L4. Heuristic outputs are still run through L5 verifier — they're not privileged.

### L4 — Task-specialist model

Provider chain per task (see [§5](#5-provider-chains)). Logic:

```
for attempt in (primary, backup):
  if circuit_open(attempt): continue
  if !budget.can_afford(attempt): continue
  try:
    response = provider.call(attempt, request, maxTokens=cap[task])
    circuit_record_success(attempt)
    return response
  except (429, 5xx, timeout) as e:
    circuit_record_failure(attempt, e)
    continue

# All providers in chain failed — escalate to L6 one tier up
```

Rate-limit (429) is a failure for circuit-breaker purposes. 5xx is a failure. Context-overflow is a **logic error** — re-truncate and retry once on primary.

**Prompt caching (mandatory for every L4 call).** Mark the system prompt and any fixed few-shot examples with `cache_control: { type: "ephemeral" }` (Anthropic native) / `cachePoint` (Bedrock Converse). Cached-read tokens bill at ~10% of input rate, TTL 5 min. Cache-miss first write pays 1.25× input rate; breaks even on the second hit. For AccessBridge, the system prompt is identical per request type, so any user with ≥ 2 requests in 5 min gets the cache benefit. Skip only when the provider genuinely doesn't support caching (e.g., Chrome Translator API — N/A). Telemetry must record `cache_read_tokens` and `cache_write_tokens` separately from regular input tokens.

**Deadline propagation.** Each provider call receives `remaining_ms = request.deadline_ms - now - verifier_reserve (200ms)`. Pass this as the fetch abort-controller timeout. If `remaining_ms < 500`, L4 short-circuits without calling: return best-effort L3 heuristic output if available, else bubble `DEADLINE_EXCEEDED` to the caller. Never let a single provider call consume the full remaining budget — cap individual calls at `min(remaining_ms, 5000ms)` so a stuck primary still leaves headroom for a backup attempt.

### L5 — Quality verifier

Local, fast, per-task rules. No model calls.

| Task | Checks |
|---|---|
| `classify` | Output in allowed label set; length < 50 chars; no prose |
| `simplify` | Output length ≤ 1.2× input length; no phrases like `"I cannot"`, `"I'm unable"`, `"As an AI"`; Flesch-Kincaid grade dropped ≥ 1 from input (if computable) |
| `summarize` | Output length within `[0.1× input, maxTokens]`; contains ≥ 1 sentence; last char is sentence-terminator (not mid-word truncation) |
| `translate` | Detected language of output matches target; length ratio within [0.5×, 2.0×] of input |
| `vision` | Output non-empty; contains ≥ 1 visual-vocabulary word (colour, shape, object, spatial); not `"unable to process"` |

Pass → proceed to L8. Fail → L6.

### L6 — Mid-tier escalation

One retry at mid-tier (Haiku primary, Llama 3.3 70B backup). Re-verify with L5. Fail → L7.

### L7 — Premium escalation

Sonnet primary, Llama 3.2 90B Vision backup (for vision) or Llama 3.3 70B (text). No further escalation — return best-effort and emit `quality_warning: true` to telemetry. User gets a toast: *"This request used premium AI ($X)."* — transparency > silent cost spike.

### L8 — Persist

- **Reverse PII substitution.** Walk the response text with the placeholder map from L0 context and replace each placeholder with its original value (`<EMAIL_1>` → `alice@example.com`). If the model fabricated an unexpected placeholder token not in the map (e.g., `<EMAIL_9>`), strip it rather than leaking the marker to users.
- Write response to L1 (exact) and L2 (semantic if applicable) — store the **placeholder version**, not the re-substituted version, so subsequent cache hits (which may come from a different request with a different map) apply their own substitution correctly.
- `CostTracker.track(response)` — updates daily total and per-tier stats, including cached-read vs cached-write token split.
- Emit telemetry event (§8) — include `deadline_remaining_ms` at response time so latency budget waste is visible.
- Return re-substituted response to caller.

---

## 5. Provider chains

Chains live in `packages/ai-engine/src/routing/task-chains.ts`. Shape:

```ts
interface ProviderChain {
  task: RequestType;
  primary: ModelRef;
  backup: ModelRef;
  midEscalation: ModelRef;    // L6
  midBackup: ModelRef;
  premiumEscalation: ModelRef; // L7
  premiumBackup: ModelRef;
  maxOutputTokens: number;
  verifier: QualityVerifier;
}
```

**Canonical chains** (update this table whenever the file changes):

| Task | L4 primary | L4 backup | L6 primary | L6 backup | L7 primary | L7 backup |
|---|---|---|---|---|---|---|
| `classify` | Llama 3.2 1B | Nova Micro | Haiku 4.5 | Llama 3.3 70B | Sonnet 4.6 | Llama 3.3 70B |
| `simplify:short` | Nova Micro | Mistral 7B | Haiku 4.5 | Llama 3.3 70B | Sonnet 4.6 | Llama 3.3 70B |
| `simplify:long` | Llama 3.1 8B | Mistral Small | Haiku 4.5 | Llama 3.3 70B | Sonnet 4.6 | Llama 3.3 70B |
| `summarize:short` | Nova Micro | Llama 3.2 3B | Haiku 4.5 | Llama 3.3 70B | Sonnet 4.6 | Llama 3.3 70B |
| `summarize:long` | Llama 3.1 8B + chunk | Nova Lite + chunk | Haiku 4.5 | Llama 3.3 70B | Sonnet 4.6 | Llama 3.3 70B |
| `translate:en↔common` | Chrome Translator API | Nova Micro | Haiku 4.5 | Gemini Flash | Sonnet 4.6 | Gemini Flash |
| `translate:indic` | Gemini Flash | Haiku 4.5 | Sonnet 4.6 | Llama 3.3 70B | Sonnet 4.6 | Gemini Flash |
| `vision:alt-text` | Llama 3.2 11B Vision | Nova Lite | Sonnet 4.6 | Llama 3.2 90B Vision | Sonnet 4.6 | Llama 3.2 90B Vision |
| `vision:nuanced` | Sonnet 4.6 | Llama 3.2 90B Vision | — | — | — | — |

**Rule: never more than two failovers at a single layer.** If both primary and backup of a layer fail, escalate up — don't add a third sibling.

---

## 6. Circuit breaker

Per `(task, model)` state machine in-memory on the background worker:

| State | Meaning | Transition |
|---|---|---|
| CLOSED | Normal | 3 consecutive failures within 60 s → OPEN |
| OPEN | Skip this model, fail fast | After 60 s → HALF_OPEN |
| HALF_OPEN | Allow 1 probe request | Success → CLOSED. Failure → OPEN (reset 60 s) |

Failure counters decay to 0 on any success. State is ephemeral (no persistence — recovery on worker restart is fine).

**Key rule:** the breaker is per-`(task, model)`, never global per-model. A model failing `vision` doesn't mean it can't serve `classify`.

### 6.1 Deadline propagation

Every request carries `deadline_ms` set at L0 (default 8000 ms wall-clock). Each layer subtracts its own consumed time and a fixed reserve for downstream layers before calling out.

| Layer | Reserve left for downstream | If remaining < threshold |
|---|---|---|
| L0 Normalize | budget - 50 ms (normalize cost) | n/a (always completes) |
| L1 Exact cache | budget - 5 ms | n/a (local lookup) |
| L2 Semantic cache | budget - 80 ms (embed + lookup) | skip L2, proceed to L3 |
| L3 Heuristic | budget - 20 ms | skip L3, proceed to L4 |
| L4 Model call | cap at min(remaining, 5000 ms) | if < 500 ms, skip L4, return L3 best-effort or error |
| L5 Verifier | reserve 200 ms | always run (verifier is fast, cost of skipping is worse) |
| L6 Mid escalation | cap at min(remaining, 3000 ms) | if < 500 ms, return L4 output unverified + `quality_warning: true` |
| L7 Premium escalation | cap at min(remaining, 3000 ms) | if < 500 ms, return best-prior output + `quality_warning: true` |

**Budget split rationale.** 8s total → L4 gets up to 5s (the realistic worst case for a cold Sonnet call). If L4 consumes all of it, we still have 3s for L6+L7+L5+overhead. If L4 returns in 1.5s but verifier fails, L6 has up to 3s, L7 has up to 2s residual — so worst-case triple-escalation stays inside budget.

**Caller override.** Background-initiated requests (pre-computation, batch pre-warming) may pass `deadline_ms: 30000` — no user is waiting. Opt-in, never default. Foreground UI requests always use the 8s default.

**Cancellation.** Abort propagation uses a single `AbortController` passed down the pipeline. When the outer deadline fires, all pending fetches abort simultaneously; no orphan requests continue after the user sees the error.

---

## 7. Budget control

Two levels:

**Soft cap (default 80% of daily):** at this threshold, L4 primary auto-swaps to the cheapest backup in its chain for the rest of the UTC day. User is not notified (degradation is graceful).

**Hard cap (100%):** L4 + L6 + L7 refuse new requests; requests fall back to L3 heuristics or return an error if no heuristic can handle the task. User sees a one-time toast: *"Daily AI budget reached — using basic mode until midnight UTC."*

Budget math is pessimistic: before every call, `canAfford(projectedTokens × 1.2)` — 20% safety margin. If the call comes back larger than projected, we've overrun the estimate, not the cap.

---

## 8. Observability

### Per-request telemetry event

```ts
interface AITelemetryEvent {
  request_id: string;         // UUID
  timestamp: number;          // ms since epoch
  task: RequestType;
  tier: AITier;
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  cache_hit: 'none' | 'exact' | 'semantic';
  verifier_result: 'pass' | 'fail' | 'skipped';
  escalations: number;        // 0 = L4 only, 1 = L6, 2 = L7
  cost_usd: number;
  circuit_openings: string[]; // models whose breaker opened during this request
}
```

All events local-only in MVP (IndexedDB ring buffer, 10k events). Exportable as CSV from Settings.

### Aggregated metrics (computed on demand from ring buffer)

- Cache hit rate per task (exact / semantic / combined).
- p50/p95 latency per task.
- Escalation rate per primary model (`escalations > 0` / total at that primary).
- Daily cost per tier and per task.
- Circuit breaker open events per provider per 24 h.
- Verifier fail rate per task.

### Alert thresholds (surface in Settings → Diagnostics)

| Metric | Warn | Critical |
|---|---|---|
| Any primary opens circuit within 1 h | 2 | 5 |
| Daily cost at 12:00 UTC | 60% of cap | 80% of cap |
| Verifier fail rate (rolling 1 h) | 15% | 30% |
| Cache hit rate (rolling 24 h) | < 40% | < 25% |
| p95 latency per task | 2× baseline | 4× baseline |

---

## 9. Configuration surface

| Setting | Location | Who changes it |
|---|---|---|
| Provider chains per task | `packages/ai-engine/src/routing/task-chains.ts` | Developer, via PR |
| Quality verifiers | `packages/ai-engine/src/routing/verifier.ts` | Developer, via PR |
| Per-user daily budget | `AIConfig.maxCostPerDay` in profile | User, via popup |
| Preferred tier override | `AIConfig.tier` in profile | User, via popup |
| API endpoints / keys | Extension storage, per provider | User, via popup |
| Circuit breaker thresholds | `routing/circuit.ts` constants | Developer, rare |
| Cache TTLs | `cache.ts` constants | Developer, rare |

---

## 10. Failure mode catalogue

| Failure | Detection | Response | User impact |
|---|---|---|---|
| Provider 429 | HTTP status | Circuit failure, try backup in same chain | None |
| Provider 5xx | HTTP status | Circuit failure, try backup | None |
| Network timeout (> 15 s) | Fetch abort controller | Circuit failure, try backup | None |
| Context overflow | 400 with `context_length` marker | Re-truncate to 50% of input, one retry on same model | None |
| Quality verifier fail | Local heuristic | Escalate to L6, then L7 | One-time toast if hits L7 |
| Budget soft cap | Projected cost check | Swap primary → backup in chain | None |
| Budget hard cap | Projected cost check | Refuse L4+; L3 heuristics only | Toast: basic mode until midnight UTC |
| PII detected in request | Regex scrub pre-L1 | Replace with placeholders, continue | None |
| All providers in chain down | Circuit breaker state for all | Escalate to L6; if that also fails, toast error | Toast: AI temporarily unavailable |
| Pipeline deadline exceeded | `now >= request.deadline_ms` at any layer entry | Abort in-flight fetches, return best prior output with `quality_warning: true`, or `DEADLINE_EXCEEDED` if no output yet | Toast only when no output at all; silent if degraded-but-present |
| Prompt cache write-path fail | Provider rejects `cache_control` block | Retry once without caching markers, log provider for config audit | None |
| PII placeholder orphaned in response | Response contains `<EMAIL_N>` where N is not in map | Strip the placeholder token, emit telemetry warning | None (graceful) |
| AWS credit expired | Bedrock returns 403 ServiceQuotaExceeded | Pin Anthropic direct as primary for all Claude slots | Silent (graceful) |
| Cache poisoning (bad response cached) | Detected via user report or verifier-fail-on-read | Bump cache namespace version, invalidate all | None (next call regenerates) |
| Malformed JSON response (structured tasks) | Parse exception | Repair-parse with json-repair lib; on failure, escalate to L6 | None |

---

## 11. Quality regression harness

**Mandatory before any `task-chains.ts` change.** No exceptions.

- `packages/ai-engine/test/regression/` holds golden sets: 50 inputs per task type with expected outputs or pass/fail rubrics.
- `pnpm test:regression` runs the full set against the current chain config, diffs against last-known-good.
- A regression is: the **same chain config** producing different outputs on > 5% of the golden set across two runs (flakiness), OR a chain change dropping pass rate > 3% on any task.
- Store the golden set in git. When prod reveals a failure case, add it to the golden set with the correct expected output (prevents the same regression recurring).

---

## 12. Runbook — on-call scenarios

### Bedrock region outage

**Symptom:** circuit breakers opening on all Bedrock models simultaneously.
**Action:** flip feature flag `AI_FALLBACK_ANTHROPIC_DIRECT=true` in extension config. Every Claude slot routes to Anthropic directly. Budget doubles (Anthropic direct has no free credit) — accept for the outage window.
**Recovery:** when Bedrock health restored, unset flag. Monitor circuit breaker state for 15 min.

### Daily budget breach at 18:00 UTC

**Do not raise the cap reflexively.** A spike at 18:00 means a bug or new load source.
**Action:** filter telemetry by last 2 h. Look for: (a) new request type, (b) cache hit rate drop, (c) new user pattern. Fix the root cause. If it's legitimate new load, raise cap in next session with justification.

### Quality regression after model swap

**Symptom:** verifier fail rate > 30% on a task within 1 h of a `task-chains.ts` deploy.
**Action:** git revert the chain file. Rebuild. Redeploy. Then investigate the regression in a feature branch; never debug live.

### Cache poisoning

**Symptom:** user reports identical wrong output on a semantic-cache-eligible request.
**Action:** bump `CACHE_NAMESPACE` constant (e.g., `"v3" → "v4"`). Rebuild. All keys invalidated. Re-deploy. Root-cause the originating bad response from telemetry.

### AWS credit expired

**Symptom:** all Bedrock calls returning 403 `ServiceQuotaExceeded` or account-level denial.
**Action:** (1) top up credit / billing in AWS console. (2) If not immediate, set `AI_FALLBACK_ANTHROPIC_DIRECT=true` as above. (3) Add 7-day advance monitoring on credit balance to prevent surprise.

---

## 13. Rollout checklist — adding a model or task

- [ ] Provider file in `packages/ai-engine/src/providers/` if new family (implements `BaseAIProvider`).
- [ ] Entry in `routing/task-chains.ts` (primary or backup).
- [ ] Cost-table entry in `cost-tracker.ts` matching published pricing.
- [ ] Quality verifier rules in `routing/verifier.ts` if new task type.
- [ ] Regression golden set entries (≥ 10 inputs if new task; ≥ 3 for model swap).
- [ ] `pnpm test:regression` green.
- [ ] Shadow deploy (telemetry only, not user-facing) for 24 h.
- [ ] Compare shadow-metrics vs prior primary: pass rate, cost, latency.
- [ ] Promote to live. Monitor for 48 h with relaxed alert thresholds.
- [ ] Update this guide's chain table (§5) and the cost-table reference in [ai-engine.md](ai-engine.md).

---

## 14. Implementation status vs target

| Layer | Implemented | Gap |
|---|---|---|
| L0 Normalize | Yes (HTML strip, WS collapse, truncate) | PII scrubber + placeholder map missing; deadline injection missing |
| Prompt caching (L4) | No | Add `cache_control` markers per provider; split cached vs fresh tokens in CostTracker |
| Pipeline deadline / abort | No | Add `AbortController` threaded through pipeline; per-layer budget check (§6.1) |
| PII reverse substitution (L8) | No | Walk response with placeholder map before cache-write and return |
| L1 Exact cache | Yes | — |
| L2 Semantic cache | No | Add Transformers.js + IndexedDB flat index |
| L3 Heuristic | Partial (local.ts has STT/TTS) | Add TextRank, Chrome Translator, readability-rule simplify |
| L4 Provider chain | Partial (single provider per tier, no backup) | Add `task-chains.ts` + circuit breaker |
| L5 Quality verifier | No | New file `routing/verifier.ts` |
| L6/L7 Escalation | Profile preference only | Verifier-driven escalation missing |
| L8 Persist | Partial (CostTracker) | Telemetry ring buffer missing |
| Circuit breaker | No | New |
| Budget soft cap | No (hard cap only) | Soft-cap swap logic in chain resolver |
| Regression harness | No | New test directory + CI hook |

Phase-1 PR (suggested): L4 chain + circuit breaker + backup provider files + budget soft cap + **pipeline deadline + PII scrubber + prompt caching markers**. That unlocks fail-safe + bounded-latency + correctness on PII-bearing requests.
Phase-2 PR: L5 verifier + L6/L7 escalation + regression harness.
Phase-3 PR: L2 semantic cache + expanded L3 heuristics + telemetry ring buffer.

---

## 15. Change log

| Date | Change | Author |
|---|---|---|
| 2026-04-21 | Initial guide | Manish Kumar |
| 2026-04-21 | Added pipeline-wide 8s deadline + per-layer budget (§2, §4 L0/L4/L8, §6.1); wired prompt caching into L4 as mandatory; specified PII scrubber placeholder map + reverse substitution at L8 | Manish Kumar |
