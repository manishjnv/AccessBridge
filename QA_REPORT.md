# AccessBridge — Session 8 Chrome Sideload QA Report

**Session:** 2026-04-21 · Chrome sideload QA + submission polish
**Build under test:** `packages/extension/dist/` — manifest v0.4.0
**Artifact:** `accessbridge-extension.zip` (422 KB, regenerated 2026-04-21 00:39)
**Content bundle:** 322.33 KB · Background 36.35 KB · Sidepanel 413.94 KB · Popup 30.08 KB
**All tests:** 544 / 544 passing (ai-engine 54 + core 382 + extension 108)
**BUG-008 guard:** `node -c` green on content + background

---

## Legend

| Status | Meaning |
|---|---|
| ✅ PASS | Works as expected |
| ⚠️ PARTIAL | Works but has rough edges documented in Notes |
| ❌ FAIL | Broken — logged to RCA with BUG-XXX |
| 🟡 SKIP | Not tested this session (reason in Notes) |

Each FAIL/PARTIAL links to its RCA entry and the fix commit.

---

## A. Popup UI (5 tabs)

| # | Item | Status | Notes |
|---|---|---|---|
| A-01 | Popup opens within 500 ms, no console errors | | |
| A-02 | Overview: struggle score updates live (gauge + number) | | |
| A-03 | Overview: active-adaptation counter accurate | | |
| A-04 | Overview: Master Toggle disables all features, state persists across popup close (BUG-005 regression check) | | |
| A-05 | Sensory: font-scale slider applies live (test on Wikipedia — BUG-007 regression) | | |
| A-06 | Sensory: contrast / line-height / letter-spacing / cursor sliders apply live | | |
| A-07 | Sensory: color-correction dropdown changes SVG filter | | |
| A-08 | Sensory: reading-mode toggle strips clutter | | |
| A-09 | Sensory: live-captions toggle + language/translate/font-size/position sub-controls appear and apply (NEW in WIP) | | |
| A-10 | Cognitive: focus mode spotlight follows cursor | | |
| A-11 | Cognitive: distraction shield counts blocked popups | | |
| A-12 | Cognitive: reading guide line follows cursor | | |
| A-13 | Cognitive: email summarize works on Gmail thread | | |
| A-14 | Cognitive: action-items auto-scan + min-confidence slider appear when enabled (NEW in WIP) | | |
| A-15 | Cognitive: time-awareness nudge fires (force via DevTools) | | |
| A-16 | Motor: voice-nav mic activates, 20+ English commands respond | | |
| A-17 | Motor: Hindi voice commands work (`neeche scroll karo`) | | |
| A-18 | Motor: dwell-click radial SVG progress appears | | |
| A-19 | Motor: eye tracker requests camera + calibration works | | |
| A-20 | Motor: keyboard-only mode shows skip links + focus ring + `?` overlay | | |
| A-21 | Motor: predictive input suggests words (Alt+1-5 to accept) | | |
| A-22 | Motor: gesture shortcuts respond (trackpad swipes / circles / `?` key) | | |
| A-23 | Settings: language dropdown shows 21 Indian + 8 other = 29 total languages | | |
| A-24 | Settings: observatory opt-in toggle works + dashboard link opens | | |
| A-25 | Settings: profile export downloads JSON | | |
| A-26 | Settings: profile import loads a JSON | | |
| A-27 | Settings: profile versioning shows history (if wired — library-complete, UI may be deferred) | | |
| A-28 | Settings: check-update button works (compares manifest v0.4.0 vs VPS `/api/version`) | | |

---

## B. Content Script on Real Pages

