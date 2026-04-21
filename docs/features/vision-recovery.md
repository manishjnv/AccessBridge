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
| 3 | On-device quantized VLM (Moondream / MobileViT, ~200 MB) | ~200 ms/element | Free | **Documented stub only** |

**Tier-2 is off by default** — the user opts in per-profile. Only element-local context and a tiny screenshot go to the configured AI provider (Gemini by default). No URLs, no identity, no full-page capture.

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
   │  4. if result.confidence >= minConfidence → cache + return
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
| Cache | In-memory only (never persisted). Cleared on Clear Cache, on page reload, or when service worker hibernates. |

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
