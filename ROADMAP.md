# AccessBridge — Execution Roadmap

Post-extension expansion plan. Organized as 4 tiers. Each item lists: rationale, effort, dependencies, status.

**Order of execution** (top-down priority):

1. **Tier 0 foundation — robust AI pipeline** (prerequisite; unlocks every surface by making the shared AI engine fail-safe, bounded-latency, and cost-controlled)
2. Desktop companion (Tauri) — biggest coverage win
3. Enterprise admin console — unlocks B2B revenue
4. Public SDK + API — platform play
5. Everything else (per tier)

Completed items move to [HANDOFF.md](HANDOFF.md) + closed here.

---

## Status Legend

| Symbol | Meaning |
|---|---|
| 🟢 | Done |
| 🟡 | In progress |
| ⚪ | Not started |
| 🔵 | Blocked on dependency |

---

## Current State (2026-04-21)

- 🟢 Chrome extension — shipped v0.16.0 with 29 features across 6 modules (see [FEATURES.md](FEATURES.md))
- 🟢 Landing page + self-update pipeline — live at `https://accessbridge.space`
- 🟢 Core engine + AI engine packages — extracted, tested, reusable
- 🟢 Monorepo structured for multi-surface expansion (see [ARCHITECTURE.md](ARCHITECTURE.md))
- 🟡 Robust AI pipeline designed (see [docs/features/ai-pipeline.md](docs/features/ai-pipeline.md)) — Tier 0 below tracks phased rollout
- 🟢 **Plan Section 8.5 testing stack (Session 18)** — Vitest (992 tests) + Playwright (~20 E2E specs) + axe-core merged with custom WCAG rules + CI workflows (ci.yml + e2e.yml). Pa11y batch tool deferred (reserved for future `tools/pa11y/`). See [docs/testing.md](docs/testing.md).

---

## Tier 0 — Foundation Hardening

Upgrades the shared `@accessbridge/ai-engine` from single-provider-per-tier to a fail-safe, bounded-latency, cost-optimised pipeline. **Prerequisite for every other tier** — Desktop, SDK, Public API, and Enterprise all consume this engine. See [docs/features/ai-pipeline.md](docs/features/ai-pipeline.md) for the full spec.

### R0-01 ⚪ Phase-1 — Resilience + cost foundation

Provider chains with primary+backup, circuit breaker, budget soft cap, pipeline-wide 8s deadline, PII scrubber+reverse-substitution, prompt caching markers on every L4 call, Bedrock proxy route on VPS.

- **Why:** Any single-provider outage currently breaks AI features. No latency ceiling. PII leakage risk. 90% of repeat-prefix cost currently wasted (no prompt caching).
- **Effort:** 1 week
- **Dependencies:** AWS Bedrock account with Claude + Nova + Llama model access; VPS proxy route on port 8100
- **Target models:** Nova Micro, Llama 3.2 1B/3B/8B/11B-Vision, Mistral 7B (cheap tier); Haiku 4.5 + Llama 3.3 70B (mid); Sonnet 4.6 + Llama 3.2 90B (premium)
- **Acceptance:** 5-user steady-state cost projected ≤ $0.05/day; any single provider taken offline in a test causes zero user-visible failures; p95 latency ≤ 8s end-to-end
- **MVP scope:** `routing/task-chains.ts` + `routing/circuit.ts` + `providers/nova.ts` + `providers/llama.ts` + VPS `POST /api/ai/bedrock` route + PII scrubber + prompt-cache wiring

### R0-02 ⚪ Phase-2 — Quality gates + regression harness

Local quality verifiers per task (L5), verifier-driven escalation to L6 (mid) and L7 (premium), golden regression set (~50 inputs/task), shadow-deploy harness.

- **Why:** Without a quality gate, cheap models silently serve garbage. Without regression tests, chain changes are uncontrolled. Both are required before trusting cheap models on accessibility-critical output.
- **Effort:** 1-2 weeks
- **Dependencies:** R0-01 shipped
- **Acceptance:** `pnpm test:regression` green on main; verifier fail rate telemetry wired; no chain change lands without shadow-deploy comparison
- **MVP scope:** `routing/verifier.ts` + `test/regression/` golden sets + shadow-deploy CI hook

### R0-03 ⚪ Phase-3 — Semantic cache + heuristic expansion + telemetry

Transformers.js `all-MiniLM-L6-v2` semantic cache (L2) with IndexedDB index, expanded L3 heuristics (TextRank extractive summary, Flesch-Kincaid simplify, Chrome Translator API), telemetry ring buffer with metric aggregation and Settings→Diagnostics UI.

- **Why:** Exact-cache hit rate caps around 30%. Semantic cache + richer heuristics push combined cache/heuristic coverage to ~60% of requests, cutting remaining spend by another 3-4×. Telemetry makes all above verifiable.
- **Effort:** 2 weeks
- **Dependencies:** R0-01 + R0-02
- **Acceptance:** Combined cache+heuristic hit rate ≥ 55% after one-week warmup on a 5-user cohort; telemetry dashboard surfaces hit rates, p95 latency, escalation rates, circuit openings, daily cost
- **MVP scope:** `cache/semantic.ts` + expanded `providers/local.ts` + `telemetry/` module + Settings diagnostics panel

