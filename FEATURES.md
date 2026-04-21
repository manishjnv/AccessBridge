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
| S-07 | Vision-Assisted Semantic Recovery (3-tier pipeline: Tier 1 heuristic + 200-entry icon lexicon; Tier 2 opt-in Gemini vision; Tier 3 stub for on-device VLM). Adds `aria-label` + `data-a11y-recovered` to unlabeled buttons/links/icons; audit engine downgrades findings to info-severity. | P, SP | Shipped | [core/vision/](packages/core/src/vision/) + [content/vision/](packages/extension/src/content/vision/) · see [docs/features/vision-recovery.md](docs/features/vision-recovery.md) |

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
| M-09 | Tiered STT Infrastructure (Session 17) — TieredSTT picker + IndicWhisper ONNX wrapper for 22-Indian-language voice; popup voiceQualityTier selector + 80 MB download UX. Tier A (Web Speech) path unchanged; Tier B (ONNX) decoder loop deferred to Session 18 — wrapper currently returns `{real: false}` | [content/motor/tiered-stt.ts](packages/extension/src/content/motor/tiered-stt.ts) + [packages/onnx-runtime/src/models/indic-whisper.ts](packages/onnx-runtime/src/models/indic-whisper.ts) | P | WIP |

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
| CORE-04 | Multi-Modal Fusion Layer 5 (unified 10-channel event stream, 5 cross-modal compensation rules, 7-intent inference, decision-engine integration — all on-device) | [packages/core/src/fusion/](packages/core/src/fusion/) + [packages/extension/src/content/fusion/](packages/extension/src/content/fusion/) | quality-estimator 26 · compensator 25 · intent-inference 43 · fusion-engine 20 = 114 tests · see [docs/features/multi-modal-fusion.md](docs/features/multi-modal-fusion.md) |
| CORE-05 | On-Device ONNX Models (Session 12 infra + Session 14 Tier 0 live): three-tier runtime — Tier 0 real XGBoost struggle classifier (own-trained, bundled in extension zip, ~0.9 MB, loads offline at startup); Tier 1 `Xenova/all-MiniLM-L6-v2` int8 (~22 MB, pinned SHA on VPS CDN, inference pathway pending WordPiece tokenizer in Session 15); Tier 2 T5-small deferred to Session 15. IDB cache + SHA-256 integrity per registry; heuristic fallback per path. `onnxruntime-web/wasm` + WASM binary bundled via `dist/ort/`; CSP `wasm-unsafe-eval` + `web_accessible_resources` for `models/*.onnx` / `ort/*`. | [packages/onnx-runtime/](packages/onnx-runtime/) + struggle-detector `featurize()` + local-provider `embed()` + [tools/prepare-models/](tools/prepare-models/) | runtime 16 · classifier 15 · detector-blending 12 · local-provider-onnx 18 · cache-embedding 6 · registry 10 = 77 tests · see [docs/features/onnx-models.md](docs/features/onnx-models.md) |

Signal types collected by content script: `SCROLL_VELOCITY`, `CLICK_ACCURACY`, `DWELL_TIME`, `TYPING_RHYTHM`, `BACKSPACE_RATE`, `ZOOM_EVENTS`, `CURSOR_PATH`, `ERROR_RATE`, `READING_SPEED`, `HESITATION`.

Fusion channels (Layer 5, independent of the StruggleDetector signal types): `keyboard`, `mouse`, `gaze`, `voice`, `touch`, `pointer`, `screen`, `env-light`, `env-noise`, `env-network`.

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

---

## Zero-Knowledge Attestation (Feature #7, Session 16)

Layers cryptographic authenticity on top of the Observatory. Each opt-in device holds a Ristretto255 keypair (generated at first publish); daily bundles are signed with a SAG linkable ring signature against the current ring of enrolled devices. The server verifies every signature and enforces UNIQUE(date, keyImage) to prevent double-publish. A standalone auditor verifier page at `/observatory/verifier` re-runs every signature check client-side with pinned CDN libs — the server is untrusted.

