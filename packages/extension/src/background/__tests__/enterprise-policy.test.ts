/**
 * Unit tests for the Session 20 enterprise managed-policy module.
 *
 * Mocks chrome.storage.managed + chrome.storage.onChanged so the tests run in
 * the same vitest harness as the rest of the extension package.
 *
 * Coverage:
 *   - loadManagedPolicy: unavailable API, empty storage, full parse, throw paths,
 *     coercion (bool / array / string / HTTPS URL / semver).
 *   - mergeWithProfile: feature enable/disable, disabled-wins precedence,
 *     observatory opt-in, cloud AI shadow key, default language, unknown
 *     feature name ignored, shadow-only keys.
 *   - subscribeToPolicyChanges: listener install, area filter, unsubscribe.
 *   - featureNameToProfilePath: known + unknown names.
 *   - Security hardening:
 *       * customAPIEndpoint rejects http://, javascript:, file:// and control chars.
 *       * minimumAgentVersion rejects shell metacharacters / whitespace.
 *
 * 22 test cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROFILE } from '@accessbridge/core';

// ─── chrome.storage.managed mock (hoisted so module-under-test sees it) ───────

const managedMockState = vi.hoisted(() => ({
  managed: {} as Record<string, unknown>,
  onChangedListeners: [] as Array<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >,
  getCallThrows: false,
}));

function installChromeMock() {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      managed: {
        get: vi.fn(async (_keys: string[] | null) => {
          if (managedMockState.getCallThrows) {
            throw new Error('mock: storage.managed.get threw');
          }
          return { ...managedMockState.managed };
        }),
      },
      onChanged: {
        addListener: vi.fn((fn: (typeof managedMockState.onChangedListeners)[number]) => {
          managedMockState.onChangedListeners.push(fn);
        }),
        removeListener: vi.fn((fn: (typeof managedMockState.onChangedListeners)[number]) => {
          const idx = managedMockState.onChangedListeners.indexOf(fn);
          if (idx >= 0) managedMockState.onChangedListeners.splice(idx, 1);
        }),
      },
    },
  };
}

function uninstallChromeMock() {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
}

function triggerStorageChange(area: string) {
  for (const listener of managedMockState.onChangedListeners.slice()) {
    listener({}, area);
  }
}

// ─── Module under test (imported AFTER mock install so there are no surprises) ─

import {
  loadManagedPolicy,
  mergeWithProfile,
  subscribeToPolicyChanges,
  featureNameToProfilePath,
} from '../enterprise/policy.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

function freshProfile() {
  return structuredClone(DEFAULT_PROFILE);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('enterprise/policy — loadManagedPolicy', () => {
  beforeEach(() => {
    managedMockState.managed = {};
    managedMockState.onChangedListeners = [];
    managedMockState.getCallThrows = false;
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('returns {} when chrome.storage.managed is unavailable', async () => {
    uninstallChromeMock();
    const policy = await loadManagedPolicy();
    expect(policy).toEqual({});
  });

  it('returns {} when chrome.storage.managed.get throws', async () => {
    managedMockState.getCallThrows = true;
    const policy = await loadManagedPolicy();
    expect(policy).toEqual({});
  });

  it('returns {} when storage is empty', async () => {
    managedMockState.managed = {};
    const policy = await loadManagedPolicy();
    expect(policy).toEqual({});
  });

  it('parses all 10 policy fields when fully populated', async () => {
    managedMockState.managed = {
      enabledFeaturesLockdown: ['focus_mode', 'high_contrast'],
      disabledFeaturesLockdown: ['auto_summarize'],
      observatoryOptInRequired: true,
      allowCloudAITier: false,
      customAPIEndpoint: 'https://llm.internal.example.com/v1',
      defaultLanguage: 'hi-IN',
      profileSyncMode: 'local-only',
      telemetryLevel: 'aggregated',
      minimumAgentVersion: '0.19.0',
      orgHash: 'a'.repeat(64),
    };
    const policy = await loadManagedPolicy();
    expect(policy.enabledFeaturesLockdown).toEqual(['focus_mode', 'high_contrast']);
    expect(policy.disabledFeaturesLockdown).toEqual(['auto_summarize']);
    expect(policy.observatoryOptInRequired).toBe(true);
    expect(policy.allowCloudAITier).toBe(false);
    expect(policy.customAPIEndpoint).toBe('https://llm.internal.example.com/v1');
    expect(policy.defaultLanguage).toBe('hi-IN');
    expect(policy.profileSyncMode).toBe('local-only');
    expect(policy.telemetryLevel).toBe('aggregated');
    expect(policy.minimumAgentVersion).toBe('0.19.0');
    expect(policy.orgHash).toBe('a'.repeat(64));
  });

  it('coerces Windows DWORD 0/1 to booleans for observatoryOptInRequired', async () => {
    managedMockState.managed = { observatoryOptInRequired: 1 };
    expect((await loadManagedPolicy()).observatoryOptInRequired).toBe(true);
    managedMockState.managed = { observatoryOptInRequired: 0 };
    expect((await loadManagedPolicy()).observatoryOptInRequired).toBe(false);
    managedMockState.managed = { observatoryOptInRequired: 'true' };
    expect((await loadManagedPolicy()).observatoryOptInRequired).toBe(true);
  });

  it('coerces JSON-string arrays for feature lockdowns', async () => {
    managedMockState.managed = {
      enabledFeaturesLockdown: '["focus_mode","reading_mode"]',
    };
    expect((await loadManagedPolicy()).enabledFeaturesLockdown).toEqual([
      'focus_mode',
      'reading_mode',
    ]);
  });

  it('drops malformed values silently (no throw)', async () => {
    managedMockState.managed = {
      enabledFeaturesLockdown: 42,
      observatoryOptInRequired: 'maybe',
      customAPIEndpoint: '',
      minimumAgentVersion: 123,
    };
    const policy = await loadManagedPolicy();
    expect(policy.enabledFeaturesLockdown).toBeUndefined();
    expect(policy.observatoryOptInRequired).toBeUndefined();
    expect(policy.customAPIEndpoint).toBeUndefined();
    expect(policy.minimumAgentVersion).toBeUndefined();
  });

  it('rejects customAPIEndpoint that is not https://', async () => {
    for (const scheme of [
      'http://evil.example.com',
      'javascript:alert(1)',
      'file:///C:/passwords.txt',
      'data:text/plain,x',
      'ws://localhost/',
      'FTP://nope',
    ]) {
      managedMockState.managed = { customAPIEndpoint: scheme };
      expect((await loadManagedPolicy()).customAPIEndpoint).toBeUndefined();
    }
  });

  it('rejects customAPIEndpoint with control characters or whitespace', async () => {
    managedMockState.managed = { customAPIEndpoint: 'https://foo\r\nbar.com' };
    expect((await loadManagedPolicy()).customAPIEndpoint).toBeUndefined();
    managedMockState.managed = { customAPIEndpoint: 'https://foo bar.com' };
    expect((await loadManagedPolicy()).customAPIEndpoint).toBeUndefined();
    managedMockState.managed = { customAPIEndpoint: 'https://foo\u0000bar.com' };
    expect((await loadManagedPolicy()).customAPIEndpoint).toBeUndefined();
  });

  it('rejects customAPIEndpoint longer than 1024 chars', async () => {
    const longUrl = `https://${'a'.repeat(1100)}.com`;
    managedMockState.managed = { customAPIEndpoint: longUrl };
    expect((await loadManagedPolicy()).customAPIEndpoint).toBeUndefined();
  });

  it('rejects minimumAgentVersion with shell metacharacters or spaces', async () => {
    for (const bad of [
      '1.2.3; rm -rf /',
      '1.2.3 && curl evil',
      '1.2.3|cat',
      '1.2.3`whoami`',
      '1.2.3$(id)',
      'latest',
      '1.2',
      '',
    ]) {
      managedMockState.managed = { minimumAgentVersion: bad };
      const result = await loadManagedPolicy();
      expect(result.minimumAgentVersion, `should reject: ${bad}`).toBeUndefined();
    }
  });

  it('accepts valid semver minimumAgentVersion', async () => {
    for (const good of ['0.19.0', '1.2.3', '1.0.0-beta.1', '2.0.0+build.42']) {
      managedMockState.managed = { minimumAgentVersion: good };
      expect((await loadManagedPolicy()).minimumAgentVersion).toBe(good);
    }
  });

  it('drops profileSyncMode / telemetryLevel if not in allowlist', async () => {
    managedMockState.managed = {
      profileSyncMode: 'nonsense',
      telemetryLevel: 'super-full',
    };
    const policy = await loadManagedPolicy();
    expect(policy.profileSyncMode).toBeUndefined();
    expect(policy.telemetryLevel).toBeUndefined();
  });
});

describe('enterprise/policy — mergeWithProfile', () => {
  it('returns profile unchanged with empty lockedKeys when policy is empty', () => {
    const profile = freshProfile();
    const result = mergeWithProfile(profile, {});
    expect(result.profile).toEqual(profile);
    expect(result.lockedKeys.size).toBe(0);
  });

  it('enables features listed in enabledFeaturesLockdown and marks them locked', () => {
    const profile = freshProfile();
    profile.cognitive.focusModeEnabled = false;
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {
      enabledFeaturesLockdown: ['focus_mode', 'high_contrast'],
    });
    expect(merged.cognitive.focusModeEnabled).toBe(true);
    expect(merged.sensory.highContrast).toBe(true);
    expect(lockedKeys.has('cognitive.focusModeEnabled')).toBe(true);
    expect(lockedKeys.has('sensory.highContrast')).toBe(true);
  });

  it('disables features listed in disabledFeaturesLockdown and marks them locked', () => {
    const profile = freshProfile();
    profile.cognitive.autoSummarize = true;
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {
      disabledFeaturesLockdown: ['auto_summarize'],
    });
    expect(merged.cognitive.autoSummarize).toBe(false);
    expect(lockedKeys.has('cognitive.autoSummarize')).toBe(true);
  });

  it('applies disabled precedence over enabled when both list the same feature', () => {
    const profile = freshProfile();
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {
      enabledFeaturesLockdown: ['focus_mode'],
      disabledFeaturesLockdown: ['focus_mode'],
    });
    expect(merged.cognitive.focusModeEnabled).toBe(false);
    expect(lockedKeys.has('cognitive.focusModeEnabled')).toBe(true);
  });

  it('forces shareAnonymousMetrics when observatoryOptInRequired is true', () => {
    const profile = freshProfile();
    profile.shareAnonymousMetrics = false;
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {
      observatoryOptInRequired: true,
    });
    expect(merged.shareAnonymousMetrics).toBe(true);
    expect(lockedKeys.has('shareAnonymousMetrics')).toBe(true);
  });

  it('forces shareAnonymousMetrics off when observatoryOptInRequired is false', () => {
    const profile = freshProfile();
    profile.shareAnonymousMetrics = true;
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {
      observatoryOptInRequired: false,
    });
    expect(merged.shareAnonymousMetrics).toBe(false);
    expect(lockedKeys.has('shareAnonymousMetrics')).toBe(true);
  });

  it('leaves shareAnonymousMetrics alone + unlocked when observatoryOptInRequired is undefined', () => {
    const profile = freshProfile();
    profile.shareAnonymousMetrics = true;
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {});
    expect(merged.shareAnonymousMetrics).toBe(true);
    expect(lockedKeys.has('shareAnonymousMetrics')).toBe(false);
  });

  it('adds aiAllowCloudTier shadow key when allowCloudAITier is false (profile unchanged)', () => {
    const profile = freshProfile();
    const before = JSON.stringify(profile);
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {
      allowCloudAITier: false,
    });
    expect(JSON.stringify(merged)).toBe(before);
    expect(lockedKeys.has('aiAllowCloudTier')).toBe(true);
  });

  it('forces language + locks it when defaultLanguage is set', () => {
    const profile = freshProfile();
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {
      defaultLanguage: 'hi-IN',
    });
    expect(merged.language).toBe('hi-IN');
    expect(lockedKeys.has('language')).toBe(true);
  });

  it('silently ignores unknown feature names', () => {
    const profile = freshProfile();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { profile: merged, lockedKeys } = mergeWithProfile(profile, {
      enabledFeaturesLockdown: ['nonexistent_feature_xyz'],
    });
    expect(merged).toEqual(profile);
    expect(lockedKeys.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('adds shadow keys for sync mode / telemetry / orgHash / customAPIEndpoint / minimumAgentVersion', () => {
    const { lockedKeys } = mergeWithProfile(freshProfile(), {
      profileSyncMode: 'off',
      telemetryLevel: 'aggregated',
      orgHash: 'f'.repeat(64),
      customAPIEndpoint: 'https://custom.example.com',
      minimumAgentVersion: '0.19.0',
    });
    expect(lockedKeys.has('syncMode')).toBe(true);
    expect(lockedKeys.has('telemetryLevel')).toBe(true);
    expect(lockedKeys.has('orgHash')).toBe(true);
    expect(lockedKeys.has('customAPIEndpoint')).toBe(true);
    expect(lockedKeys.has('minimumAgentVersion')).toBe(true);
  });
});

describe('enterprise/policy — subscribeToPolicyChanges', () => {
  beforeEach(() => {
    managedMockState.managed = {};
    managedMockState.onChangedListeners = [];
    managedMockState.getCallThrows = false;
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('fires the callback when the managed area changes', async () => {
    const cb = vi.fn();
    subscribeToPolicyChanges(cb);
    managedMockState.managed = { observatoryOptInRequired: true };
    triggerStorageChange('managed');
    // allow the async loadManagedPolicy inside subscribe to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual({ observatoryOptInRequired: true });
  });

  it('does NOT fire the callback for non-managed storage areas', async () => {
    const cb = vi.fn();
    subscribeToPolicyChanges(cb);
    triggerStorageChange('local');
    triggerStorageChange('sync');
    triggerStorageChange('session');
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes the underlying listener', async () => {
    const cb = vi.fn();
    const unsubscribe = subscribeToPolicyChanges(cb);
    unsubscribe();
    triggerStorageChange('managed');
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).not.toHaveBeenCalled();
  });

  it('returns a no-op unsubscribe when chrome.storage.onChanged is unavailable', () => {
    uninstallChromeMock();
    const cb = vi.fn();
    const unsubscribe = subscribeToPolicyChanges(cb);
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('enterprise/policy — featureNameToProfilePath', () => {
  it('returns the correct dot-path for every known feature name (case-insensitive)', () => {
    expect(featureNameToProfilePath('focus_mode')).toBe('cognitive.focusModeEnabled');
    expect(featureNameToProfilePath('FOCUS_MODE')).toBe('cognitive.focusModeEnabled');
    expect(featureNameToProfilePath('high_contrast')).toBe('sensory.highContrast');
    expect(featureNameToProfilePath('fusion')).toBe('fusionEnabled');
    expect(featureNameToProfilePath('gestures')).toBe('motor.gestureShortcutsEnabled');
  });

  it('returns null for unknown feature names', () => {
    expect(featureNameToProfilePath('nonexistent')).toBeNull();
    expect(featureNameToProfilePath('')).toBeNull();
    expect(featureNameToProfilePath('__proto__')).toBeNull();
  });
});
