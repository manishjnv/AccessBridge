# AccessBridge — Feature Catalog

Single source of truth for every user-facing feature. Update in the same commit as feature changes.

Entry point legend: **P** = Popup toggle, **SP** = Side panel, **V** = Voice command, **A** = Auto-start, **D** = Domain auto-detect

---

## Sensory Module

Visual / perceptual adaptations. All live in [packages/extension/src/content/sensory/adapter.ts](packages/extension/src/content/sensory/adapter.ts).

| ID | Feature | Entry | State | Notes |
|----|---------|-------|-------|-------|
| S-01 | Font Scale (0.8x–2.0x) | P | Shipped | CSS zoom on `html` |
| S-02 | Contrast (0.5x–2.0x) | P | Shipped | CSS filter |
| S-03 | Color-blindness correction | P | Shipped | SVG filters for protanopia / deuteranopia / tritanopia |
| S-04 | Line-height + letter-spacing | P | Shipped | Typography sliders |
| S-05 | Reduced motion | P | Shipped | Disables animations + transitions site-wide |
| S-06 | Live Captions + Translation (Web Speech API overlay on &lt;video&gt;, 12 languages, optional live translation, draggable overlay, font-size + position controls) | P | Shipped | [content/sensory/captions.ts](packages/extension/src/content/sensory/captions.ts) |

Tests: indirect via `packages/core/src/__tests__/decision-engine.test.ts`.

---

## Cognitive Module

Focus, simplification, and distraction control.

| ID | Feature | File | Entry | State |
|----|---------|------|-------|-------|
| C-01 | Focus Mode (spotlight) | [content/cognitive/simplifier.ts](packages/extension/src/content/cognitive/simplifier.ts) | P | Shipped |
| C-02 | Reading Guide (cursor highlight bar) | [content/cognitive/simplifier.ts](packages/extension/src/content/cognitive/simplifier.ts) | P | Shipped |
| C-03 | Reading Mode (65-char column + 1.8 leading) | [content/cognitive/simplifier.ts](packages/extension/src/content/cognitive/simplifier.ts) | P | Shipped |
| C-04 | Distraction Shield (ads / modals / banners) | [content/cognitive/simplifier.ts](packages/extension/src/content/cognitive/simplifier.ts) | P | Shipped |
| C-05 | Auto-Summarize (AI) | [content/ai/bridge.ts](packages/extension/src/content/ai/bridge.ts) | P, V | Shipped |
| C-06 | Text Simplification (off / mild / strong) | [content/ai/bridge.ts](packages/extension/src/content/ai/bridge.ts) | P, V | Shipped |
| C-07 | Fatigue-Adaptive UI (4-level progressive) | [content/fatigue/adaptive-ui.ts](packages/extension/src/content/fatigue/adaptive-ui.ts) | A | Shipped |
| C-08 | Action Items Extractor (TODOs from emails/docs, context detection, assignee + confidence, on-page FAB + drawer panel, CSV export, Google Tasks link) | [content/cognitive/action-items.ts](packages/extension/src/content/cognitive/action-items.ts) + [content/cognitive/action-items-ui.ts](packages/extension/src/content/cognitive/action-items-ui.ts) | P, SP, on-page | Shipped |

AI-backed features (C-05, C-06) route through the AI engine — see Architecture §5.

---

## Motor Module

Input assistance: voice, gaze, dwell, keyboard.

| ID | Feature | File | Entry | State |
|----|---------|------|-------|-------|
| M-01 | Voice Navigation (20+ English commands) | [content/motor/voice-commands.ts](packages/extension/src/content/motor/voice-commands.ts) | P | Shipped |
| M-02 | Hindi Voice Commands (25+ commands, `lang=hi-IN`) | [content/motor/hindi-commands.ts](packages/extension/src/content/motor/hindi-commands.ts) | A (profile) | Shipped |
| M-03 | Eye Tracking (FaceDetector API + fallback) | [content/motor/eye-tracker.ts](packages/extension/src/content/motor/eye-tracker.ts) | P | Shipped |
| M-04 | Dwell Click (configurable delay, radial SVG) | [content/motor/dwell-click.ts](packages/extension/src/content/motor/dwell-click.ts) | P | Shipped |
| M-05 | Keyboard-Only Mode (skip links, focus ring, `?` overlay) | [content/motor/keyboard-mode.ts](packages/extension/src/content/motor/keyboard-mode.ts) | P | Shipped |
| M-06 | Predictive Input (word + phrase prediction) | [content/motor/predictive-input.ts](packages/extension/src/content/motor/predictive-input.ts) | P | Shipped |
| M-07 | Smart Click Targets (enlarge interactive elements) | Applied via DecisionEngine | P, A | Shipped |
| M-08 | Gesture Shortcuts (touch + trackpad + mouse, 16 gestures, bindable) | [content/motor/gestures.ts](packages/extension/src/content/motor/gestures.ts) | P | Shipped |

