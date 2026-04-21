# Multi-Modal Fusion (Layer 5)

**Status:** Shipped in v0.8.0 (Session 11, 2026-04-21).
**Code:** [`packages/core/src/fusion/`](../../packages/core/src/fusion/), [`packages/extension/src/content/fusion/`](../../packages/extension/src/content/fusion/).
**Popup entry:** Settings tab → "Multi-Modal Fusion (Layer 5)".
**Side panel entry:** "Intelligence" tab.

## Why this layer exists

Prior accessibility systems treat each input (keyboard, mouse, voice, camera) independently. AccessBridge now fuses them into a **single time-aligned event stream**, which enables three qualitatively new capabilities:

1. **Signal Unification** — one ring buffer, monotonic clock, one quality estimator per channel.
2. **Cross-Modal Compensation** — when one input channel is degraded, others are re-weighted. Noisy rooms reduce voice reliance; poor lighting reduces gaze reliance.
3. **Intent Inference** — rule-based patterns detect seven high-level user intents (reading, hesitation, click-imminent, searching, typing, abandoning, help-seeking) and trigger corresponding subtle adaptations.

This is the only architectural layer from the plan that was not implemented in V3; closing it materially improves the struggle-detection quality that is AccessBridge's core differentiator.

## Architecture

```
 ┌─── adapters (content script) ─────────────────────────────────┐
 │ keyboard · mouse · touch · pointer · screen                    │
 │ gaze (from EyeTracker.onGaze)                                  │
 │ voice (from VoiceCommandSystem.onCommand)                      │
 │ env-light / env-noise / env-network (from EnvironmentSensor)   │
 └───────────────────────┬────────────────────────────────────────┘
                         │  ingest(IngestEvent)           100 ms tick
                         ▼                                    │
              ┌──────── FusionEngine ──────────┐               │
              │  ring buffer (3 s / 500 evts)  │               │
              │  quality estimator per channel │               │
              │  cross-modal compensator       │               │
              │  intent inference (7 detectors)│               │
              └────────┬────────────┬──────────┘               │
                       │            │                          │
             ┌─────────▼──┐   ┌─────▼──────────────────┐       │
             │ FusedContext   │ IntentHypothesis (≥ T) │       │
             │ subscribers    │ subscribers            │       │
             └────────────────┴──────────┬─────────────┘       │
                                         │                     │
                                         ▼                     │
                        FusionController rate-limits per type  │
                                         │                     │
                                         ▼                     │
                   chrome.runtime.sendMessage                   │
                   FUSION_INTENT_EMITTED                        │
                                         │                     │
                                         ▼                     │
                   background → DecisionEngine.evaluateIntent()
                            → APPLY_ADAPTATION (type: INTENT_HINT)
                            → broadcast FUSION_INTENT_EMITTED
                              so sidepanel Intelligence tab updates.
```

## Channel quality heuristics

| Channel      | Inputs used                                              | Example lowering conditions             |
|--------------|----------------------------------------------------------|------------------------------------------|
| voice        | `data.snr`, `data.transcriptConfidence`, env-noise bucket | noisy room halves confidence             |
| gaze         | `data.brightness`, face-detected ratio, blink rate       | dark room halves confidence              |
| keyboard     | inter-event variance, backspace ratio                    | erratic rhythm drops consistency         |
| mouse        | velocity variance / provided smoothness                  | jittery path drops confidence            |
| touch / pointer | `data.gestureConfidence` (default 0.7)               | —                                        |
| env-light / env-noise / env-network / screen | latest event `data.value` pass-through | — |

All heuristics are **pure** (`packages/core/src/fusion/quality-estimator.ts`) and tested in `__tests__/quality-estimator.test.ts` (26 tests).

## Cross-modal compensation rules

Five built-in rules ship in `DEFAULT_COMPENSATION_RULES`:

| Rule                            | Condition                                               | Effect                               |
|---------------------------------|----------------------------------------------------------|---------------------------------------|
| `noise-degrades-voice`          | `env-noise.confidence > 0.6`                             | voice ×0.5, keyboard + pointer ↑     |
| `low-light-degrades-gaze`       | `env-light.confidence < 0.2`                             | gaze ×0.4, mouse ↑                    |
| `poor-network-degrades-voice`   | `env-network.confidence < 0.3`                           | voice ×0.7, keyboard ↑                |
| `typing-flurry-suppresses-gaze` | `keyboard.sampleRate > 5`                                | gaze ×0.5 (defer UI adaptations)      |
| `reading-elevates-gaze`         | `gaze.confidence > 0.6 && mouse.sampleRate < 0.3`        | gaze ↑ (signals reading)              |

