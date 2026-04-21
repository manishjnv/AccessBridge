# AccessBridge — Architecture

System design reference. Feature catalog lives in [FEATURES.md](FEATURES.md); this doc explains how it all wires up.

---

## 1. Monorepo structure

Workspace: [pnpm-workspace.yaml](pnpm-workspace.yaml) — `packages/*`.

| Package | Path | Role |
|---------|------|------|
| `@accessbridge/extension` | [packages/extension](packages/extension) | Chrome MV3 extension (UI + content script + SW) |
| `@accessbridge/core` | [packages/core](packages/core) | Signal detection, decision engine, profile store |
| `@accessbridge/ai-engine` | [packages/ai-engine](packages/ai-engine) | Tiered AI orchestration (local / Gemini / Claude) |

Dependency flow: `extension` imports `core` and `ai-engine`. `core` and `ai-engine` have no inter-dependency.

---

## 2. Chrome MV3 contexts

Defined in [packages/extension/manifest.json](packages/extension/manifest.json).

| Context | Entry | Role |
|---------|-------|------|
| Service worker | [src/background/index.ts](packages/extension/src/background/index.ts) | Message router, core engine host, AI orchestrator, storage broker |
| Content script | [src/content/index.ts](packages/extension/src/content/index.ts) | Signal collection, feature instantiation, DOM adaptation |
| Popup | [src/popup/index.html](packages/extension/src/popup/index.html) | React 18 UI — feature toggles, profile, struggle score |
| Side panel | [src/sidepanel/index.html](packages/extension/src/sidepanel/index.html) | Extended dashboard — history, AI insights, page score |

Permissions: `activeTab`, `storage`, `offscreen`, `sidePanel`, `downloads`. Host: `<all_urls>`.

---

## 3. Message flow

Central dispatcher: `packages/extension/src/background/index.ts` — `chrome.runtime.onMessage.addListener`.

### Message types

| Message | From → To | Purpose |
|---------|-----------|---------|
| `GET_PROFILE` | Popup/content → BG | Retrieve accessibility profile |
| `SAVE_PROFILE` | Popup → BG | Persist profile; triggers `PROFILE_UPDATED` broadcast |
| `PROFILE_UPDATED` | BG → all content | Live profile propagation |
| `SIGNAL_BATCH` | Content → BG | Behavior signals (every 5s) — feeds StruggleDetector + DecisionEngine |
| `APPLY_ADAPTATION` | BG → Content | Apply single adaptation (sensory/cognitive/motor) |
| `REVERT_ADAPTATION` | Popup/BG → Content | Revert single adaptation by ID |
| `REVERT_ALL` | Popup → all content | Clear all adaptations — master toggle (RCA-related, see BUG-008) |
| `TOGGLE_FEATURE` | Popup/voice → BG | Enable/disable named feature |
| `APPLY_SENSORY` | Popup → Content | Direct sensory control (bypass BG) |
| `TAB_COMMAND` | Voice → BG | Tab ops: next, prev, close, new |
| `SUMMARIZE_TEXT`, `SUMMARIZE_EMAIL`, `SIMPLIFY_TEXT`, `AI_READABILITY` | Content → BG | AI pipeline entries |
| `AI_SET_KEY`, `AI_GET_STATS` | Popup → BG | AI config + cost stats |
| `CHECK_UPDATE`, `APPLY_UPDATE` | Popup → BG | Self-update: fetch manifest + `chrome.runtime.reload()` |
| `GET_STRUGGLE_SCORE`, `GET_ACTIVE_ADAPTATIONS` | Popup → BG | Dashboard polling |

### Data flow

```
┌─────────┐  SAVE_PROFILE       ┌────────────┐   PROFILE_UPDATED   ┌──────────────┐
│  Popup  │ ──────────────────▶ │ Background │ ──broadcast to────▶ │ Content × N  │
└─────────┘                     │   Router   │                     └──────────────┘
     ▲                          │            │                            │
     │  GET_STRUGGLE_SCORE      │  + Engines │ ◀────SIGNAL_BATCH──────────┘
     │  (poll every 3s)         │            │      (every 5s)
     │                          │            │
     └──TOGGLE_FEATURE─────────▶│            │──APPLY_ADAPTATION──▶ Content (same tab)
                                └────────────┘
                                       │
                                       │  SUMMARIZE_* / SIMPLIFY_*
                                       ▼
                                ┌────────────┐
                                │ AI Engine  │  cache → normalize → cost check
                                │ (lazy init)│  → provider (local / gemini / claude)
                                └────────────┘
```

All `tab.sendMessage` calls are wrapped `.catch(() => {})` — missing content scripts are non-fatal.

---

## 4. Storage strategy

### `chrome.storage.local`