| ID | Component | File | Role |
|----|-----------|------|------|
| ZK-01 | SAG ring-signature crypto (Ristretto255) | [packages/core/src/crypto/ring-signature/](packages/core/src/crypto/ring-signature/) | `generateKeypair` · `sign` · `verify` · `deriveKeyImage` · `hashRing` · `buildAttestation` · `verifyAttestation` |
| ZK-02 | Extension enrollment + ring-signed publish | [packages/extension/src/background/observatory-publisher.ts](packages/extension/src/background/observatory-publisher.ts) | `getOrCreateDeviceKeypair` · `enrollDevice` · `fetchRing` · `runDailyAttestation` |
| ZK-03 | VPS endpoints + Node-side verify | [ops/observatory/server.js](ops/observatory/server.js) + [ops/observatory/crypto-verify.js](ops/observatory/crypto-verify.js) | POST `/api/enroll` · GET `/api/ring` · POST `/api/publish` (now ring-signed) · GET `/api/verify/:date` |
| ZK-04 | Standalone auditor verifier web tool | [ops/observatory/public/verifier.html](ops/observatory/public/verifier.html) + `verifier.js` + `verifier.css` | 100% client-side verify, PDF export, audit certificate hash; served at `/observatory/verifier` |
| ZK-05 | Popup + sidepanel Compliance UI | [packages/extension/src/popup/App.tsx](packages/extension/src/popup/App.tsx) + [packages/extension/src/sidepanel/index.tsx](packages/extension/src/sidepanel/index.tsx) | Enrollment status, rotate-key button, verifier-URL copy, Compliance tab with 30-day log + export |

Docs: [docs/features/zero-knowledge-attestation.md](docs/features/zero-knowledge-attestation.md). Tests: 52 TypeScript vitest cases + 11 Node cross-check scenarios = 63 new tests (885 total workspace).

Security invariants enforced at multiple layers: (a) opt-in gate on every `record*` call in background; (b) allowlist of metric keys server-side; (c) UNIQUE(date, merkle_root) + server-side merkle verification for replay/forge resistance; (d) k-anonymity floor of 5 devices before a categorical appears in top-N lists; (e) rate limit 60 req/60 s per IP.

---

## Accessibility Audit (WCAG) — Session 18 upgrade

| ID | Feature | Entry | State | Notes |
|----|---------|-------|-------|-------|
| A11Y-01 | Custom WCAG audit (20 hand-rolled rules) | SP | Shipped | [packages/core/src/audit/rules.ts](packages/core/src/audit/rules.ts) — contrast, alt text, heading order, tap targets, etc. |
| A11Y-02 | **axe-core integration (~90 checks, industry-standard)** | SP | Shipped | Session 18. Injected into page MAIN world via `<script src>` from `web_accessible_resources`; results merged + dedup'd against custom findings via `(wcagCriterion, elementSelector)` key. See [docs/features/accessibility-audit.md](docs/features/accessibility-audit.md). |
| A11Y-03 | Source badge + filter (custom / axe / both) | SP | Shipped | Session 18. Side panel shows per-finding provenance + per-source tally in header; filter chips toggle sources on/off. |
| A11Y-04 | Multi-page PDF export | SP | Shipped | `pdf-generator.ts` — valid `%PDF-…%%EOF` file with scored findings + element selectors. |

## Desktop Agent (Session 19)

Tauri 2 Rust companion process that pairs with the extension over a loopback WebSocket and exposes Windows UIA inspection. Extension works fully standalone when the agent is absent.

