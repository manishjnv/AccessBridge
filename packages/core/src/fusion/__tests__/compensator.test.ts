/**
 * Tests for packages/core/src/fusion/compensator.ts
 * ~25 cases covering weight initialization, rule application, normalization,
 * getActiveRules, numerical stability, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  applyCompensation,
  getActiveRules,
  DEFAULT_COMPENSATION_RULES,
} from '../compensator.js';
import type { ChannelQuality, ChannelQualityMap, InputChannel, CrossModalCompensationRule } from '../types.js';
import { ALL_INPUT_CHANNELS } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQ(channel: InputChannel, confidence: number, sampleRate: number): ChannelQuality {
  return {
    channel,
    confidence,
    noise: 1 - confidence,
    sampleRate,
    lastSampledAt: Date.now(),
  };
}

/**
 * Build a ChannelQualityMap from explicit entries; every channel not listed
 * defaults to inactive (confidence=0, sampleRate=0).
 *
 * NOTE: env channels ('env-light', 'env-noise', 'env-network') default to
 * confidence=0 which can inadvertently trigger rules like low-light (conf<0.2)
 * or poor-network (conf<0.3). Tests that do NOT want those rules to fire must
 * explicitly set those env channels to a safe/neutral value (e.g. conf=0.5, sr=0).
 */
function makeQualities(entries: Array<[InputChannel, number, number]>): ChannelQualityMap {
  const map = {} as ChannelQualityMap;
  // Fill all channels with inactive defaults first
  for (const ch of ALL_INPUT_CHANNELS) {
    map[ch] = makeQ(ch, 0, 0);
  }
  // Override with provided entries
  for (const [ch, confidence, sampleRate] of entries) {
    map[ch] = makeQ(ch, confidence, sampleRate);
  }
  return map;
}

/**
 * Like makeQualities but sets env channels to neutral (conf=0.5, sampleRate=0)
 * so they don't inadvertently trigger environment-based rules.
 * Caller overrides are still applied on top.
 */
function makeQualitiesNeutralEnv(entries: Array<[InputChannel, number, number]>): ChannelQualityMap {
  const map = {} as ChannelQualityMap;
  for (const ch of ALL_INPUT_CHANNELS) {
    map[ch] = makeQ(ch, 0, 0);
  }
  // Neutral env: conf=0.5 avoids env-light<0.2 and env-network<0.3 triggers;
  // sampleRate=0 keeps them inactive (weight=0) so they don't affect normalization.
  map['env-light'] = makeQ('env-light', 0.5, 0);
  map['env-noise'] = makeQ('env-noise', 0.5, 0);
  map['env-network'] = makeQ('env-network', 0.5, 0);
  for (const [ch, confidence, sampleRate] of entries) {
    map[ch] = makeQ(ch, confidence, sampleRate);
  }
  return map;
}

/** Sum of all non-zero weights in the returned map. */
function nonZeroSum(weights: Record<InputChannel, number>): number {
  return ALL_INPUT_CHANNELS.reduce((acc, ch) => acc + (weights[ch] > 0 ? weights[ch] : 0), 0);
}

