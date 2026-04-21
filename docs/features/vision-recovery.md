# Vision-Assisted Semantic Recovery (Feature #5)

> **Status:** Shipped in v0.8.0 (Session 10).
> **Entry:** Popup · Sensory tab · "Visual Label Recovery"; side panel · Vision tab.
> **Purpose:** Infer accessible names (`aria-label`, role, description) for interactive elements that ship without them — so assistive tech users can still operate third-party apps whose authors forgot to label every button.

## Why this exists

WebAIM's 2024 analysis of the top 1 000 000 home pages found that 97.4% have at least one detectable WCAG failure; missing button/link labels are the most common class. Internal enterprise apps are dramatically worse — they are rarely audited and often use SVG icons with no text alternative. Vision Recovery is a **runtime patch layer** that restores discoverability for screen readers, voice control, and switch access without waiting for the upstream author to ship a fix.

## Three-tier architecture

| Tier | Technique | Latency | Cost | Ship state |
|---|---|---|---|---|
| 1 | Heuristics + Chrome native APIs + icon lexicon (200+ entries) | ~1 ms/element | Free | **Shipped** |
| 2 | Gemini Flash multimodal (element screenshot + DOM context → JSON) | ~800 ms/element | ~$0.0001/element | **Shipped (opt-in)** |
| 3 | On-device Moondream2 INT8 VLM (~180 MB, Xenova port) via `@accessbridge/onnx-runtime` | ~200-400 ms/element | Free after download | **Shipped (Session 23, opt-in)** |

**Tier-2 is off by default** — the user opts in per-profile. Only element-local context and a tiny screenshot go to the configured AI provider (Gemini by default). No URLs, no identity, no full-page capture.

**Tier-3 is off by default AND gated behind a ~180 MB one-time download.** When the user enables it in popup Settings → "On-Device AI Models" → Tier 4, the vision encoder + text decoder + tokenizer + image preprocessor are fetched from the VPS CDN, SHA-256-verified against the pinned manifest, and cached in IndexedDB via `onnxruntime-web`. All inference happens locally — screenshots NEVER leave the device.

### Pipeline

```
collectCandidates() (content script)
   │
   ▼
VisionRecoveryEngine.recoverLabels(batch, appVersion)
   │  for each element:
   │  1. cache lookup (key: appVersion + nodeHint + classes + bgImg + textSlice)
   │  2. Tier 1: composeHeuristicLabel()  — combines:
   │        inferRoleFromClass
   │        inferIconLabel (background-image filename + class-fragment lookup)
   │        inferLabelFromSiblingContext
   │  3. if confidence < minConfidence AND tier2 enabled:
   │     call background VISION_RECOVER_VIA_API → GeminiAIProvider.vision()
   │  4. if confidence < minConfidence AND tier3 enabled AND model loaded AND quota available:
   │     screenshotProvider.screenshot(element) → ImageData
   │     screenshotHasher.hash(ImageData) → SHA-256 hex (semantic cache key)
   │     if dedup cache hit within 24h window → return cached label
   │     else → MoondreamVision.describeElement(img, prompt) → {caption, role, label, confidence}
   │     semanticVocab.findSimilar(label) — if MiniLM cosine ≥ 0.85 → reuse existing label
   │  5. if result.confidence >= minConfidence → cache + register in vocab + return
   │
   ▼
applyLabels(results)
   - sets aria-label
   - sets data-a11y-recovered="tier:N"
   - adds hidden "Inferred by AccessBridge" description
   - optional dotted outline if highlightRecovered is on
```

## Icon lexicon

The lexicon lives at [packages/core/src/vision/icon-lexicon.ts](../../packages/core/src/vision/icon-lexicon.ts) and maps 200+ normalized class fragments to Title-Case English labels. Prefix normalization strips `fa-`, `fas-`, `icon-`, `mdi-`, `mdi-light-`, `material-icons-`, `feather-`, `bi-`, `fab-`, `far-`, `fa-solid-`. The same lexicon is consulted for background-image filenames (extracted with a simple `url(...)` regex).

## Privacy

| Data path | What leaves the browser |
|---|---|
| Tier 1 | **Nothing.** All work is local. |
| Tier 2 | Only the element's serialized context (tag + class list + role + text + sibling context, 200 char max) and — if capturable — a single cropped screenshot of the element's bounding box. **No URL, no cookies, no full-page capture.** User must have opted in AND supplied their own Gemini API key. |
| Tier 3 | **Nothing.** Inference runs on-device via `onnxruntime-web` + WASM/WebGPU. The 180 MB model weights download from `http://72.61.227.64:8300/models/moondream2-*.onnx` once (SHA-256 pinned), then cache in IndexedDB. Screenshots are processed in-browser and never transmitted. |
| User curation (Vision Lab) | **Nothing transmitted.** Accept/Reject/Edit decisions persist in `IndexedDB` (`accessbridge-vision-curations`) and can be exported as JSON by the user explicitly. The domain-connector learning loop (`tools/aggregate-curated-labels.ts`) only consumes DP-noised aggregates via the Observatory — never raw local curations. |
| Semantic vocabulary | In-memory per service-worker lifetime. Cleared on Clear Cache / SW suspension. Built from MiniLM embeddings of already-recovered labels; lets the engine collapse near-duplicate labels (cosine ≥ 0.85) without running a fresh Tier-3 inference. |
| Cache | In-memory only (never persisted). Cleared on Clear Cache, on page reload, or when service worker hibernates. |

