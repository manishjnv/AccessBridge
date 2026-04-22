/**
 * Session 24 — observatory-publisher pilot_id integration tests.
 *
 * Validates that setActivePilotId + aggregateDailyBundle together produce the
 * right wire shape in every situation:
 *   - unset: no pilot_id key in the bundle
 *   - set:   pilot_id key present with the configured value
 *   - malformed value: silently rejected, module-level state unchanged
 *   - cleared: next bundle has no pilot_id key
 *
 * Session-20 org_hash precedence rules are preserved — the parallel tests in
 * observatory-publisher.test.ts cover that; these focus on the new pilot_id
 * dimension.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateDailyBundle,
  setActivePilotId,
  getActivePilotId,
  type RawCounters,
} from '../observatory-publisher.js';

function baselineCounters(): RawCounters {
  return {
    adaptations_applied: { FONT_SCALE: 1 },
    struggle_events_triggered: 0,
    features_enabled: {},
    languages_used: ['en'],
    domain_connectors_activated: {},
    estimated_accessibility_score_improvement: 10,
  };
}

describe('observatory-publisher pilot_id', () => {
  beforeEach(() => {
    setActivePilotId(null); // reset between tests
  });

  afterEach(() => {
    setActivePilotId(null);
  });

  it('omits pilot_id when setActivePilotId was never called', async () => {
    const bundle = await aggregateDailyBundle(baselineCounters());
    expect('pilot_id' in bundle).toBe(false);
  });

  it('includes pilot_id when a valid value is set', async () => {
    setActivePilotId('pilot-tamil');
    const bundle = await aggregateDailyBundle(baselineCounters());
    expect(bundle.pilot_id).toBe('pilot-tamil');
  });

  it('silently rejects invalid pilot_id values without clobbering state', async () => {
    setActivePilotId('pilot-default');
    // Each of these should be rejected by the internal regex
    setActivePilotId('Pilot-Default' as unknown as string); // uppercase
    setActivePilotId('../etc/passwd'); // path traversal
    setActivePilotId('pilot id'); // space
    setActivePilotId('a'.repeat(65)); // too long
    setActivePilotId('-leading-hyphen'); // starts with hyphen

    expect(getActivePilotId()).toBe('pilot-default');
    const bundle = await aggregateDailyBundle(baselineCounters());
    expect(bundle.pilot_id).toBe('pilot-default');
  });

  it('clears pilot_id when passed null', async () => {
    setActivePilotId('pilot-motor');
    expect(getActivePilotId()).toBe('pilot-motor');
    setActivePilotId(null);
    expect(getActivePilotId()).toBeUndefined();

    const bundle = await aggregateDailyBundle(baselineCounters());
    expect('pilot_id' in bundle).toBe(false);
  });

  it('clears pilot_id when passed empty string', async () => {
    setActivePilotId('pilot-dyslexia');
    setActivePilotId('');
    expect(getActivePilotId()).toBeUndefined();
    const bundle = await aggregateDailyBundle(baselineCounters());
    expect('pilot_id' in bundle).toBe(false);
  });

  it('rejects non-string values defensively', async () => {
    setActivePilotId('pilot-banking');
    // @ts-expect-error runtime defence for malformed caller
    setActivePilotId(123);
    // @ts-expect-error runtime defence for malformed caller
    setActivePilotId({});
    expect(getActivePilotId()).toBe('pilot-banking');
  });

  it('module-level state overrides raw.pilot_id in counters', async () => {
    // Session 20 org_hash precedence: managed wins over raw.
    // Session 24 mirrors that contract for pilot_id.
    setActivePilotId('pilot-active');
    const counters = {
      ...baselineCounters(),
      pilot_id: 'pilot-caller-supplied',
    };
    const bundle = await aggregateDailyBundle(counters);
    expect(bundle.pilot_id).toBe('pilot-active');
  });

  it('falls back to raw.pilot_id when module-level state is unset', async () => {
    setActivePilotId(null);
    const counters = {
      ...baselineCounters(),
      pilot_id: 'pilot-fallback',
    };
    const bundle = await aggregateDailyBundle(counters);
    expect(bundle.pilot_id).toBe('pilot-fallback');
  });

  it('pilot_id is carried at the bundle level, not embedded in merkle_root', async () => {
    // pilot_id is deliberately outside the Merkle commitment — it's the group
    // tag, not a counter. The observatory server's existing canonical-lines
    // contract MUST not break; adding pilot_id to merkle would force a
    // schema-coordinated deploy. This test asserts shape only (two merkle
    // roots from DP-noised counters differ by design — Laplace noise is
    // non-deterministic) by confirming the top-level bundle contract:
    //   • pilot_id sits at bundle.pilot_id, not inside any nested counter
    //   • merkle_root is a 64-char hex string regardless of pilot_id state
    setActivePilotId('pilot-tamil');
    const bundle = await aggregateDailyBundle(baselineCounters());
    expect(bundle.pilot_id).toBe('pilot-tamil');
    expect(typeof bundle.merkle_root).toBe('string');
    expect(bundle.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    // Inspect shape — no key named 'pilot_id' should appear inside any
    // sub-record that feeds canonicalLines().
    expect((bundle.adaptations_applied as Record<string, unknown>)['pilot_id']).toBeUndefined();
    expect((bundle.features_enabled as Record<string, unknown>)['pilot_id']).toBeUndefined();
    expect((bundle.domain_connectors_activated as Record<string, unknown>)['pilot_id']).toBeUndefined();
  });
});