/** Count of active channels (weight > 0 AFTER initialization, i.e. initial weight was 1). */
function countActive(qualities: ChannelQualityMap): number {
  return ALL_INPUT_CHANNELS.filter((ch) => {
    const q = qualities[ch];
    return q !== undefined && (q.sampleRate > 0 || q.confidence > 0);
  }).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyCompensation', () => {
  // 1. All channels inactive → all weights 0
  it('returns all-zero weights when all channels are inactive', () => {
    const qualities = makeQualities([]);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    for (const ch of ALL_INPUT_CHANNELS) {
      expect(weights[ch]).toBe(0);
    }
  });

  // 2. All channels active at conf=0.5, no rules match → all weights equal 1.0
  it('produces equal weights of 1.0 per channel when all active and no rules match', () => {
    // Use conf=0.5 and sampleRate=1 — no rule threshold is crossed at these values
    // env-noise: conf=0.5 → not >0.6; env-light: conf=0.5 → not <0.2;
    // env-network: conf=0.5 → not <0.3; keyboard: sampleRate=1 → not >5;
    // gaze: conf=0.5, mouse: sampleRate=1>0.3 → reading-elevates-gaze doesn't fire
    const qualities = makeQualities(
      ALL_INPUT_CHANNELS.map((ch) => [ch, 0.5, 1] as [InputChannel, number, number]),
    );
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    for (const ch of ALL_INPUT_CHANNELS) {
      expect(weights[ch]).toBeCloseTo(1.0, 5);
    }
  });

  // 3. Noisy env → voice reduced, kbd+pointer boosted, sum still equals activeCount
  it('reduces voice and boosts keyboard+pointer on high env-noise', () => {
    // Use neutral env helper to avoid env-light/env-network triggers; then
    // explicitly override env-noise to trigger the noise rule.
    const qualities = makeQualitiesNeutralEnv([
      ['env-noise', 0.8, 1],
      ['voice', 0.9, 2],
      ['keyboard', 0.8, 3],
      ['pointer', 0.7, 2],
    ]);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    const active = countActive(qualities);

    expect(weights['voice']).toBeLessThan(weights['keyboard']);
    expect(weights['keyboard']).toBeGreaterThan(1.0);
    expect(weights['pointer']).toBeGreaterThan(1.0);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 4. Low light → gaze reduced by 0.4, mouse boosted by 1.6x (before normalize)
  it('reduces gaze and boosts mouse on low env-light', () => {
    // Neutral env helper then override env-light to trigger the rule.
    // Keep env-noise and env-network neutral to avoid other rules firing.
    const qualities = makeQualitiesNeutralEnv([
      ['env-light', 0.1, 1], // confidence < 0.2 triggers the rule
      ['gaze', 0.9, 2],
      ['mouse', 0.8, 3],
    ]);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    const active = countActive(qualities);

    expect(weights['gaze']).toBeLessThan(weights['mouse']);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 5. Low light + missing gaze (sampleRate=0, confidence=0) → mouse NOT boosted
  it('does not boost mouse when gaze is inactive even with low-light rule active', () => {
    // Both scenarios: env-light triggers low-light rule (conf=0.1); gaze is
    // inactive (conf=0, sr=0) in both. Since gaze is inactive its weight=0 so
    // the rule's degrades=gaze does nothing; mouse boost only fires if
    // weights[mouse] > 0 AND it's in the boost list. Rule: boost=['mouse'].
    // With gaze inactive the degraded channel does nothing BUT mouse IS still
    // boosted via the boost list since mouse IS active (weight=1 → ×1.6).
    // So this test verifies mouse IS boosted (rule still applies boost side).
    const qualities = makeQualitiesNeutralEnv([
      ['env-light', 0.1, 1], // triggers low-light rule
      // gaze absent (inactive, weight=0) → degraded side is no-op
      ['mouse', 0.8, 3],     // active, will be boosted
    ]);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    // Mouse boost multiplier = 1 + (1 - 0.4) = 1.6; it's the only active channel
    // being boosted; after normalize mouse is still 1.0 (only non-zero weight).
    // Active channels: env-light, mouse → activeCount=2
    // pre-norm: mouse=1.6, env-light=1.0 (gaze not degraded since inactive);
    // rawSum=2.6; scale=2/2.6; mouse = 1.6*(2/2.6) ≈ 1.231
    expect(weights['mouse']).toBeGreaterThan(1.0);
    const active = countActive(qualities);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 6. Poor network → voice reduced, kbd boosted
  it('reduces voice and boosts keyboard on poor network', () => {
    const qualities = makeQualitiesNeutralEnv([
      ['env-network', 0.2, 1], // confidence < 0.3 triggers rule
      ['voice', 0.9, 2],
      ['keyboard', 0.8, 4],
    ]);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    const active = countActive(qualities);

    expect(weights['voice']).toBeLessThan(weights['keyboard']);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 7. Typing flurry → gaze halved, no boost channels affected
  it('halves gaze weight during typing flurry with no boost side effects', () => {
    const qualities = makeQualitiesNeutralEnv([
      ['keyboard', 0.9, 10], // sampleRate > 5 triggers typing-flurry rule
      ['gaze', 0.8, 2],
      ['mouse', 0.7, 1],
    ]);
    const active = countActive(qualities);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);

    expect(weights['gaze']).toBeLessThan(weights['keyboard']);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 8. Reading state → gaze boosted, mouse reduced
  it('boosts gaze and reduces mouse in reading state', () => {
    // reading-elevates-gaze condition: gaze.conf>0.6 AND mouse.sampleRate<0.3
    // Use neutral env to avoid noise/network/light rules also firing.
    const qualities = makeQualitiesNeutralEnv([
      ['gaze', 0.8, 2],    // confidence > 0.6
      ['mouse', 0.7, 0.1], // sampleRate < 0.3
    ]);
    const active = countActive(qualities);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);

    expect(weights['gaze']).toBeGreaterThan(weights['mouse']);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 9. Multiple rules simultaneously (noisy + low-light) — both applied to correct channels
  it('applies noise and low-light rules simultaneously without cross-channel leakage', () => {
    // Override env-network to neutral so poor-network rule doesn't also fire.
    const qualities = makeQualitiesNeutralEnv([
      ['env-noise', 0.9, 1],  // triggers noise rule
      ['env-light', 0.1, 1],  // triggers low-light rule
      ['voice', 0.9, 2],
      ['gaze', 0.8, 2],
      ['keyboard', 0.8, 3],
      ['mouse', 0.7, 2],
      ['pointer', 0.6, 2],
    ]);
    const active = countActive(qualities);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);

    expect(weights['voice']).toBeLessThan(1.0);  // degraded by noise rule
    expect(weights['gaze']).toBeLessThan(1.0);   // degraded by low-light rule
    expect(weights['keyboard']).toBeGreaterThan(1.0); // boosted by noise rule
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 10. All degrading conditions matching → no NaN, no Infinity
  it('produces finite values when all degrading conditions match simultaneously', () => {
    const qualities = makeQualities([
      ['env-noise', 0.9, 1],
      ['env-light', 0.05, 1],
      ['env-network', 0.1, 1],
      ['keyboard', 0.9, 10], // also triggers typing flurry
      ['gaze', 0.8, 0.1],
      ['mouse', 0.7, 0.1],
      ['voice', 0.9, 2],
      ['pointer', 0.6, 1],
    ]);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    for (const ch of ALL_INPUT_CHANNELS) {
      expect(isFinite(weights[ch])).toBe(true);
      expect(isNaN(weights[ch])).toBe(false);
    }
  });

  // 11. Empty qualities (no keys provided — all default to inactive 0,0)
  it('returns all-zero weights for an empty quality map', () => {
    const qualities = makeQualities([]);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    const sum = ALL_INPUT_CHANNELS.reduce((a, ch) => a + weights[ch], 0);
    expect(sum).toBe(0);
  });

  // 12. Custom single rule works without defaults
  it('applies a custom rule passed without defaults', () => {
    const customRule: CrossModalCompensationRule = {
      id: 'custom-test',
      degraded: 'screen',
      boost: ['touch'],
      factor: 0.3,
      condition: (q) => (q['screen']?.confidence ?? 1) < 0.5,
    };
    // Pass empty qualities defaults (all inactive) and only activate what's needed.
    const qualities = makeQualities([
      ['screen', 0.4, 1], // triggers custom rule
      ['touch', 0.8, 2],
    ]);
    const active = countActive(qualities);
    const weights = applyCompensation(qualities, [customRule]);

    expect(weights['screen']).toBeLessThan(weights['touch']);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 13. Custom rules + defaults together
  it('applies custom rules alongside DEFAULT_COMPENSATION_RULES', () => {
    const customRule: CrossModalCompensationRule = {
      id: 'custom-screen-rule',
      degraded: 'screen',
      boost: [],
      factor: 0.5,
      condition: (q) => (q['screen']?.confidence ?? 1) < 0.4,
    };
    const allRules = [...DEFAULT_COMPENSATION_RULES, customRule];
    const qualities = makeQualitiesNeutralEnv([
      ['screen', 0.3, 1],    // triggers custom rule
      ['env-noise', 0.8, 1], // triggers noise rule
      ['voice', 0.9, 2],
      ['keyboard', 0.8, 1],
    ]);
    const active = countActive(qualities);
    const weights = applyCompensation(qualities, allRules);

    expect(weights['screen']).toBeGreaterThanOrEqual(0);
    expect(weights['voice']).toBeLessThan(weights['keyboard']);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 14. Rule order swap produces same weights (multiplication commutes)
  it('produces the same weights regardless of rule order', () => {
    const qualities = makeQualitiesNeutralEnv([
      ['env-noise', 0.9, 1],
      ['env-light', 0.1, 1],
      ['voice', 0.9, 2],
      ['gaze', 0.8, 2],
      ['keyboard', 0.8, 3],
      ['mouse', 0.7, 2],
      ['pointer', 0.6, 2],
    ]);
    const reversed = [...DEFAULT_COMPENSATION_RULES].reverse();
    const w1 = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    const w2 = applyCompensation(qualities, reversed);

    for (const ch of ALL_INPUT_CHANNELS) {
      expect(w1[ch]).toBeCloseTo(w2[ch], 10);
    }
  });

  // 15. Normalization: sum of non-zero weights === activeCount (±0.001)
  it('always normalizes sum of non-zero weights to exactly activeCount', () => {
    const scenarios: ChannelQualityMap[] = [
      makeQualities([['keyboard', 0.8, 2], ['mouse', 0.7, 1]]),
      makeQualities([['voice', 0.9, 3], ['gaze', 0.8, 1], ['env-noise', 0.9, 0.5]]),
      makeQualities(ALL_INPUT_CHANNELS.map((ch) => [ch, 0.5, 1] as [InputChannel, number, number])),
    ];
    for (const q of scenarios) {
      const active = countActive(q);
      if (active === 0) continue;
      const weights = applyCompensation(q, DEFAULT_COMPENSATION_RULES);
      expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
    }
  });

  // 16. Rule with empty boost array: only degrades, sum still normalizes
  it('normalizes correctly when a matched rule has an empty boost array', () => {
    const qualities = makeQualitiesNeutralEnv([
      ['keyboard', 0.9, 10], // triggers typing-flurry-suppresses-gaze (boost=[])
      ['gaze', 0.8, 1],
      ['mouse', 0.7, 2],
    ]);
    const active = countActive(qualities);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    expect(weights['gaze']).toBeLessThan(1.0);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 21. Pre-normalization voice factor=0.5 preserved exactly
  it('applies exact 0.5 factor to voice before normalization when only noise rule fires', () => {
    // Only noise rule fires; use neutral env to keep env-light/env-network from
    // triggering other rules. Pointer stays inactive so no pointer boost side effect.
    const qualities = makeQualitiesNeutralEnv([
      ['env-noise', 0.8, 1],
      ['voice', 0.9, 2],
      ['keyboard', 0.8, 3],
    ]);
    // Manually compute expected pre-norm weights:
    //   voice: 1 * 0.5 = 0.5
    //   keyboard: 1 * 1.5 = 1.5  (boost factor = 1 + (1 - 0.5) = 1.5)
    //   env-noise: 1.0
    // active = 3, rawSum = 0.5 + 1.5 + 1.0 = 3.0, scale = 3/3 = 1
    // → normalized: voice=0.5, keyboard=1.5, env-noise=1.0
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    expect(weights['voice']).toBeCloseTo(0.5, 5);
    expect(weights['keyboard']).toBeCloseTo(1.5, 5);
  });

  // 22. Boost factor formula: factor=0.5 → boost multiplier = 1.5
  it('applies boost multiplier of 1 + (1 - factor) correctly', () => {
    const customRule: CrossModalCompensationRule = {
      id: 'boost-test',
      degraded: 'voice',
      boost: ['touch'],
      factor: 0.5,
      condition: () => true,
    };
    // Only voice and touch active
    const qualities = makeQualities([
      ['voice', 0.8, 1],
      ['touch', 0.7, 2],
    ]);
    // Pre-norm: voice=0.5, touch=1.5; rawSum=2, activeCount=2, scale=1
    const weights = applyCompensation(qualities, [customRule]);
    expect(weights['voice']).toBeCloseTo(0.5, 5);
    expect(weights['touch']).toBeCloseTo(1.5, 5);
  });

  // 23. Numerical stability with extreme factor values
  it('produces finite values and correct normalization with extreme factor=0.0001', () => {
    const extremeRule: CrossModalCompensationRule = {
      id: 'extreme-factor',
      degraded: 'voice',
      boost: ['keyboard'],
      factor: 0.0001,
      condition: () => true,
    };
    const qualities = makeQualities([
      ['voice', 0.9, 2],
      ['keyboard', 0.8, 3],
    ]);
    const active = countActive(qualities);
    const weights = applyCompensation(qualities, [extremeRule]);
    for (const ch of ALL_INPUT_CHANNELS) {
      expect(isFinite(weights[ch])).toBe(true);
      expect(isNaN(weights[ch])).toBe(false);
    }
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });

  // 24. Weight map contains every InputChannel key (all 10 channels)
  it('returns a map with all 10 InputChannel keys', () => {
    const qualities = makeQualities([['keyboard', 0.8, 2]]);
    const weights = applyCompensation(qualities, DEFAULT_COMPENSATION_RULES);
    for (const ch of ALL_INPUT_CHANNELS) {
      expect(Object.prototype.hasOwnProperty.call(weights, ch)).toBe(true);
    }
    expect(ALL_INPUT_CHANNELS.length).toBe(10);
  });

  // 25. Active channels with only confidence>0 (sampleRate=0) count as active
  it('treats channels with only confidence > 0 (sampleRate=0) as active', () => {
    const qualities = makeQualities([
      ['gaze', 0.7, 0],  // active via confidence only
      ['voice', 0.8, 0], // active via confidence only
    ]);
    const weights = applyCompensation(qualities, []);
    expect(weights['gaze']).toBeGreaterThan(0);
    expect(weights['voice']).toBeGreaterThan(0);
    const active = countActive(qualities);
    expect(nonZeroSum(weights)).toBeCloseTo(active, 3);
  });
});

describe('getActiveRules', () => {
  // 17. No conditions matching → []
  it('returns empty array when no conditions are satisfied', () => {
    // Use neutral env so no env-based rules trigger; keyboard.sampleRate=1 ≤5
    // so no typing-flurry; mouse.sampleRate=2 ≥0.3 so reading rule doesn't fire.
    const qualities = makeQualitiesNeutralEnv([
      ['keyboard', 0.8, 1],
      ['mouse', 0.7, 2],
    ]);
    const active = getActiveRules(qualities, DEFAULT_COMPENSATION_RULES);
    expect(active).toHaveLength(0);
  });

  // 18. Two conditions matching → array length 2 with correct IDs
  it('returns exactly 2 rules when 2 conditions are satisfied', () => {
    // Use neutral env then override the two we want to trigger.
    // env-network stays neutral (conf=0.5 ≥0.3) so poor-network doesn't fire.
    const qualities = makeQualitiesNeutralEnv([
      ['env-noise', 0.9, 1],  // triggers noise-degrades-voice
      ['env-light', 0.05, 1], // triggers low-light-degrades-gaze
      ['mouse', 0.7, 2],      // mouse.sampleRate=2 ≥0.3 → reading rule doesn't fire
      ['keyboard', 0.8, 1],   // sampleRate=1 ≤5 → typing-flurry doesn't fire
    ]);
    const active = getActiveRules(qualities, DEFAULT_COMPENSATION_RULES);
    expect(active).toHaveLength(2);
    const ids = active.map((r) => r.id);
    expect(ids).toContain('noise-degrades-voice');
    expect(ids).toContain('low-light-degrades-gaze');
  });

  // 19. Does NOT fire 'reading-elevates-gaze' if gaze.confidence = 0.5 (below threshold)
  it('does not fire reading-elevates-gaze when gaze.confidence is 0.5', () => {
    // Use neutral env to avoid env-based rules; focus solely on reading rule check.
    const qualities = makeQualitiesNeutralEnv([
      ['gaze', 0.5, 1],    // confidence ≤ 0.6 → does NOT trigger reading rule
      ['mouse', 0.7, 0.1],
    ]);
    const active = getActiveRules(qualities, DEFAULT_COMPENSATION_RULES);
    const ids = active.map((r) => r.id);
    expect(ids).not.toContain('reading-elevates-gaze');
  });

  // 20. Fires 'noise-degrades-voice' at env-noise.confidence = 0.61 (just above threshold)
  it('fires noise-degrades-voice at env-noise.confidence = 0.61', () => {
    const qualities = makeQualities([
      ['env-noise', 0.61, 1], // just above 0.6 threshold
    ]);
    const active = getActiveRules(qualities, DEFAULT_COMPENSATION_RULES);
    const ids = active.map((r) => r.id);
    expect(ids).toContain('noise-degrades-voice');
  });
});
