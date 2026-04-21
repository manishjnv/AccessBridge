# AccessBridge Architecture

## Overview

AccessBridge is an ambient accessibility operating layer that runs as a Chrome extension. It observes how users interact with web applications, detects when they are struggling, and automatically adapts the interface to reduce friction -- all without requiring the user to configure anything upfront.

## 11-Layer Architecture

```
+---------------------------------------------------------------+
|  Layer 11: App-Specific Adapters (Gmail, Outlook, Generic)    |
+---------------------------------------------------------------+
|  Layer 10: Motor Assistor (voice, eye tracking, dwell click)  |
+---------------------------------------------------------------+
|  Layer 9:  Cognitive Simplifier (focus, summarize, simplify)  |
+---------------------------------------------------------------+
|  Layer 8:  Sensory Adapter (font, contrast, color, motion)    |
+---------------------------------------------------------------+
|  Layer 7:  Decision Engine (rules + confidence thresholds)    |
+---------------------------------------------------------------+
|  Layer 6:  AI Engine (local -> Gemini Flash -> Claude)        |
+---------------------------------------------------------------+
|  Layer 5:  Struggle Detector (10 signals, weighted scoring)   |
+---------------------------------------------------------------+
|  Layer 4:  Signal Collectors (DOM observers, event listeners) |
+---------------------------------------------------------------+
|  Layer 3:  Profile Store (IndexedDB + AES-GCM encryption)     |
+---------------------------------------------------------------+
|  Layer 2:  Extension Runtime (Manifest V3, service worker)    |
+---------------------------------------------------------------+
|  Layer 1:  Web Platform (Chrome APIs, DOM, CSS, Web Speech)   |
+---------------------------------------------------------------+
```

### Layer Descriptions

| Layer | Name | Package | Status |
|-------|------|---------|--------|
| 1 | Web Platform | -- | Chrome APIs, DOM, CSS, Web Speech API |
| 2 | Extension Runtime | extension | Manifest V3 service worker, content scripts |
| 3 | Profile Store | core | IndexedDB storage with AES-GCM encryption |
| 4 | Signal Collectors | extension | DOM mutation observers, mouse/keyboard/scroll listeners |
| 5 | Struggle Detector | core | 10 behavioral signals with weighted scoring |
| 6 | AI Engine | ai-engine | 3-tier provider chain with caching and cost control |
| 7 | Decision Engine | core | Rule evaluation with confidence-gated adaptation |
| 8 | Sensory Adapter | extension | CSS injection, SVG color filters, custom properties |
| 9 | Cognitive Simplifier | extension | Focus mode, reading mode, summarization (planned) |
| 10 | Motor Assistor | extension | Voice nav, eye tracking, dwell click (planned) |
| 11 | App Adapters | extension | Gmail, Outlook, and generic site adapters |

## Session-23 Milestone — Feature #5 at 100%

With the Moondream2 INT8 on-device VLM landing in Session 23, **Feature #5 (Vision-Assisted Semantic Recovery) reaches 100% of its planned scope** — all three tiers shipped:

- **Tier 1 — Heuristics + icon lexicon** (200+ entries, Session 10).
- **Tier 2 — Gemini Flash multimodal** (opt-in, user-supplied key, Session 10).
- **Tier 3 — On-device Moondream2 INT8 VLM** (opt-in, ~180 MB, Session 23). Runs entirely on-device via `onnxruntime-web` + WASM/WebGPU. Screenshots never leave the browser.

The engine also gains a per-app MiniLM-backed **semantic vocabulary** that collapses near-duplicate labels (cosine ≥ 0.85) and a **screenshot-hash dedup cache** (24 h TTL) that prevents re-running inference on pixel-identical elements. Observatory analytics expand to 8 new endpoints under `/api/observatory/` covering funnel, feature-usage time-series, language breakdown, domain penetration, adaptation effectiveness, and tri-regulation compliance mapping (RPwD / ADA / EAA).

The Plan dimension "10 Unique Features" now stands at **10 / 10 features shipped**.

## Three Core Modules

### 1. Sensory Module
Handles visual and perceptual adaptations. Adjusts fonts, contrast, colors, spacing, cursor size, and motion. Operates entirely through CSS injection and SVG filters -- no DOM mutation required.

### 2. Cognitive Module
Reduces cognitive load. Focus mode hides distractions, reading mode strips page clutter, auto-summarize condenses long content, and the distraction shield filters notifications. Leverages the AI engine for summarization and text simplification.