Weights are normalized so `sum(non-zero weights) === activeCount` — rule factors compose multiplicatively and can't blow up. Boost factor per-rule is `1 + (1 − factor)`.

Tests: 25 cases in `__tests__/compensator.test.ts`.

## Intent taxonomy

Seven intent detectors, each implementable by a short rules-based pattern over the fused context:

| Intent                | Signals                                                                 | Adaptations                                  |
|-----------------------|-------------------------------------------------------------------------|-----------------------------------------------|
| `click-imminent`      | gaze on button/link + cursor converging + decelerating                  | subtle preview tooltip                         |
| `hesitation`          | cursor idle + gaze fixated + no click for 1.5 s                         | confirmation widget, inline help               |
| `reading`             | stable gaze + slow scroll + no keyboard/mouse for 2 s                   | offer reading mode                             |
| `searching`           | rapid scroll + scanning gaze + backspace key                            | find-in-page helper                            |
| `typing`              | keyboard rate > 2/s + focus in input/textarea/editable                  | suppress interruptions                         |
| `abandoning`          | tab-switch-pending / beforeunload + recent input edit                   | auto-save form draft                           |
| `help-seeking`        | hover dwell without click + scroll direction changes                    | contextual help panel                          |

Each detector returns `{ intent, confidence, supportingEvents, suggestedAdaptations }`. The main function `inferIntent(context)` sorts by confidence desc and returns all non-zero hypotheses.

Tests: 43 cases in `__tests__/intent-inference.test.ts`.

## Privacy

- **All fusion is on-device.** The ring buffer lives in the content script's memory and never leaves the tab.
- **No raw event payloads cross the service-worker bridge.** `FUSION_INTENT_EMITTED` carries only the intent type, aggregate confidence, suggested-adaptation tags, and the *count* of supporting events — never the events themselves.
- **No new manifest permissions** were added in Session 11. Fusion consumes streams that already have user consent (mic via `environmentSensingEnabled` + voice navigation, camera via `eyeTrackingEnabled` + environment sensing).
- **Opt-out is one click.** The master toggle in popup Settings → "Enable fusion" stops the engine and disposes the buffer immediately. All sensors continue to function standalone.

## Integration points

| Existing module         | How fusion connects                                                                                              |
|--------------------------|-----------------------------------------------------------------------------------------------------------------|
| StruggleDetector         | unchanged — still emits via SIGNAL_BATCH. Fusion runs in parallel and does **not** modify the struggle pipeline. |
| EnvironmentSensor        | `onSnapshot` callback now also calls `FusionController.reportEnvironment()`.                                     |
| EyeTracker               | `onGaze` callback now also calls `FusionController.reportGaze()`.                                                |
| VoiceCommandSystem       | `handleVoiceCommand` now also calls `FusionController.reportVoice()`.                                            |
| DecisionEngine           | new `evaluateIntent(hypothesis)` method maps `IntentType → Adaptation[]` with type `INTENT_HINT`.                |

## Tuning guide

| Parameter                          | Default | Effect                                                        |
|-------------------------------------|---------|----------------------------------------------------------------|
| `fusionWindowMs`                    | 3000    | Larger windows detect slow patterns (reading) but add latency. |
| `fusionCompensationEnabled`         | true    | Turn off to see raw channel weights without re-balancing.      |
| `fusionIntentMinConfidence`         | 0.65    | Lower → more intent fires, higher false-positive rate.         |
| FusionController rate-limit (hard)  | 1500 ms | One fire per intent-type per 1.5 s; avoids adaptation flapping.|

## Known limitations (documented for Phase 2 ML upgrade)

- Intent inference is rules-based. A small on-device neural model would improve false-positive rate — deferred to a future session.
- No cross-tab fusion (events from multiple tabs merged). Out of scope.
- No mobile sensor channels (accelerometer, magnetometer) — not in plan.

## See also

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — where this layer fits in the MV3 context.
- [RCA.md](../../RCA.md) — BUG-012 is the reason vite's content-script IIFE plugin now handles deep chunk graphs; adding `@accessbridge/core/fusion` to the content import set was the same pattern that triggered that bug.