| Key | Type | Purpose |
|-----|------|---------|
| `profile` | `AccessibilityProfile` | Full user config — sensory + cognitive + motor + language + adaptationMode + confidenceThreshold |
| `accessbridge_enabled` | boolean | Master on/off (popup) |
| `activeFeatures` | `Record<string, boolean>` | Per-feature toggles; survives popup close (see RCA BUG-005) |

### In-memory (Background SW)

Singleton lifetime — reset on SW suspension (~5min idle):

- `currentProfile: AccessibilityProfile`
- `activeAdaptations: Map<string, Adaptation>`
- `latestStruggleScore: StruggleScore`
- `struggleDetector`, `decisionEngine`, `aiEngine`, `summarizer`, `simplifier` — lazy-init singletons

### In-memory (Content script)

- Feature-module singletons — lazy-init on first toggle
- `signalBuffer: BehaviorSignal[]` — flushed to BG every 5s

**Rule:** any state that must persist across popup close/reopen → `chrome.storage.local` (see RCA BUG-005).

---

## 5. AI engine

Package: [packages/ai-engine](packages/ai-engine). Default tier: **local** (zero cost, offline). Upgrade by supplying API keys.

### Request lifecycle

```
Input
  │
  ▼
Cache lookup (key = "${type}:${hash(input)}") ──hit──▶ Return
  │ miss
  ▼
Normalize (dedup email threads, strip HTML, truncate to token budget)
  │
  ▼
Cost check ──over budget──▶ Downgrade tier
  │ ok
  ▼
Provider dispatch (premium → low-cost → local)
  │
  ▼
Populate cache + track cost
  │
  ▼
Return
```

Tier order: `['premium', 'low-cost', 'local']` in `engine.ts` `TIER_ORDER`.

### Providers

| Provider | Tier | Cost indication | Use case |
|----------|------|-----------------|----------|
| Local | `local` | Free | Rule-based; 180-term simplify map + extractive summarization |
| Gemini Flash | `low-cost` | ~$0.075/1M input tokens | Default upgrade path |
| Claude Sonnet | `premium` | Higher per-token | Quality-critical paths |

### Services

- **SummarizerService** — `summarizeDocument()`, `summarizeEmail()`, `summarizeMeeting()`
- **SimplifierService** — `simplifyText(level: 'mild' \| 'strong')`, `getReadabilityScore()` (Flesch-Kincaid)

---

## 6. Core engine

Package: [packages/core](packages/core).

### StruggleDetector

- 60-second sliding window (`WINDOW_DURATION_MS`)
- 10 signal types, weighted 0.07–0.15
- Deviation-from-baseline scoring: `abs(normalized - mean) / stddev`, clamped [0,1]
- Output: `StruggleScore { score: 0-100, confidence: 0-1, signals[], timestamp }`
- Re-calibrates baseline every ~30 batches

### DecisionEngine

Rules (excerpt, see `packages/core/src/decision/engine.ts`):

| Trigger | Action |
|---------|--------|
| `struggle > 60 && clickAccuracy < 0.3` | `CLICK_TARGET_ENLARGE` @ 1.5x |
| `struggle > 40 && readingSpeed < 0.3` | `FONT_SCALE` @ 1.25x |
| `struggle > 50 && scrollVelocity > 0.7` | `LAYOUT_SIMPLIFY` |
| `struggle > 60 && backspaceRate > 0.6` | `TEXT_SIMPLIFY` @ mild |
| (plus rules for cursor, focus mode, contrast) | |

Outputs `Adaptation[]` with ID, type, value, confidence, reversible flag.

### Profile structure

```ts
AccessibilityProfile = {
  id, version: 1, createdAt, updatedAt,
  sensory:  { fontScale, contrastLevel, colorCorrectionMode, lineHeight,
              letterSpacing, cursorSize, reducedMotion, highContrast },
  cognitive: { focusModeEnabled, readingModeEnabled, textSimplification,
               notificationLevel, autoSummarize, distractionShield },
  motor:    { voiceNavigationEnabled, eyeTrackingEnabled, smartClickTargets,
              predictiveInput, keyboardOnlyMode, dwellClickEnabled, dwellClickDelay },
  language: 'en' | 'hi' | 'es' | 'fr' | 'de' | 'zh' | 'ja' | 'ar',
  adaptationMode: 'auto' | 'manual' | 'suggest',
  confidenceThreshold: 0-1,
}
```

---

## 7. Build + deploy flow

### Build ([packages/extension/vite.config.ts](packages/extension/vite.config.ts))