---

## Tier 1 — Same Core, New Surfaces

Reuse `@accessbridge/core` + `@accessbridge/ai-engine`, add surface-specific adapters.

### R1-01 ⚪ Desktop companion (Tauri)

Cross-platform desktop app (Windows/macOS/Linux) that overlays AccessBridge on native apps: Word, Excel, PowerPoint, Teams, Slack, VS Code, native browsers.

- **Why:** 80% of work computing happens outside browsers. This is the single highest-leverage next surface.
- **Effort:** 4-6 weeks for MVP (signal collection on desktop, OS-level UI injection, profile sync)
- **Dependencies:** None — uses existing core + ai-engine
- **Key tech:** Tauri (Rust + webview), OS-level accessibility APIs (UIAutomation on Windows, AXUIElement on macOS, AT-SPI on Linux)
- **MVP scope:** Font scaling, contrast, focus mode, simplify-selected-text working in any app

### R1-02 ⚪ Android accessibility service

System-wide AccessBridge for native Android apps via AccessibilityService API.

- **Why:** Mobile-first markets (India, SEA) need this more than desktop
- **Effort:** 3-5 weeks for MVP
- **Dependencies:** Android-specific signal collector (gestures/taps), UI injection via overlay service
- **MVP scope:** Text-size adjustment, simplify-text, struggle detection on native apps

### R1-03 ⚪ iOS app

Safari extension (limited) + in-app SDK for apps that integrate.

- **Why:** iOS restricts accessibility services far more than Android. SDK is the viable route.
- **Effort:** 4-6 weeks (Safari extension) + ongoing for SDK
- **Dependencies:** Same core; iOS-specific UI layer (SwiftUI)
- **MVP scope:** Safari extension ports all web-relevant features; SDK provides summarize/simplify APIs

### R1-04 ⚪ CLI / Terminal mode

Jargon decoder and error-message simplifier for developers using terminals.

- **Why:** Small effort, niche but delightful; works offline with local AI tier
- **Effort:** 1-2 weeks
- **Dependencies:** `@accessbridge/ai-engine` local provider only
- **MVP scope:** `ab explain <cmd>` decodes jargon; stderr pipe support for error simplification

---

## Tier 2 — Enterprise Layer

B2B revenue. Deploy + monitor accessibility across an organization.

### R2-01 ⚪ Admin console (web)

Web dashboard where IT deploys profiles org-wide, views anonymized aggregate struggle data.

- **Why:** Enterprises buy accessibility for compliance, productivity, and insurance claims
- **Effort:** 6-10 weeks (full SaaS: auth + tenant isolation + dashboard + reporting)
- **Dependencies:** Profile backend (currently chrome.storage.local → needs server store with SSO)
- **MVP scope:** Org signup, invite users, set default profile, view struggle heatmap per app

### R2-02 ⚪ WCAG/Section 508 compliance scanner

Scans internal web apps for accessibility issues, produces reports IT can action.

- **Why:** Gov/financial sectors have compliance requirements. Recurring audit revenue.
- **Effort:** 4-6 weeks for scanner; ongoing rule expansion
- **Dependencies:** Admin console for scheduling + reporting UI
- **MVP scope:** Run headless Chrome against a URL list, detect common WCAG violations, output PDF/JSON report

### R2-03 ⚪ Profile sync + SSO

User profile follows them across devices; SAML/OIDC for enterprises.