| # | Site | Feature | Status | Notes |
|---|---|---|---|---|
| B-01 | `mail.google.com` (Gmail) | action-items FAB appears in thread (if UI wired) | | UI is currently dead-code — confirms in dev |
| B-02 | `mail.google.com` | Summarize button in toolbar + panel renders | | |
| B-03 | `mail.google.com` | Sensory adaptations apply (font-scale, contrast) | | |
| B-04 | `outlook.live.com` | Same sensory adaptations | | |
| B-05 | `outlook.live.com` | Summarize button injected in toolbar | | |
| B-06 | `docs.google.com` | Reading mode works in editor | | |
| B-07 | `docs.google.com` | Focus mode spotlight works | | |
| B-08 | `teams.microsoft.com` | Captions overlay on video call | | |
| B-09 | `teams.microsoft.com` | Meeting summarizer works | | |
| B-10 | `youtube.com` (video page) | Web Speech captions overlay appears above native captions | | |
| B-11 | `sapui5.hana.ondemand.com` | Manufacturing/ERP adapter triggers | | |
| B-12 | Any banking site (SBI/HDFC) | IFSC input → bank-name badge (P4 deepening) | | |
| B-13 | Any banking site | Jargon tooltip on NEFT/RTGS/KYC terms | | |
| B-14 | Any insurance site | Coverage-gap advisory banner | | |
| B-15 | Any insurance site | Jargon decoder (35 terms) | | |
| B-16 | `en.wikipedia.org` | Audit score computes in side panel | | |
| B-17 | `en.wikipedia.org` | Reading mode renders cleanly | | |
| B-18 | `en.wikipedia.org` | Summarize extracts key points | | |
| B-19 | `bbc.com/hindi` (non-English) | Auto-language-detect triggers | | |
| B-20 | `bbc.com/hindi` | Voice nav uses Hindi (`hi-IN`) | | |

---

## C. Side Panel

| # | Item | Status | Notes |
|---|---|---|---|
| C-01 | Side panel opens via action-icon right-click → "Open side panel" | | |
| C-02 | Real-time adaptation log updates as features fire | | |
| C-03 | AI Insights: page complexity score + summary + recommendations | | |
| C-04 | Accessibility Audit: "Run Audit" scans page in < 2 s | | |
| C-05 | Accessibility Audit: findings grouped by severity, click-to-highlight works | | |
| C-06 | Accessibility Audit: "Export PDF" downloads valid multi-page PDF | | |
| C-07 | Profile History tab: lists versions, diff + rollback work (if UI wired) | | |
| C-08 | Action Items tab: aggregates TODOs from visited pages | | |

---

## D. Background Service Worker

| # | Item | Status | Notes |
|---|---|---|---|
| D-01 | `chrome://extensions` → Inspect service worker → zero console errors at boot | | |
| D-02 | Messages route correctly (watch `chrome.runtime.sendMessage` in DevTools Network) | | |
| D-03 | AI engine responds to `SUMMARIZE_TEXT` | | |
| D-04 | AI engine responds to `SIMPLIFY_TEXT` | | |
| D-05 | AI engine responds to `SUMMARIZE_EMAIL` | | |
| D-06 | Observatory publisher fires (check `chrome.storage.local` for `obsState`) | | |
| D-07 | Observatory publisher posts to VPS (check VPS `/api/observatory/summary` shows new data within 60 s of opt-in) | | |
| D-08 | Struggle detector accumulates signals, pushes adaptations (watch adaptation log in side panel) | | |

---

## E. VPS Integration

| # | Item | Status | Notes |
|---|---|---|---|
| E-01 | Observatory publishing visible on dashboard `http://72.61.227.64:8300/observatory/` | | |
| E-02 | Landing page Observatory preview pulls real data | | |
| E-03 | Extension update-check notices version bump: bump manifest patch, rebuild, upload, check via popup | | |

---

## F. Error Recovery

| # | Item | Status | Notes |
|---|---|---|---|
| F-01 | Disable network → extension still works offline (local AI tier) | | |
| F-02 | Deny camera permission → eye tracker + environment sensing degrade gracefully | | |
| F-03 | Deny mic permission → voice nav + captions show explainer | | |
| F-04 | Visit `chrome://extensions` URL → content script does not crash | | |
| F-05 | Complex SPA (e.g. Slack web) → no hangs, memory stable over 10 min | | |