1. TypeScript → ES modules
2. Rollup input: `background`, `content`, `popup` (HTML), `sidepanel` (HTML)
3. Post-build plugin `copyManifestPlugin`:
   - Inline-wraps content-script shared chunks in IIFEs (Chrome content scripts don't support ES modules)
   - Wraps entire content script in outer IIFE (avoid global pollution)
   - Copies `manifest.json` to `dist/` (strips `type: "module"` from content entry)
   - Copies icons

**Invariant:** `base: ''` in Vite config → relative asset paths required for `chrome-extension://` origin (see RCA BUG-001).

### Deploy ([deploy.sh](deploy.sh))

Pipeline:

```
[1] typecheck + build + test  (parallel, local)
[2] push to GitHub
[3] rsync artifacts           (zip → /opt/accessbridge/docs/downloads/, deploy/ → /var/www/accessbridge/)
[4] VPS sync                  (git fetch+reset, conditional pnpm install by lockfile hash)
[5] health check              (curl $HEALTH_URL, match version)
[6] summary
```

Test skip is cached by commit SHA (`/tmp/accessbridge-last-tested.sha`); dirty working tree invalidates cache.

---

## 8. Content script init

Per-page sequence:

1. App detection: hostname → `'gmail' | 'outlook' | 'docs' | 'teams' | 'generic'`
2. Load profile from `chrome.storage.local`
3. Spawn signal collectors (scroll, click, typing, mouse)
4. Instantiate enabled feature modules (lazy)
5. Start signal-batch timer (5s flush)
6. Register `chrome.runtime.onMessage` handlers for apply/revert/toggle
7. Register `chrome.storage.onChanged` listener for live feature toggles

---

## 8b. Layer 5 — Multi-Modal Fusion (Session 11)

A parallel on-device pipeline running inside the content script that unifies
every input channel (keyboard · mouse · touch · pointer · screen · gaze · voice
· env-light · env-noise · env-network) into a single time-aligned event stream,
then re-weights channels when one is degraded and infers user intent via seven
rule-based detectors.

- **Engine** — [packages/core/src/fusion/fusion-engine.ts](packages/core/src/fusion/fusion-engine.ts). Ring buffer (3 s / 500 events default), 100 ms emit tick, pub-sub for `FusedContext` and `IntentHypothesis`.
- **Quality estimator** — [packages/core/src/fusion/quality-estimator.ts](packages/core/src/fusion/quality-estimator.ts). Per-channel heuristics using SNR, face-detection ratio, inter-event variance, smoothness, etc.
- **Compensator** — [packages/core/src/fusion/compensator.ts](packages/core/src/fusion/compensator.ts). Five built-in rules (noisy-degrades-voice, low-light-degrades-gaze, poor-network-degrades-voice, typing-flurry-suppresses-gaze, reading-elevates-gaze).
- **Intent inference** — [packages/core/src/fusion/intent-inference.ts](packages/core/src/fusion/intent-inference.ts). Seven intents: click-imminent, hesitation, reading, searching, typing, abandoning, help-seeking.
- **Content wiring** — [packages/extension/src/content/fusion/](packages/extension/src/content/fusion/). Pure adapters per channel + FusionController which rate-limits intent forwarding (1.5 s per type) and routes through FUSION_INTENT_EMITTED to the background.
- **Decision-engine intent path** — [packages/core/src/decision/engine.ts](packages/core/src/decision/engine.ts) `evaluateIntent()` maps intents to `INTENT_HINT` adaptations.
- **UI** — popup Settings section "Multi-Modal Fusion (Layer 5)" + new sidepanel "Intelligence" tab with live channel bars, environment panel, intent timeline.

**Privacy invariant:** all fusion runs on-device; the `FUSION_INTENT_EMITTED`
message carries only the aggregate intent + confidence + adaptation tags + event
*count* — never raw event payloads. No new manifest permissions (fusion
consumes already-consented streams).

Docs: [docs/features/multi-modal-fusion.md](docs/features/multi-modal-fusion.md). Tests: 114 (quality-estimator 26 · compensator 25 · intent-inference 43 · fusion-engine 20) + 13 content-side integration tests.

---

## 9. Architectural properties worth knowing

1. **Cost-aware AI by default** — local tier always available; no API key required for baseline function
2. **Reversible adaptations** — every applied adaptation has an ID, can be reverted individually or via `REVERT_ALL`
3. **Adaptive baseline** — struggle score is *deviation* from user's own baseline, not absolute signals
4. **Lazy engine init** — AI + decision + summarizer services boot on first message, keeping SW cold-start fast
5. **Stateless content scripts** — adaptations applied on-demand via messages; no state sync between tabs
6. **Self-update mechanism** — version check via update server; `chrome.runtime.reload()` on user confirm (works for sideloaded extensions)
7. **Master toggle uses direct content-script messaging** — `REVERT_ALL` sent to all tabs directly, not via BG routing (see RCA commit `ca750d8`)

---

## 10. See also

- [FEATURES.md](FEATURES.md) — current feature catalog
- [RCA.md](RCA.md) — bug fix log (BUG-001 through BUG-008)
- [HANDOFF.md](HANDOFF.md) — session-by-session activity log
- [DEFERRED.md](DEFERRED.md) — post-submission backlog
- [CLAUDE.md](CLAUDE.md) — Claude Code session instructions