## Semantic vocabulary convergence

Over the course of a browsing session the per-app semantic vocabulary grows: every recovered label is MiniLM-embedded and stored. On subsequent Tier-3 candidates in the same app, the engine computes cosine similarity between the new caption and the accumulated vocab — if any stored embedding is ≥ 0.85 (configurable via `semanticSimilarityThreshold`), the new result is collapsed into the existing label with `source: 'semantic-similar'`. Two consequences:

1. **Repeated Tier-3 inference on the same app trends toward zero.** After ~20-50 unique elements, almost every new candidate resolves to an existing label without burning a fresh 400 ms inference.
2. **UI naming stays stable across visits.** The same "Close dialog" button won't sometimes surface as "Close" and sometimes as "Dismiss" — the first high-confidence label wins for all structurally similar siblings.

The vocabulary is LRU-bounded at `SemanticVocabulary.MAX_ENTRIES_PER_APP` (512 per appVersion).

## Tier selection decision tree

```
                    candidate element
                          │
                    DOM cache hit? ──yes──▶ return cached
                          │ no
                          ▼
                    Tier 1 heuristic
                          │
               confidence ≥ minConf? ──yes──▶ return Tier 1
                          │ no
                          ▼
                    Tier 2 enabled & key set?
                          │
                     yes──▶ cloud call ──ok──▶ return Tier 2
                          │ no / failed
                          ▼
                    Tier 3 enabled & loaded?
                          │
                     yes──▶ within per-scan + per-day quota?
                          │         │ yes
                          │         ▼
                          │   screenshot + hash → dedup hit?
                          │         │ no
                          │         ▼
                          │   Moondream2 inference
                          │         │
                          │   ≥ similar-threshold in vocab? ──yes──▶ collapse
                          │         │ no
                          │         ▼
                          │   return Tier 3 (register in vocab)
                          │
                          ▼ no / quota exceeded
                    return null (element remains unlabeled)
```

## Enterprise-managed Tier 3

Admins can control Tier 3 behavior via three ADMX policies (Session 23):

- `VisionRecoveryTier3Mode` ∈ `Disabled | AutoOnDemand | PrefetchOnIdle` — forbid the 180 MB download entirely, or prefetch it during idle so first invocation is instant.
- `ObservatoryAnalyticsLevel` ∈ `Minimal | Standard | Full` — controls telemetry granularity from the new analytics endpoints while preserving differential privacy.
- `MaxVisionInferencesPerDay` — integer cap (0-10000, default 500). 0 effectively disables Tier 3.

Full ADMX + ADML in [deploy/enterprise/admx/](../../deploy/enterprise/admx/).

## Configuration (SensoryProfile)

| Field | Default | Description |
|---|---|---|
| `visionRecoveryEnabled` | `true` | Master on/off |
| `visionRecoveryAutoScan` | `true` | Re-scan on DOM mutations (debounced 1 s) |
| `visionRecoveryTier2APIEnabled` | `false` | Opt-in AI-engine vision call |
| `visionRecoveryHighlightRecovered` | `false` | Dotted outline around recovered elements |
| `visionRecoveryMinConfidence` | `0.6` | Discard results below this confidence |

## Audit engine integration

When an element has been auto-labeled, the existing `img-alt`, `empty-link`, and `empty-button` rules in [packages/core/src/audit/rules.ts](../../packages/core/src/audit/rules.ts) skip the element — instead, a new `auto-recovered-info` rule emits an **info-severity** finding with the message "Auto-labeled by AccessBridge. Consider adding a permanent alt / aria-label." Net effect: the user's audit report shows fewer critical/serious findings and more info-level "handled for you" notes, encouraging upstream authors to ship a permanent fix without crashing the experience for end-users in the meantime.

## Limitations (known)

- **Dynamic content** auto-scan is debounced 1 s; elements added then removed within that window may never be labeled.
- **Shadow DOM** deep-scan is not yet traversed — only top-level `document` is walked.
- **iframes** are not traversed — each iframe runs its own content script, but cross-origin iframes cannot be inspected.
- **Tier 3** (on-device 200 MB VLM) is not built. An `ApiVisionClient` interface is documented so either a local ONNX-runtime backend or a custom HTTP backend can plug in without touching the engine.
- **CSV export** column count is fixed; user-curated edits are in-memory only this session.

## Developer notes

- **New audit-node field:** `AuditNode.dataRecovered: string | null` — optional for backward compatibility with the pre-Session-10 test fixtures.
- **IIFE-safe:** per RCA BUG-008, all new content-script module-level vars use descriptive names. The `VisionRecoveryController` and `VisionRecoveryUI` both hold their state on class instances, not on short-name module-level `var`s.
- **Cache segregation by `appVersion`**: when the extension's manifest version bumps, all cached recoveries are effectively invalidated because the cache key prefix changes. That's deliberate — prevents stale labels surviving a behavior-changing release.