- **Why:** Makes multi-surface adoption viable (settings don't reset per device)
- **Effort:** 3-4 weeks
- **Dependencies:** Backend storage + auth
- **MVP scope:** Google/MS SSO login, sync profile to encrypted cloud, device fleet management

### R2-04 ⚪ Audit log + ROI reporting

Shows HR/L&D which apps cause most struggle org-wide. Data feeds accessibility investment decisions.

- **Why:** Procurement justification — "our SAP instance caused 40% of struggle events"
- **Effort:** 2-3 weeks after R2-01 exists
- **Dependencies:** R2-01 Admin console + signal aggregation pipeline

---

## Tier 3 — Ecosystem (Developer)

Turn the AI engine into a platform, not just a product.

### R3-01 ⚪ JS/TS SDK

Embed AccessBridge directly in third-party web apps — no user-side install.

- **Why:** Gets B2B traction via existing vendors (help desks, LMS platforms, gov portals)
- **Effort:** 3-4 weeks
- **Dependencies:** AI engine exposed via npm package; API backend for paid tiers
- **MVP scope:** `npm install @accessbridge/sdk` + `<AccessBridgeProvider>` React wrapper

### R3-02 ⚪ Public API

REST/GraphQL endpoints for summarize + simplify + classify.

- **Why:** Pay-per-call monetization for non-web contexts (email pipelines, chatbots, data cleaning)
- **Effort:** 4-6 weeks (incl. rate limiting, billing, API keys)
- **Dependencies:** None architecturally; billing infra (Stripe)
- **MVP scope:** `POST /api/v1/simplify` with API key auth; free tier + paid tier

### R3-03 ⚪ Figma plugin

Audit designs for accessibility issues before build.

- **Why:** Shifts accessibility left in the product lifecycle; designers love "preview" tools
- **Effort:** 2-3 weeks
- **Dependencies:** WCAG rule library from R2-02
- **MVP scope:** Scan a Figma frame, flag contrast/font-size/touch-target violations

### R3-04 ⚪ VS Code extension

Warn developers in real-time as they write inaccessible markup.

- **Why:** Devs prefer IDE integration over browser testing; fastest feedback loop
- **Effort:** 2-3 weeks
- **Dependencies:** WCAG rule library
- **MVP scope:** HTML/JSX linting for missing alt text, insufficient contrast, aria-label issues

### R3-05 ⚪ Domain connector framework

Community-contributed industry-specific connectors (like the existing 6 banking/insurance/etc.).

- **Why:** Scales jargon + form-assist coverage without core-team investment
- **Effort:** 2 weeks for framework + docs; ongoing community contributions
- **Dependencies:** None
- **MVP scope:** Plugin spec + CLI scaffold + 2 example community connectors

---

## Tier 4 — Research / Moonshot

Longer horizon; higher risk; higher ceiling.

### R4-01 ⚪ Real-time meeting captions + translation

Live accessibility for Teams/Zoom/Meet via overlay or native integration.

- **Effort:** 8-12 weeks
- **Key tech:** WebRTC interception, on-device Whisper, translation models
- **Dependencies:** R1-01 Desktop companion (for Teams/Zoom native clients)

### R4-02 ⚪ AR overlay for smart glasses

Menu reading, sign translation, social-cue assistance in physical environments.

- **Effort:** 12-20 weeks (research prototype)
- **Key tech:** Apple Vision Pro, Meta Orion, WebXR fallback
- **Dependencies:** OCR + translation models; assumes consumer AR adoption

### R4-03 ⚪ Voice-first OS layer

Full voice navigation for Windows (extend beyond browser).

- **Effort:** 10-14 weeks
- **Key tech:** Windows UI Automation, on-device STT, command intent models
- **Dependencies:** R1-01 Desktop companion

### R4-04 🟡 On-device ML models

WASM + WebGPU for privacy-preserving local inference — no cloud dependency.

- **Effort:** 6-10 weeks
- **Key tech:** ONNX Runtime Web, Transformers.js, quantized models
- **Dependencies:** None; improves `@accessbridge/ai-engine` local tier
- **Status:** Session 12 shipped the infrastructure — `@accessbridge/onnx-runtime` package, three-tier runtime with IDB cache + SHA-256 integrity, struggle detector `featurize()` + classifier blending, `LocalAIProvider.embed()`, semantic cache key generation, popup + sidepanel UI, observatory counters, ~70 new tests. Session 14 landed Tier 0 (real XGBoost classifier, bundled). Session 17 extended the runtime to four tiers by adding Tier 3 IndicWhisper STT (wrapper class + audio preprocessor + 22-language BCP-47 mapping + TieredSTT picker + popup tier selector). **Deferred to Session 18+:** Whisper decoder autoregressive loop with language-forcing tokens, real weights upload to the VPS CDN for IndicWhisper + T5, content-side TieredSTT orchestration, Voice Lab demo surface. See [docs/features/onnx-models.md](docs/features/onnx-models.md).

---

## Strategic Take

For the ideathon, the extension alone demonstrates the full architecture.

For post-ideathon, the highest-leverage next moves are:

1. **Tier 0 AI pipeline hardening (R0-01 → R0-03)** — mandatory foundation; every surface below inherits its reliability, latency, and cost characteristics from this engine
2. **R1-01 Desktop (Tauri)** — unlocks 80% of work computing outside the browser
3. **R2-01 Enterprise admin console** — opens B2B revenue
4. **R3-01 SDK + R3-02 Public API** — turns the AI engine into a platform

The existing monorepo (`core` + `ai-engine` + `extension`) is already structured so every new surface is just another consumer of the same packages. The browser extension was the wedge; the real platform is the core. Tier 0 makes that core production-grade before multiple surfaces rely on it — fixing resilience and cost gaps in a single engine is far cheaper than fixing them in four.

---

## Maintenance

- Move items to 🟡 when work begins; update HANDOFF at session exit
- Move items to 🟢 when shipped; add a row to [FEATURES.md](FEATURES.md) (or a surface-specific catalog) in the same commit
- Add new items as RX-NN (continue ID sequence) when scope expands
- Re-prioritize at tier boundaries, not mid-tier, to avoid churn