---

## Session 8 Decision — Manual QA Deferred

**Status as of 2026-04-21:** The 54-item Chrome sideload matrix above is held for the user to drive on their own time before submission. Reason: a Claude Code session cannot drive a browser, and an interactive batch-by-batch run was deprioritized in favor of locking down the rest of the submission package.

**What WAS verified this session (deterministic signals — not a substitute for browser QA, but the floor):**

- `pnpm typecheck` — green across all 3 packages
- `pnpm -r test` — **544 / 544 passing** (ai-engine 54 · core 382 · extension 108)
- `pnpm build` — green; output bundles within expected size envelope (content 322 KB, background 36 KB, popup 30 KB, sidepanel 414 KB)
- BUG-008 IIFE-collision guard: `node -c packages/extension/dist/src/{content,background}/index.js` both pass
- Build-time WIP bug fix: removed unused `AIRequestType` cast in [packages/ai-engine/src/services/action-items.ts](packages/ai-engine/src/services/action-items.ts) which was breaking the cross-package `tsc` pass during extension build
- All RCA prevention rules (BUG-001 through BUG-009) re-asserted by build pipeline

**Known unfinished work carried into the build (acknowledged, harmless):**

- [packages/extension/src/content/cognitive/action-items-ui.ts](packages/extension/src/content/cognitive/action-items-ui.ts) — new on-page FAB + side panel UI, **never imported anywhere**, so Rollup tree-shakes it from the bundle. CSS classes `.ab-action-fab` / `.ab-action-panel` are also missing from `styles.css`. Either wire it (~30 min of integration work + CSS) or remove it in a future session.
- [packages/ai-engine/src/services/action-items.ts](packages/ai-engine/src/services/action-items.ts) `ActionItemsService` + background `EXTRACT_ACTION_ITEMS` handler — wired into the background bundle but no content-side caller. Adds ~1.5 KB of dead weight to the SW bundle.

**Browser-only behaviors that the test suite cannot prove (the user-driven matrix above is the only way to verify these):**

- Web Speech API live-captions overlay actually appearing on a real `<video>`
- Voice navigation + Hindi voice command response on real Gmail/SBI pages
- Eye tracker calibration UX flow with a real webcam
- Side panel "Run Audit" → real PDF download
- Observatory publishing actually arriving at VPS within 60 seconds of opt-in
- Update-check round-trip popup ↔ VPS `/api/version`

## Recommendation for the user (≤ 30 min before submission)

1. Spend 15 minutes on the **must-work tier** from `DEMO_LIVE_SCRIPT.md` — Sensory font scale, Focus Mode, Struggle Score gauge. If those three are PASS, the demo has a deterministic floor.
2. Spend 10 minutes on the **should-work tier** — Voice nav, Distraction Shield, AI Summarize on Gmail. Note any FAIL in this section as a "known issue" speaker note.
3. Spend 5 minutes capturing the 13 screenshots listed under `deliverables/screenshots/SCREENSHOT_GUIDE.md` (or capture inside the demo recording itself and crop later).

## Go / No-Go Signal

🟢 **GO for submission** — extension build is clean, all 544 unit tests pass, deliverables package assembled with judge-facing README, demo docs cover three formats (recorded, checklist, live), PPT updated with current numbers and roadmap. Manual browser QA is the user's last 30-minute pre-submission spot check, not a blocker for the artifacts to be in place.

⚠️ The above 🟢 is conditional on the user's spot-check confirming no Chrome-runtime regression introduced by the WIP captions/action-items diff. If the spot-check finds a P0 (extension fails to load, content script crashes on every page), that triggers the rollback plan: `git revert` the WIP commit, rebuild from v0.4.0, redeploy.
