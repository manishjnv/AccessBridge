/**
 * Session 24 — enterprise/policy.ts pilot_id parsing tests.
 *
 * Validates the ADMX → ManagedPolicy.pilotId → profile.pilotId flow:
 *   - PilotId key with valid string → carried through
 *   - pilotId key (camelCase) → also accepted (alias for managed-storage bags
 *     that preserve case)
 *   - malformed value → silently dropped, policy.pilotId undefined
 *   - mergeWithProfile writes to profile.pilotId AND locks the key
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE } from '@accessbridge/core';
import {
  loadManagedPolicy,
  mergeWithProfile,
} from '../enterprise/policy.js';

// Stub chrome.storage.managed for these tests
type ManagedBag = Record<string, unknown>;
function stubManaged(bag: ManagedBag): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      managed: {
        get: async () => bag,
      },
      onChanged: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
  };
}

describe('enterprise/policy pilotId', () => {
  it('parses the PascalCase ADMX key (PilotId)', async () => {
    stubManaged({ PilotId: 'pilot-banking' });
    const p = await loadManagedPolicy();
    expect(p.pilotId).toBe('pilot-banking');
  });

  it('parses the camelCase alias (pilotId)', async () => {
    stubManaged({ pilotId: 'pilot-tamil' });
    const p = await loadManagedPolicy();
    expect(p.pilotId).toBe('pilot-tamil');
  });

  it('drops malformed pilot_id values', async () => {
    for (const bad of [
      'Pilot-Default', // uppercase
      'pilot default', // space
      '-leading-hyphen',
      '../etc/passwd',
      'a'.repeat(65),
      'pilot;rm', // shell metacharacter
    ]) {
      stubManaged({ PilotId: bad });
      const p = await loadManagedPolicy();
      expect(p.pilotId).toBeUndefined();
    }
  });

  it('drops non-string pilot_id values', async () => {
    for (const bad of [null, undefined, 123, true, [], {}]) {
      stubManaged({ PilotId: bad });
      const p = await loadManagedPolicy();
      expect(p.pilotId).toBeUndefined();
    }
  });

  it('mergeWithProfile writes pilotId + locks the key', () => {
    const base = { ...DEFAULT_PROFILE, pilotId: null };
    const policy = { pilotId: 'pilot-fatigue-study-2026' };
    const { profile, lockedKeys } = mergeWithProfile(base, policy);
    expect(profile.pilotId).toBe('pilot-fatigue-study-2026');
    expect(lockedKeys.has('pilotId')).toBe(true);
  });

  it('mergeWithProfile leaves profile.pilotId alone when policy unset', () => {
    const base = { ...DEFAULT_PROFILE, pilotId: 'pilot-user-set' };
    const policy = {};
    const { profile, lockedKeys } = mergeWithProfile(base, policy);
    expect(profile.pilotId).toBe('pilot-user-set');
    expect(lockedKeys.has('pilotId')).toBe(false);
  });
});
