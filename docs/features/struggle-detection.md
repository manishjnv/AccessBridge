# Struggle Signal Detection

**Status:** Implemented  
**Package:** `@accessbridge/core`  
**Source:** `packages/core/src/signals/struggle-detector.ts`

## Overview

The Struggle Detector is the perception layer of AccessBridge. It monitors 10 types of behavioral signals, compares them against the user's personal baseline, and produces a single struggle score (0-100) with an associated confidence value (0-1). This score drives the Decision Engine's adaptation logic.

## Signal Types and Weights

| Signal | Type Enum | Weight | What It Measures |
|--------|-----------|--------|------------------|
| Scroll Velocity | `SCROLL_VELOCITY` | 0.08 | Rapid or erratic scrolling indicating disorientation |
| Click Accuracy | `CLICK_ACCURACY` | 0.15 | Missed clicks, clicking near but not on targets |
| Dwell Time | `DWELL_TIME` | 0.10 | Extended time hovering over elements (confusion/hesitation) |
| Typing Rhythm | `TYPING_RHYTHM` | 0.12 | Irregular keystroke timing patterns |
| Backspace Rate | `BACKSPACE_RATE` | 0.12 | Frequency of corrections while typing |
| Zoom Events | `ZOOM_EVENTS` | 0.10 | Pinch-to-zoom or Ctrl+scroll zoom attempts |
| Cursor Path | `CURSOR_PATH` | 0.08 | Excessive mouse movement or circular cursor patterns |
| Error Rate | `ERROR_RATE` | 0.10 | Form validation failures, repeated failed actions |
| Reading Speed | `READING_SPEED` | 0.08 | Unusually slow or fast reading pace |
| Hesitation | `HESITATION` | 0.07 | Pauses before interacting with UI elements |

**Total weight:** 1.00

### Weight Rationale

Click accuracy and typing-related signals (typing rhythm, backspace rate) carry the highest weights because they are the strongest indicators of motor or cognitive difficulty. Scroll velocity and cursor path have lower weights because they can vary significantly based on content length and page layout rather than user struggle.

## Baseline Tracking

Each user builds a personal baseline over time. The baseline stores, per signal type:

```typescript
interface SignalBaseline {
  mean: number;       // Average normalized value
  stddev: number;     // Standard deviation
  sampleCount: number; // Total samples incorporated
}
```

### Baseline Initialization

When no historical data exists, the detector starts with a default baseline:
- **Mean:** 0.5 (center of normalized range)
- **Standard deviation:** 0.2 (moderate variability assumed)
- **Sample count:** 0

This default is deliberately neutral -- it avoids triggering adaptations until real data accumulates.

### Baseline Updates (Exponential Moving Average)

The baseline is updated using an EMA blend:

```
alpha = min(newSampleCount / totalSampleCount, 0.3)
blendedMean = oldMean * (1 - alpha) + newMean * alpha
blendedStddev = max(oldStddev * (1 - alpha) + newStddev * alpha, 0.05)
```

Key properties:
- **Alpha capped at 0.3** -- prevents a single session from overwhelming historical data
- **Minimum stddev of 0.05** -- prevents the baseline from becoming so tight that normal variation triggers false positives
- **Requires at least 2 samples** per signal type before updating that signal's baseline

Over a 7-day rolling usage window, the baseline converges toward the user's natural interaction patterns, allowing the detector to distinguish genuine struggle from normal behavior.

## Struggle Score Calculation

### Sliding Window

The detector maintains a 60-second sliding window of signals. Signals older than 60 seconds are pruned on every access. This ensures the score reflects current behavior, not stale data.

### Scoring Algorithm

For each signal in the window:

1. **Compute deviation:** How far the signal's normalized value is from the baseline mean, scaled by the baseline standard deviation:
   ```
   deviation = |signal.normalized - baseline.mean| / baseline.stddev
   ```

2. **Clamp and normalize:** The deviation is clamped to [0, 3] (anything beyond 3 standard deviations is treated equally) and then scaled to [0, 1]:
   ```
   clampedDeviation = min(deviation, 3) / 3
   ```

3. **Apply weight:** Multiply by the signal type's weight.

4. **Aggregate:** Sum all weighted deviations and divide by total weight to get a raw score, then scale to 0-100:
   ```
   score = (weightedSum / totalWeight) * 100
   ```

### Example

If click accuracy is at 0.1 (very poor) against a baseline mean of 0.6 with stddev 0.15:
- Deviation = |0.1 - 0.6| / 0.15 = 3.33, clamped to 3.0, normalized to 1.0
- Contribution = 1.0 * 0.15 (weight) = 0.15

If this is the only signal, score = (0.15 / 0.15) * 100 = 100. But with multiple signals at normal levels, the score is diluted proportionally.

## Confidence Scoring

Confidence indicates how reliable the struggle score is. It is calculated from two factors:

```
typeRatio = uniqueSignalTypesSeen / 10
countRatio = min(totalSignalsInWindow / 5, 1)
confidence = min(typeRatio * 0.6 + countRatio * 0.4, 1)
```

- **Type diversity (60% weight):** More distinct signal types means a more holistic picture. A score based on only click data is less reliable than one based on click + scroll + typing + hesitation.
- **Signal volume (40% weight):** At least 5 signals are needed for full count confidence. Below that, the score may be based on too little data.

The Decision Engine uses the confidence value to gate adaptations: rules specify a `minConfidence` threshold (typically 0.4-0.6), and adaptations are not applied if confidence is too low.

## Privacy: How Signals Are Collected Without Logging Content

Signal collectors are designed to capture interaction metadata only:

| Signal | What IS captured | What IS NOT captured |
|--------|-----------------|---------------------|
| Scroll Velocity | Scroll position deltas per second | What content was scrolled past |
| Click Accuracy | Distance between click coordinate and nearest interactive element | What was clicked or its label/text |
| Dwell Time | Duration cursor remained over an element | The element's content |
| Typing Rhythm | Time deltas between consecutive keystrokes | The characters typed |
| Backspace Rate | Ratio of backspace presses to total keypresses | The text being edited |
| Zoom Events | Zoom gesture count and direction | What was being viewed |
| Cursor Path | Path curvature and total distance | Element positions or page content |
| Error Rate | Count of validation error events fired | Error messages or form values |
| Reading Speed | Scroll-to-viewport-height ratio over time | The text being read |
| Hesitation | Time between element focus and first interaction | The element's purpose or label |

All signal values are normalized to a 0-1 range before storage, further abstracting them from raw measurements.

## API Reference

```typescript
class StruggleDetector {
  constructor(baseline?: UserBaseline);

  // Add a new signal to the sliding window
  addSignal(signal: BehaviorSignal): void;

  // Compute the current struggle score
  getStruggleScore(): StruggleScore;

  // Update the baseline with current window data (EMA blend)
  updateBaseline(): void;

  // Clear all signals from the window
  reset(): void;

  // Get the current baseline (for persistence)
  getBaseline(): UserBaseline;
}
```

The `StruggleScore` returned includes the numeric score, confidence, the signals used to compute it, and a timestamp.
