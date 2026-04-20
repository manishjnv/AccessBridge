/**
 * AccessBridge — Profile Drift Detector (Priority 3)
 *
 * Watches a 14-day rolling window of ProfileVersions and surfaces
 * monotonic trends in the user's tuning. If the font scale keeps creeping
 * up, for example, the user likely needs a recalibration nudge.
 *
 * Metrics monitored (numeric only): sensory.fontScale,
 * sensory.contrastLevel, sensory.lineHeight, sensory.letterSpacing,
 * motor.dwellClickDelay, confidenceThreshold.
 *
 * A metric is in drift when:
 *   - at least 3 versions in the window, AND
 *   - absolute change (last − first) ≥ metric-specific threshold, AND
 *   - ≥ 70% of step-to-step deltas have the same sign (monotonic-ish).
 */

import type { AccessibilityProfile } from '../types/profile.js';
import type { ProfileVersion } from './versioning.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_DRIFT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface NumericMetricConfig {
  /** Dot path into AccessibilityProfile. */
  path: string;
  /** Minimum absolute delta (last − first) before drift fires. */
  threshold: number;
  /** Human-readable label for UI. */
  label: string;
  /** Direction suggestion when drift is up-trending. */
  upTrendMessage: string;
  /** Direction suggestion when drift is down-trending. */
  downTrendMessage: string;
}

export const DEFAULT_METRICS: NumericMetricConfig[] = [
  {
    path: 'sensory.fontScale',
    threshold: 0.15,
    label: 'Font Scale',
    upTrendMessage:
      'Your font scale keeps creeping up — consider a wider base font or a larger default zoom.',
    downTrendMessage:
      'Your font scale is trending down — the default may be too large for you.',
  },
  {
    path: 'sensory.contrastLevel',
    threshold: 0.2,
    label: 'Contrast',
    upTrendMessage:
      'You keep bumping contrast higher — try enabling High-Contrast mode in Sensory settings.',
    downTrendMessage:
      'You keep lowering contrast — the default may feel harsh; try warm-tone Contrast.',
  },
  {
    path: 'sensory.lineHeight',
    threshold: 0.3,
    label: 'Line Height',
    upTrendMessage:
      'Line height keeps increasing — consider enabling Reading Mode as your baseline.',
    downTrendMessage:
      'Line height keeps decreasing — the default may feel airy; try a compact typography preset.',
  },
  {
    path: 'sensory.letterSpacing',
    threshold: 0.03,
    label: 'Letter Spacing',
    upTrendMessage: 'Letter spacing keeps growing — a dyslexia-friendly font may fit you better.',
    downTrendMessage: 'Letter spacing keeps tightening — you may prefer a denser typography preset.',
  },
  {
    path: 'motor.dwellClickDelay',
    threshold: 200,
    label: 'Dwell-Click Delay',
    upTrendMessage:
      'You keep increasing dwell delay — consider disabling Dwell-Click during fine-motor tasks.',
    downTrendMessage:
      'Dwell delay keeps decreasing — you may be ready for voice control or keyboard-only mode.',
  },
  {
    path: 'confidenceThreshold',
    threshold: 0.1,
    label: 'Adaptation Confidence Threshold',
    upTrendMessage:
      'You keep raising the confidence threshold — AccessBridge is suggesting too eagerly; keep it in manual mode.',
    downTrendMessage:
      'You keep lowering the confidence threshold — you trust the AI more now; try the auto-mode.',
  },
];

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type TrendDirection = 'up' | 'down' | 'stable';

export interface DriftFinding {
  path: string;
  label: string;
  direction: TrendDirection;
  delta: number;
  firstValue: number;
  lastValue: number;
  sampleCount: number;
  recommendation: string;
}

export interface DriftReport {
  windowMs: number;
  versionsInWindow: number;
  findings: DriftFinding[];
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export function detectDrift(
  versions: ProfileVersion[],
  options: { now?: number; windowMs?: number; metrics?: NumericMetricConfig[] } = {},
): DriftReport {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_DRIFT_WINDOW_MS;
  const metrics = options.metrics ?? DEFAULT_METRICS;

  const cutoff = now - windowMs;
  const inWindow = versions
    .filter((v) => v.savedAt >= cutoff)
    .sort((a, b) => a.savedAt - b.savedAt); // ascending time

  if (inWindow.length < 3) {
    return { windowMs, versionsInWindow: inWindow.length, findings: [] };
  }

  const findings: DriftFinding[] = [];

  for (const metric of metrics) {
    const samples = inWindow
      .map((v) => readNumeric(v.profile, metric.path))
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));

    if (samples.length < 3) continue;

    const first = samples[0];
    const last = samples[samples.length - 1];
    const delta = last - first;

    if (Math.abs(delta) < metric.threshold) continue;

    // Monotonic-ish check: percent of step-to-step deltas with matching sign
    const deltas: number[] = [];
    for (let i = 1; i < samples.length; i++) deltas.push(samples[i] - samples[i - 1]);
    const sign = Math.sign(delta);
    const matching = deltas.filter((d) => Math.sign(d) === sign || d === 0).length;
    const monotonicity = deltas.length === 0 ? 0 : matching / deltas.length;
    if (monotonicity < 0.7) continue;

    const direction: TrendDirection = delta > 0 ? 'up' : delta < 0 ? 'down' : 'stable';
    const recommendation =
      direction === 'up' ? metric.upTrendMessage : metric.downTrendMessage;

    findings.push({
      path: metric.path,
      label: metric.label,
      direction,
      delta,
      firstValue: first,
      lastValue: last,
      sampleCount: samples.length,
      recommendation,
    });
  }

  return { windowMs, versionsInWindow: inWindow.length, findings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readNumeric(obj: AccessibilityProfile, path: string): number | undefined {
  const segments = path.split('.');
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'number' ? cur : undefined;
}
