/**
 * Multi-Modal Fusion (Layer 5) — Cross-Modal Compensator
 *
 * Pure module: no DOM, no chrome.*, no I/O.
 * Adjusts per-channel weights at runtime based on environmental and behavioral
 * quality signals, then normalizes so the sum of non-zero weights equals the
 * number of active channels.
 */

import type { InputChannel, ChannelQualityMap, CrossModalCompensationRule } from './types.js';
import { ALL_INPUT_CHANNELS } from './types.js';

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

export const DEFAULT_COMPENSATION_RULES: CrossModalCompensationRule[] = [
  {
    id: 'noise-degrades-voice',
    degraded: 'voice',
    boost: ['keyboard', 'pointer'],
    factor: 0.5,
    condition: (q: ChannelQualityMap) => (q['env-noise']?.confidence ?? 0) > 0.6,
    description: 'High ambient noise halves voice reliance; keyboard + touch boosted',
  },
  {
    id: 'low-light-degrades-gaze',
    degraded: 'gaze',
    boost: ['mouse'],
    factor: 0.4,
    condition: (q: ChannelQualityMap) => (q['env-light']?.confidence ?? 1) < 0.2,
    description: 'Poor lighting suppresses gaze tracking; mouse compensates',
  },
  {
    id: 'poor-network-degrades-voice',
    degraded: 'voice',
    boost: ['keyboard'],
    factor: 0.7,
    condition: (q: ChannelQualityMap) => (q['env-network']?.confidence ?? 1) < 0.3,
    description: 'Degraded network reduces cloud STT confidence',
  },
  {
    id: 'typing-flurry-suppresses-gaze',
    degraded: 'gaze',
    boost: [],
    factor: 0.5,
    condition: (q: ChannelQualityMap) => (q['keyboard']?.sampleRate ?? 0) > 5,
    description:
      'Active typing means focus is on screen content not UI; defer gaze-driven adaptations',
  },
  {
    id: 'reading-elevates-gaze',
    degraded: 'mouse',
    boost: ['gaze'],
    factor: 0.6,
    condition: (q: ChannelQualityMap) =>
      (q['gaze']?.confidence ?? 0) > 0.6 && (q['mouse']?.sampleRate ?? 0) < 0.3,
    description: 'Stable gaze + idle mouse → reading state; gaze elevated',
  },
];

// ---------------------------------------------------------------------------
// getActiveRules
// ---------------------------------------------------------------------------

/**
 * Returns every rule whose condition is satisfied by the current quality map.
 */
export function getActiveRules(
  qualities: ChannelQualityMap,
  rules: CrossModalCompensationRule[],
): CrossModalCompensationRule[] {
  return rules.filter((r) => r.condition(qualities));
}

// ---------------------------------------------------------------------------
// applyCompensation
// ---------------------------------------------------------------------------

/**
 * Computes a normalized per-channel weight map.
 *
 * Step 1 — initialize: channel is "active" if its quality entry exists and has
 *   sampleRate > 0 OR confidence > 0.  Active → weight 1.0, inactive → 0.0.
 *
 * Step 2 — apply rules: for each matching rule, multiply degraded channel's
 *   weight by rule.factor; multiply each boost channel's weight by
 *   (1 + (1 − rule.factor)).  Only touch channels that are currently active
 *   (weight > 0).
 *
 * Step 3 — normalize: rawSum = sum of non-zero weights;
 *   scale every non-zero weight by (activeCount / rawSum).
 *   Guard: if activeCount === 0 or rawSum === 0, return all-zero map.
 *
 * Step 4 — return Record<InputChannel, number> covering ALL_INPUT_CHANNELS.
 */
export function applyCompensation(
  qualities: ChannelQualityMap,
  rules: CrossModalCompensationRule[],
): Record<InputChannel, number> {
  // Step 1 — initialize weights
  const weights = {} as Record<InputChannel, number>;
  let activeCount = 0;

  for (const ch of ALL_INPUT_CHANNELS) {
    const q = qualities[ch];
    const isActive = q !== undefined && (q.sampleRate > 0 || q.confidence > 0);
    weights[ch] = isActive ? 1.0 : 0.0;
    if (isActive) activeCount++;
  }

  // Guard: nothing active → all zeros
  if (activeCount === 0) {
    return weights;
  }

  // Step 2 — apply matching rules
  const boostMultiplierFor = (factor: number) => 1 + (1 - factor);

  for (const rule of rules) {
    if (!rule.condition(qualities)) continue;

    // Degrade the flagged channel (only if active)
    if (weights[rule.degraded] > 0) {
      weights[rule.degraded] *= rule.factor;
    }

    // Boost listed channels (only if active)
    for (const ch of rule.boost) {
      if (weights[ch] > 0) {
        weights[ch] *= boostMultiplierFor(rule.factor);
      }
    }
  }

  // Step 3 — normalize
  let rawSum = 0;
  for (const ch of ALL_INPUT_CHANNELS) {
    if (weights[ch] > 0) rawSum += weights[ch];
  }

  if (rawSum === 0) {
    // All active channels were suppressed to zero — reset to zero map
    for (const ch of ALL_INPUT_CHANNELS) weights[ch] = 0;
    return weights;
  }

  const scale = activeCount / rawSum;
  for (const ch of ALL_INPUT_CHANNELS) {
    if (weights[ch] > 0) weights[ch] *= scale;
  }

  return weights;
}