### 3. Motor Module
Assists users with motor impairments. Voice navigation through Web Speech API, enlarged click targets, eye tracking via MediaPipe, dwell-click for pointer alternatives, keyboard-only navigation mode, and predictive input.

## Data Flow

```
  Observe          Infer            Adapt             Learn
+--------+    +------------+    +----------+    +------------+
| Signal |    | Struggle   |    | Decision |    | Baseline   |
| Collect|--->| Detector   |--->| Engine   |--->| Update     |
| ors    |    | (scoring)  |    | (rules)  |    | (EMA)      |
+--------+    +------------+    +----------+    +------------+
     |                               |
     |  DOM events,                  |  CSS injection,
     |  scroll, mouse,               |  SVG filters,
     |  keyboard                     |  DOM adaptation
     v                               v
  [Web Page]  <--------------------  [Sensory / Cognitive / Motor Adapters]
```

### Step-by-Step

1. **Observe** -- Signal collectors attach event listeners (scroll, click, keypress, mouse movement) and DOM mutation observers. Raw events are converted into normalized `BehaviorSignal` objects (value between 0 and 1). No content is logged -- only interaction metadata.

2. **Infer** -- The `StruggleDetector` maintains a 60-second sliding window of signals. It computes a weighted struggle score (0-100) by measuring how far each signal deviates from the user's personal baseline. Confidence is calculated based on signal diversity and volume.

3. **Adapt** -- The `DecisionEngine` evaluates the struggle score against 11 built-in rules. Each rule has a condition (e.g., `struggle > 60 && clickAccuracy < 0.3`), an adaptation type, and a minimum confidence threshold. Matching rules produce `Adaptation` objects that are dispatched to the appropriate adapter (Sensory, Cognitive, or Motor).

4. **Learn** -- After adaptations are applied, the baseline is updated using an exponential moving average (EMA) with an alpha capped at 0.3. This ensures the system gradually adapts to the user's natural patterns while being responsive to recent changes.

## Privacy Model

AccessBridge is designed with privacy as a core architectural constraint, not an afterthought.

### On-Device Only
- All user data stays in the browser. There is no AccessBridge server that receives behavioral data.
- The `ProfileStore` uses IndexedDB for persistence and AES-GCM 256-bit encryption for export/import.
- Encryption keys are stored in `sessionStorage` and are lost when the browser closes.

### No Content Logging
- Signal collectors capture interaction metadata only: scroll velocity, click coordinates relative to targets, keystroke timing deltas, mouse path curvature.
- The system never captures what the user is reading, typing, or viewing.
- Email summarization (via AI engine) processes content locally or sends only to the user's own configured API endpoint.

### No Telemetry
- No analytics, no tracking pixels, no phone-home behavior.
- The AI engine's cost tracker is local-only -- it tracks spend to enforce daily budgets, not to report usage upstream.

### User Control
- Three adaptation modes: `auto` (apply immediately), `suggest` (show recommendation, user confirms), `manual` (user triggers everything).
- Every adaptation is tagged `reversible: true` and can be reverted individually or all at once.
- Profile data can be cleared at any time via the Settings tab.

## Package Dependencies

```
@accessbridge/extension
  └── @accessbridge/core (workspace dependency)

@accessbridge/ai-engine
  └── (standalone, no internal dependencies)
```

The extension imports core types and classes directly. The AI engine is intentionally decoupled so it can be tested and configured independently.

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5.5+ (strict mode) |
| Monorepo | pnpm workspaces |
| Extension | Chrome Manifest V3 |
| Build | Vite 5 with @vitejs/plugin-react |
| UI | React 18 + Tailwind CSS |
| Storage | IndexedDB (via raw API) |
| Encryption | Web Crypto API (AES-GCM 256) |
| AI (local) | Browser-native APIs (planned) |
| AI (low-cost) | Google Gemini Flash API |
| AI (premium) | Anthropic Claude API |
| Voice | Web Speech API |
| Eye tracking | MediaPipe (planned) |
| VPS | Docker Compose (API, Observatory, Nginx) |
| Testing (unit) | Vitest 2 (900+ tests across 5 packages) |
| Testing (E2E) | Playwright + @playwright/test (Chromium + MV3 extension) |
| Testing (WCAG) | Custom 20 rules + axe-core ~90 checks (merged/dedup'd) |
| CI | GitHub Actions — `ci.yml` (typecheck/test/build/IIFE guard) + `e2e.yml` (Playwright over xvfb) |

See [testing.md](testing.md) for the full test pyramid, coverage map, and debugging tips.