| ID | Feature | Status | Notes |
|----|---------|--------|-------|
| DA-01 | Tauri 2 Rust agent binary — system-tray icon + settings window (React 18, Overview / Profile / Logs tabs) + axum WS server on 127.0.0.1:8901 | Shipped | [packages/desktop-agent/src-tauri/src/lib.rs](packages/desktop-agent/src-tauri/src/lib.rs) |
| DA-02 | IPC wire protocol — 15 message variants (HELLO handshake, profile CRUD, UIA inspect, adaptation apply/revert, ping/pong, error); TS discriminated union + Rust serde mirror; PSK handshake (sha256(psk‖nonce), constant-time compare) | Shipped | [packages/core/src/ipc/](packages/core/src/ipc/) + [packages/desktop-agent/src-tauri/src/ipc_protocol.rs](packages/desktop-agent/src-tauri/src/ipc_protocol.rs) |
| DA-03 | AgentBridge extension integration — `AgentBridge` SW singleton wrapping `AgentClient`; chrome.storage.local PSK + status persistence; pair dialog in popup; Native Apps tab in sidepanel | Shipped | [packages/extension/src/background/agent-bridge.ts](packages/extension/src/background/agent-bridge.ts) |
| DA-04 | Windows UIA inspection — `WindowsUiaDispatcher` lists native windows and elements via the `uiautomation` crate; `apply()` for font-scale/process-dpi returns `UnsupportedTarget` pending Phase 2 DPI shim DLL; macOS + Linux get no-op stubs | Shipped (inspect); WIP (adapt) | [packages/desktop-agent/src-tauri/src/uia/](packages/desktop-agent/src-tauri/src/uia/) |
| DA-05 | Cross-surface profile sync foundation — last-write-wins on `profile.updatedAt`; extension pushes on connect + `SAVE_PROFILE`; agent pushes `PROFILE_UPDATED` via tokio broadcast; graceful degradation when agent absent | Shipped | [packages/desktop-agent/src-tauri/src/profile_store.rs](packages/desktop-agent/src-tauri/src/profile_store.rs) |

Docs: [docs/features/desktop-agent.md](docs/features/desktop-agent.md).

---

## Testing stack (Plan Section 8.5 — Session 18)

| Tier | Tool | Count | Scope |
|------|------|-------|-------|
| Structural | TypeScript strict | all packages | typecheck via `pnpm typecheck` |
| Unit | Vitest 2 | 1098 tests | pure logic, audit rules, axe mapper, crypto, fusion, i18n, enterprise policy, template validation |
| E2E | Playwright + Chromium | ~20 tests in 6 spec files | popup/sidepanel lifecycle, audit + axe + PDF, sensory, reload recovery, cognitive simplifier |
| Dev tool | Pa11y batch scan | deferred | reserved for future `tools/pa11y/` addition |

See [docs/testing.md](docs/testing.md) for the full test pyramid.

---

## Enterprise Deployment (Session 20 — Track B)

Group-Policy-driven admin lockdown for 250k-scale enterprise rollouts. Extension reads `chrome.storage.managed` and locks the subset of profile keys an admin has configured. Shipped templates for Windows ADMX + macOS mobileconfig + Linux JSON. MSI/MST/Intune packaging + production code-signing deferred to Session 21 — see [docs/operations/signing.md](docs/operations/signing.md) for the enforcement recipe (force-install + version-pin + `DeveloperToolsAvailability=0`).

