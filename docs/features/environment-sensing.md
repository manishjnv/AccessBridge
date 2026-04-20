# Environment Sensing (Layer 3 — Context Intelligence)

AccessBridge can optionally sense the user's ambient environment — light level,
noise level, network quality, and time of day — and feed those signals into the
struggle detector and decision engine so adaptations match the room, not just
the user. This document describes exactly what is sensed, what is never
collected, how it influences adaptation, and the opt-in / permission flow.

**Opt-in only, off by default.**

## What is sensed

- **Ambient light** — a single 160×120 webcam frame is captured every 30 s,
  the pure function [`calculateBrightness`](../../packages/core/src/signals/environment.ts)
  reduces it to one Rec. 709 luma number 0–1, and the frame is discarded in
  the same event-loop tick.
- **Ambient noise** — a microphone time-domain window is read every 15 s,
  reduced to one RMS number 0–1 by [`calculateNoiseLevel`](../../packages/core/src/signals/environment.ts),
  and the sample buffer is not retained past the call.
- **Network quality** — read from
  `navigator.connection.effectiveType` + `downlink` when available,
  mapped to `poor|fair|good|excellent`.
- **Time of day** — local hour bucketed into
  `morning|afternoon|evening|night`.

## What is NOT collected

- No images are ever stored, logged, or transmitted.
- No audio is ever recorded, transcribed, or transmitted.
- No identifying information — no face recognition, voice ID, speech content,
  or biometric features of any kind.
- No network traffic beyond the extension's existing message channels.
- Raw webcam / microphone data is garbage-collected within milliseconds of
  each sample. Only the derived single-number snapshot leaves the sampling
  function.

## How it adapts

Snapshots feed into [`computeEnvironmentalAdaptationHints`](../../packages/core/src/signals/environment.ts),
which returns three hints:

| Signal | Hint                                                                                      |
| ------ | ----------------------------------------------------------------------------------------- |
| Dark room (light < 0.2)  | `suggestedContrast: 1.8`, `suggestedFontScale: 1.15` — reduces eye strain |
| Dim light (< 0.5)        | `suggestedContrast: 1.3`, `suggestedFontScale: 1.1`                       |
| Bright light (≥ 0.8)     | `suggestedContrast: 0.9` — reduces washout                                |
| Noisy (noise ≥ 0.5)      | `voiceReliability` drops sharply → decision engine prefers keyboard/click |
| Quiet (noise < 0.2)      | `voiceReliability: 1.0`                                                   |
| Late evening / night     | Small font + contrast nudge (fatigue counterpart)                         |
| Poor network             | `voiceReliability` capped at 0.4 (cloud STT degrades on poor links)       |
| Fair network             | `voiceReliability` capped at 0.7                                          |

## Opt-in flow

1. User enables **Environment Sensing** in the popup — sets
   `profile.environmentSensingEnabled = true`.
2. On next page load the in-page explainer overlay appears (see
   [`permission-flow.ts`](../../packages/extension/src/content/context/permission-flow.ts))
   describing in plain English *what* AccessBridge will access and *why*.
3. On **Continue**, the browser's own `getUserMedia` permission prompt
   appears. On **Not now**, the sensor still starts but only emits
   time-of-day + network snapshots; `lightLevel` and `noiseLevel` stay `null`.
4. The choice is remembered in `chrome.storage.local` so the explainer
   doesn't re-appear every page load.

## Permission handling

- **Granular toggles.** `profile.environmentLightSampling` and
  `profile.environmentNoiseSampling` independently control which streams
  are requested. You can enable just light, just noise, or both.
- **Deny is non-blocking.** If the user denies either permission, the
  sensor continues with a `null` reading for that channel and keeps
  time-of-day + network active.
- **Instant revoke.** Toggling the master switch off calls
  `stopEnvironmentSensor()`, which stops all `MediaStream` tracks, closes
  the `AudioContext`, clears every interval, and releases the indicator.
- **Always visible when active.** The floating indicator at bottom-left
  (see [`environment-indicator.ts`](../../packages/extension/src/content/context/environment-indicator.ts))
  shows sun / mic / wifi icons that fade to 30 % opacity when a channel
  is inactive, making sensing state observable at a glance.

## Privacy guarantees

1. **Sampling-only.** No continuous recording — the webcam frame and mic
   buffer are read once per interval and discarded.
2. **Immediate discard.** Raw data enters a pure function and the reference
   is never retained past that function call.
3. **No storage of raw data.** Only the single-number snapshot (~100 bytes,
   all primitives) is kept in memory and forwarded to the background worker.
4. **No raw-data network transmission.** Snapshots are sent via
   `chrome.runtime.sendMessage({ type: 'ENVIRONMENT_UPDATE', payload: snapshot })`
   to the in-extension background service worker only — they never leave
   the device.
5. **Opt-in with explicit UI.** Disabled by default, requires a toggle plus
   an in-page explainer before the browser prompt.
6. **Granular control.** Light and noise are independently toggleable;
   either can be off while the other is on.
7. **Observable.** The floating indicator makes sensing visible whenever
   it's active.
8. **Revocable.** A single toggle disables everything and releases all
   hardware streams.

## Integration surface

- [`packages/core/src/signals/environment.ts`](../../packages/core/src/signals/environment.ts)
  — pure signal functions (`calculateBrightness`, `calculateNoiseLevel`,
  `inferLightingCondition`, `inferNoiseEnvironment`, `inferTimeOfDay`,
  `inferNetworkQualityFromEffectiveType`, `computeEnvironmentalAdaptationHints`).
- [`packages/core/src/types/signals.ts`](../../packages/core/src/types/signals.ts)
  — `EnvironmentSnapshot`, `EnvironmentContext`, `EnvironmentSignalType`
  enum, and qualitative-bucket types.
- [`packages/extension/src/content/context/environment-sensor.ts`](../../packages/extension/src/content/context/environment-sensor.ts)
  — runtime `EnvironmentSensor` class: permission handling, stream
  lifecycle, interval-based sampling, snapshot emission.
- [`packages/extension/src/content/context/permission-flow.ts`](../../packages/extension/src/content/context/permission-flow.ts)
  — in-page explainer + stored-decision memory.
- [`packages/extension/src/content/context/environment-indicator.ts`](../../packages/extension/src/content/context/environment-indicator.ts)
  — visible pill at bottom-left with live icon states.
- [`packages/extension/src/content/index.ts`](../../packages/extension/src/content/index.ts)
  — hooks into content-script lifecycle: starts on `profile.environmentSensingEnabled`,
  responds to `PROFILE_UPDATED`, tears down on `REVERT_ALL`.

## Testing

- Core unit tests: [`packages/core/src/__tests__/environment.test.ts`](../../packages/core/src/__tests__/environment.test.ts)
  — 38 tests across all pure functions, including boundary conditions
  (0.2 / 0.5 / 0.8 thresholds) and null-signal fallbacks.
- Sensor integration tests: [`packages/extension/src/content/context/__tests__/environment-sensor.test.ts`](../../packages/extension/src/content/context/__tests__/environment-sensor.test.ts)
  — 7 tests covering permission denial, interval emission, clean teardown,
  snapshot immutability, multiple subscribers.