Language support: English, Hindi (full commands), plus 7 other `lang` codes for STT — no translated UI yet. Full Indic language plan is deferred (see DEF-004).

---

## Domain Connectors

Auto-activate on domain match — inject jargon decoders, form assistance, and domain-specific simplification.

| ID | Domain | File | Scope |
|----|--------|------|-------|
| D-01 | Banking | [content/domains/banking.ts](packages/extension/src/content/domains/banking.ts) | NEFT/RTGS/EMI/KYC jargon (25 terms), form assist, Lakh/Crore amount reader |
| D-02 | Insurance | [content/domains/insurance.ts](packages/extension/src/content/domains/insurance.ts) | 35-term jargon decoder, policy simplifier, claim form assistant |
| D-03 | Healthcare | [content/domains/healthcare.ts](packages/extension/src/content/domains/healthcare.ts) | Medical jargon, prescription reader, lab-test simplifier, emergency highlights |
| D-04 | Telecom | [content/domains/telecom.ts](packages/extension/src/content/domains/telecom.ts) | Plan terms, network specs, billing clarity |
| D-05 | Retail / E-commerce | [content/domains/retail.ts](packages/extension/src/content/domains/retail.ts) | Delivery clarity, price comparison, checkout assist, savings badges |
| D-06 | Manufacturing / ERP | [content/domains/manufacturing.ts](packages/extension/src/content/domains/manufacturing.ts) | ERP jargon (production, inventory, supply chain) |

Registry: [content/domains/index.ts](packages/extension/src/content/domains/index.ts) — routes based on hostname match.

---

## AI Engine (package `@accessbridge/ai-engine`)

Three-tier orchestrator. Local tier is default and free; higher tiers unlocked by API keys.

| Layer | File | Purpose |
|-------|------|---------|
| Engine | [packages/ai-engine/src/engine.ts](packages/ai-engine/src/engine.ts) | Request lifecycle (cache → normalize → cost check → dispatch → populate → track) |
| Cache | [packages/ai-engine/src/cache.ts](packages/ai-engine/src/cache.ts) | TTL-configured, keyed by `type:hash(input)` |
| Cost Tracker | [packages/ai-engine/src/cost-tracker.ts](packages/ai-engine/src/cost-tracker.ts) | Daily spend budget + automatic tier downgrade |
| Normalizer | [packages/ai-engine/src/normalizer.ts](packages/ai-engine/src/normalizer.ts) | Text pre-processing, email thread dedup, token estimation |
| Local provider | [packages/ai-engine/src/providers/local.ts](packages/ai-engine/src/providers/local.ts) | Rule-based summarize + 180-term simplify map — offline |
| Gemini provider | [packages/ai-engine/src/providers/gemini.ts](packages/ai-engine/src/providers/gemini.ts) | Low-cost remote (Gemini Flash) |
| Claude provider | [packages/ai-engine/src/providers/claude.ts](packages/ai-engine/src/providers/claude.ts) | Premium remote (Claude Sonnet) |
| Summarizer service | `packages/ai-engine/src/services/summarizer.ts` | `summarizeDocument`, `summarizeEmail`, `summarizeMeeting` |
| Simplifier service | `packages/ai-engine/src/services/simplifier.ts` | `simplifyText(level)`, `getReadabilityScore()` (Flesch-Kincaid) |
| ActionItems service | `packages/ai-engine/src/services/action-items.ts` | `extractActionItems(text, context)` — LLM second-pass that complements the DOM-regex extractor; returns `{task, assignee, deadline, priority, confidence}[]` with defensive JSON parsing and deadline normalization |

Fallback chain: **premium → low-cost → local**. Configured in `engine.ts` `TIER_ORDER`.

Tests: `packages/ai-engine/src/__tests__/` — cache, cost-tracker, normalizer, local-provider.

### AI-facing Feature

| ID | Feature | File | Entry |
|----|---------|------|-------|
| AI-01 | Email Summarization UI (Gmail + Outlook toolbar inject) | [content/ai/email-ui.ts](packages/extension/src/content/ai/email-ui.ts) | A on mail domains |