| ID | Component | File | Role |
| ---- | ----------- | ------ | ------ |
| ENT-01 | Managed-policy reader + profile-merge | [packages/extension/src/background/enterprise/policy.ts](packages/extension/src/background/enterprise/policy.ts) | Reads `chrome.storage.managed`, coerces Windows-registry values, merges policy into profile, exposes `lockedKeys` set. Uses `Map<>` for feature-name lookup to block `__proto__` / `constructor` attacks (same remediation as RCA BUG-015). |
| ENT-02 | Popup lockdown UI | [packages/extension/src/popup/App.tsx](packages/extension/src/popup/App.tsx) | Banner "N settings managed by your organization"; locked toggles / sliders render visually-disabled with tooltip; `ENTERPRISE_GET_LOCKDOWN` polled every 10 s. |
| ENT-03 | Background policy wiring | [packages/extension/src/background/index.ts](packages/extension/src/background/index.ts) | Loads managed policy on startup; subscribes to `chrome.storage.onChanged`; re-applies merge on every `SAVE_PROFILE` so locked keys survive user saves. |
| ENT-04 | Observatory `org_hash` propagation | [packages/extension/src/background/observatory-publisher.ts](packages/extension/src/background/observatory-publisher.ts) | Managed Merkle-hash included in daily bundles when Group Policy sets `orgHash`; omitted for non-managed installs (`undefined` → absent in JSON). Managed value is authoritative vs caller-supplied `raw.org_hash`. |
| ENT-05 | ADMX templates (Windows Group Policy) | [deploy/enterprise/admx/AccessBridge.admx](deploy/enterprise/admx/AccessBridge.admx) + en-US / hi-IN ADMLs | 9 admin policies across 5 categories (Accessibility / Privacy / AIEngine / Profile / Agent); registry `HKLM\SOFTWARE\Policies\AccessBridge\*`. |
| ENT-06 | Chrome force-install ADMX | [deploy/enterprise/chrome-extension/AccessBridge-ChromeExtension.admx](deploy/enterprise/chrome-extension/AccessBridge-ChromeExtension.admx) | Configures Chrome's `ExtensionInstallForcelist` + `ExtensionSettings` to force-install + toolbar-pin the AccessBridge extension from `https://accessbridge.space/chrome/updates.xml`. |
| ENT-07 | macOS mobileconfig + Linux policy JSON | [deploy/enterprise/chrome-extension/AccessBridge.mobileconfig](deploy/enterprise/chrome-extension/AccessBridge.mobileconfig) + [chrome-policy.json](deploy/enterprise/chrome-extension/chrome-policy.json) | Same Chrome policy surface for macOS MDM (Jamf/Kandji) and Linux `/etc/opt/chrome/policies/managed/`. |
| ENT-08 | Enterprise Observatory endpoints (stub) | [ops/observatory/enterprise-endpoint.js](ops/observatory/enterprise-endpoint.js) | `/api/observatory/enterprise/{summary,trends,compliance}` — validates `orgHash` query param (64-hex), returns 501 until Session 21 adds `org_hash` column to SQLite. |
| ENT-09 | Deployment documentation | [deploy/enterprise/README.md](deploy/enterprise/README.md) + [docs/deployment/](docs/deployment/) + [docs/operations/signing.md](docs/operations/signing.md) | Admin-facing guides for ADMX install, GPO linking, SCCM/Intune, phased rollout, signing strategy, enforcement recipe. |

Docs: [deploy/enterprise/README.md](deploy/enterprise/README.md), [docs/deployment/group-policy.md](docs/deployment/group-policy.md), [docs/deployment/enterprise-chrome.md](docs/deployment/enterprise-chrome.md), [docs/deployment/sccm-intune.md](docs/deployment/sccm-intune.md), [docs/operations/signing.md](docs/operations/signing.md).

Tests: 46 (30 in [`enterprise-policy.test.ts`](packages/extension/src/background/__tests__/enterprise-policy.test.ts) + 16 in [`enterprise-templates-validation.test.ts`](packages/core/src/audit/__tests__/enterprise-templates-validation.test.ts)).

---

## Feature-count summary

| Module | Count |
|--------|-------|
| Sensory | 7 |
| Cognitive | 8 (6 rule-based + 2 AI) |
| Motor | 8 |
| Domains | 6 |
| AI engine features | 1 (+ engine layer) |
| Core engine components | 5 |
| Observatory + ZK Attestation | 12 (OBS-01..07 + ZK-01..05) |
| Desktop Agent | 5 (DA-01..DA-05) |
| Enterprise Deployment | 9 (ENT-01..ENT-09) |
| **Total user-facing features** | **43** |

---

## Maintenance rules

- When adding a feature: add a row here + ID scheme continues (S-06, C-08, etc.)
- When removing a feature: delete the row; keep the ID retired (don't reuse)
- When a file moves: update the link; don't leave dead anchors
- When test coverage changes: update the Tests column
- State values: **Shipped** (live) / **WIP** (in progress) / **Broken** (regression) / **Deprecated** (not removed yet)
