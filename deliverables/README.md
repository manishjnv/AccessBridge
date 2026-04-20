# AccessBridge — TopGear Ideathon Submission

**Project:** Ambient Accessibility Operating Layer for the web
**Team:** Manish Kumar
**Version:** v0.4.0 (Chrome Manifest V3 extension)
**Repo:** <https://github.com/manishjnv/AccessBridge>
**Live landing page:** <https://accessbridge.space>
**Live compliance observatory:** <https://accessbridge.space/observatory/>

---

## What AccessBridge does

A Chrome extension that silently observes how a user interacts with the web and automatically adapts the experience — no self-disclosure, no setup page, no labeling. It serves 1.3 B people with disabilities plus 2.5 B aging adults by removing the stigma barrier: users never have to identify as disabled. All behavioral signal processing happens on-device.

Three modules, 28 shipped features, 6 domain connectors, 22 Indian languages, and a differentially-private compliance observatory for enterprise audit.

- **Sensory (6)** — font scale, contrast, color-blindness filters, typography, reduced motion, live captions (Web Speech API on any `<video>`)
- **Cognitive (8)** — focus mode, reading guide, reading mode, distraction shield, AI summarize, AI simplify, fatigue-adaptive UI, action-items extractor
- **Motor (8)** — voice navigation (20+ English, 25+ Hindi, 20 more Indic languages), eye tracking (FaceDetector API), dwell click, keyboard-only mode, predictive input, smart click targets, gesture shortcuts
- **Domain connectors (6)** — Banking, Insurance, Healthcare, Telecom, Retail/E-commerce, Manufacturing/ERP — each with v1 deepening (IFSC validator, coverage-gap advisor, drug-interaction warnings, bill-shock alerts, savings badges, hazard keyword highlights)

---

## How to install (Chrome sideload — 90 seconds)

1. Download `accessbridge-extension.zip` from this folder, extract it to any directory (e.g. `C:\accessbridge-dist`).
2. Open Chrome → `chrome://extensions/`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** → select the extracted directory.
5. Pin the AccessBridge icon in the toolbar.
6. Click the icon to open the popup and explore the 5 tabs.

An auto-update check runs on popup open against `https://accessbridge.space/api/version`; newer builds are delivered by rebuilding and replacing the unpacked directory.

---

## Feature tour

Read in this order:

1. [../FEATURES.md](../FEATURES.md) — canonical feature catalog (state + file pointer per feature)
2. [DEMO_FLIGHT_PLAN.md](DEMO_FLIGHT_PLAN.md) — 5-minute recorded-demo walkthrough (beat sheet with URLs, spoken lines, fallbacks)
3. [DEMO_LIVE_SCRIPT.md](DEMO_LIVE_SCRIPT.md) — live-demo script with MUST / SHOULD / NICE-to-have risk tiers and Q&A prep
4. [DEMO_SCRIPT.md](DEMO_SCRIPT.md) — original 7-minute walkthrough
5. [screenshots/](screenshots/) — real screenshots captured during Chrome sideload QA
6. [AccessBridge_Presentation_v2.pptx](AccessBridge_Presentation_v2.pptx) — 15-slide deck

---

## Architecture summary

Monorepo with three packages (see [../ARCHITECTURE.md](../ARCHITECTURE.md) for the full picture):

- `@accessbridge/core` — `ProfileStore` (encrypted IndexedDB), `StruggleDetector` (10 signal types, 60 s sliding window, deviation-from-baseline scoring), `DecisionEngine` (maps struggle patterns to reversible adaptations)
- `@accessbridge/ai-engine` — 3-tier orchestrator: local (rule-based, free, offline) → Gemini Flash (low-cost) → Claude Sonnet (premium). Cache + cost tracker + automatic tier downgrade on budget exhaustion
- `@accessbridge/extension` — MV3 extension: React popup, content scripts, side panel, background service worker hosting the core + AI engines

Privacy posture: all behavioral signals stay in the browser. Profile data is encrypted in IndexedDB. The observatory stream is opt-in only, uses differential privacy (Laplace noise), enforces k-anonymity ≥ 5 before any categorical value appears, and commits daily Merkle roots for replay resistance.

---

## Quality signal

- 544 unit tests passing across all 3 packages (ai-engine 54 · core 382 · extension 108)
- Zero TypeScript errors (strict mode)
- Bundle sizes: content 322 KB · background 36 KB · popup 30 KB · sidepanel 414 KB
- Chrome sideload QA matrix (54 items) in [QA_REPORT.md](QA_REPORT.md) — honest pass/fail record with BUG-XXX links
- RCA log of every bug fixed during development: [../RCA.md](../RCA.md)
- Automated deploy pipeline: `./deploy.sh` (typecheck + build + test → git push → rsync to VPS → health check)

---

## Roadmap

**Phase 1 (shipped in this submission)** — Chrome extension feature-complete for browser scope: 3 modules, 28 features, 6 domains, 22 Indian languages, live compliance observatory on VPS.

**Phase 2 (next 12 weeks)** — Desktop companion (Tauri) for native apps (Word, Teams, VS Code); profile sync across devices (SSO); on-device ONNX models (Whisper, Transformers.js) so the local tier handles the 20 % of requests currently escalating to cloud.

**Phase 3 (6 months)** — Android AccessibilityService; iOS Safari extension; enterprise admin console (SCCM/Intune deployment + ROI reporting per app); public JS/TS SDK for third-party web app embedding.

Full roadmap: [../ROADMAP.md](../ROADMAP.md)

---

## Contact

- GitHub: [manishjnv](https://github.com/manishjnv)
- Project repo: <https://github.com/manishjnv/AccessBridge>
- Live landing: <https://accessbridge.space>
- Submission package generated: 2026-04-21