---

## Core Engine (package `@accessbridge/core`)

Background-side intelligence. Not user-facing directly but drives all auto-adaptations.

| ID | Component | File | Tests |
|----|-----------|------|-------|
| CORE-01 | Struggle Detector (10 signal types, sliding 60s window) | `packages/core/src/signals/struggle-detector.ts` | `packages/core/src/__tests__/struggle-detector.test.ts` |
| CORE-02 | Decision Engine (8+ rules mapping struggle → adaptations) | `packages/core/src/decision/engine.ts` | `packages/core/src/__tests__/decision-engine.test.ts` |
| CORE-03 | Profile Store (sensory + cognitive + motor + language) | `packages/core/src/profile/store.ts` | `packages/core/src/__tests__/profile-store.test.ts` |

Signal types collected by content script: `SCROLL_VELOCITY`, `CLICK_ACCURACY`, `DWELL_TIME`, `TYPING_RHYTHM`, `BACKSPACE_RATE`, `ZOOM_EVENTS`, `CURSOR_PATH`, `ERROR_RATE`, `READING_SPEED`, `HESITATION`.

---

## Compliance Observatory (Feature #10)

Anonymous, differentially-private daily metrics stream from the extension to a VPS dashboard for HR / compliance audits. Opt-in only; zero identity / content / URLs / IP collected.

| ID | Component | File | Role |
|----|-----------|------|------|
| OBS-01 | Metrics publisher (Laplace noise, Merkle commit, POST) | [packages/extension/src/background/observatory-publisher.ts](packages/extension/src/background/observatory-publisher.ts) | DP helpers + daily publish |
| OBS-02 | In-memory collector + chrome.alarms scheduler | [packages/extension/src/background/observatory-collector.ts](packages/extension/src/background/observatory-collector.ts) | Counters, daily reset, publish-hour deterministic spread |
| OBS-03 | Opt-in toggle (popup Settings tab) | [packages/extension/src/popup/App.tsx](packages/extension/src/popup/App.tsx) | `shareAnonymousMetrics` gate + dashboard link |
| OBS-04 | VPS Express + SQLite service | [ops/observatory/server.js](ops/observatory/server.js) | `/api/publish`, `/summary`, `/trends`, `/compliance-report`, `/health` |
| OBS-05 | Demo seed (30d × up-to-47 devices) | [ops/observatory/seed-demo-data.js](ops/observatory/seed-demo-data.js) | Idempotent; `--force` to reseed |
| OBS-06 | Dashboard (3 tabs, SVG charts, print-to-PDF) | [ops/observatory/public/](ops/observatory/public/) | `#overview`, `#trends`, `#compliance` |
| OBS-07 | Tests (14 cases: Laplace, Merkle, aggregate) | [packages/extension/src/background/__tests__/observatory-publisher.test.ts](packages/extension/src/background/__tests__/observatory-publisher.test.ts) | Non-determinism, order sensitivity, empty inputs |

Live dashboard: `http://72.61.227.64:8300/observatory/`. The landing page exposes an in-page `#observatory` help section (what it is + privacy guarantees + 3 capability cards) that deep-links to the full dashboard via an "Open full dashboard" CTA — nav and footer both anchor-scroll to that section instead of navigating away. Docs: [docs/features/compliance-observatory.md](docs/features/compliance-observatory.md).

Security invariants enforced at multiple layers: (a) opt-in gate on every `record*` call in background; (b) allowlist of metric keys server-side; (c) UNIQUE(date, merkle_root) + server-side merkle verification for replay/forge resistance; (d) k-anonymity floor of 5 devices before a categorical appears in top-N lists; (e) rate limit 60 req/60 s per IP.

---

## Feature-count summary

| Module | Count |
|--------|-------|
| Sensory | 6 |
| Cognitive | 8 (6 rule-based + 2 AI) |
| Motor | 8 |
| Domains | 6 |
| AI engine features | 1 (+ engine layer) |
| Core engine components | 3 |
| **Total user-facing features** | **28** |

---

## Maintenance rules

- When adding a feature: add a row here + ID scheme continues (S-06, C-08, etc.)
- When removing a feature: delete the row; keep the ID retired (don't reuse)
- When a file moves: update the link; don't leave dead anchors
- When test coverage changes: update the Tests column
- State values: **Shipped** (live) / **WIP** (in progress) / **Broken** (regression) / **Deprecated** (not removed yet)
