/**
 * enterprise/policy.ts — Session 20
 *
 * Reads chrome.storage.managed (Windows Group Policy / macOS mobileconfig /
 * Linux JSON policy) and locks specific AccessibilityProfile keys so
 * end-users cannot override them.
 *
 * Pure-TS module: no side-effects at import time.
 */

import type { AccessibilityProfile } from '@accessbridge/core';

// ---------- Public types ----------

export interface ManagedPolicy {
  /** Array of feature name strings admin mandates ON. Empty = no lockdown. */
  enabledFeaturesLockdown?: string[];
  /** Array of feature name strings admin mandates OFF. Empty = no lockdown. */
  disabledFeaturesLockdown?: string[];
  /** true = force opt-in, false = allow user choice, undefined = user free. */
  observatoryOptInRequired?: boolean;
  /**
   * false blocks Tier 2 cloud AI providers (Gemini/Claude); default undefined
   * = allowed. No direct AccessibilityProfile key exists for this; the merged
   * result exposes it only via `lockedKeys` ('aiAllowCloudTier'). Background
   * reads it from the managed policy when constructing AIEngine.
   */
  allowCloudAITier?: boolean;
  /** URL for self-hosted LLM gateway override. undefined = use default. */
  customAPIEndpoint?: string;
  /** BCP-47 tag forced as primary language (e.g. 'hi-IN'). undefined = user choice. */
  defaultLanguage?: string;
  /** 'off' | 'local-only' | 'relay' — profile sync mode. */
  profileSyncMode?: 'off' | 'local-only' | 'relay';
  /** 'none' | 'aggregated' | 'full' — telemetry level for observatory. */
  telemetryLevel?: 'none' | 'aggregated' | 'full';
  /** Agent version floor; clients below this value show a non-blocking warning. */
  minimumAgentVersion?: string;
  /** Opaque per-organization Merkle hash for tenant grouping in observatory. */
  orgHash?: string;
}

export interface LockdownResult {
  profile: AccessibilityProfile;
  /**
   * Dot-paths of profile keys (e.g. 'cognitive.focusModeEnabled') that are
   * now controlled by the managed policy. Shadow keys that have no direct
   * profile key (e.g. 'aiAllowCloudTier') are also included so the popup can
   * display "Managed by your organization" on the relevant UI panels.
   */
  lockedKeys: Set<string>;
}

// ---------- Feature-name → profile dot-path mapping ----------

/**
 * Authoritative map from policy feature-name strings (lower-cased) to their
 * corresponding AccessibilityProfile dot-paths.
 *
 * Uses a Map rather than an object literal so lookups for `__proto__`,
 * `constructor`, or any other prototype-chain name return undefined instead
 * of Object.prototype or a function — same remediation pattern as RCA
 * BUG-015 (IndicWhisper `in` operator proto-pollution guard).
 */
const FEATURE_NAME_MAP: ReadonlyMap<string, string> = new Map([
  ['focus_mode', 'cognitive.focusModeEnabled'],
  ['reading_mode', 'cognitive.readingModeEnabled'],
  ['distraction_shield', 'cognitive.distractionShield'],
  ['auto_summarize', 'cognitive.autoSummarize'],
  ['reduced_motion', 'sensory.reducedMotion'],
  ['high_contrast', 'sensory.highContrast'],
  ['voice_nav', 'motor.voiceNavigationEnabled'],
  ['eye_tracking', 'motor.eyeTrackingEnabled'],
  ['keyboard_only', 'motor.keyboardOnlyMode'],
  ['predictive_input', 'motor.predictiveInput'],
  ['dwell_click', 'motor.dwellClickEnabled'],
  ['vision_recovery', 'sensory.visionRecoveryEnabled'],
  ['live_captions', 'sensory.liveCaptionsEnabled'],
  ['fusion', 'fusionEnabled'],
  ['action_items', 'cognitive.actionItemsEnabled'],
  ['gestures', 'motor.gestureShortcutsEnabled'],
]);

/** Unknown feature names that have already been logged (to avoid console spam). */
const _warnedUnknownFeatures = new Set<string>();

// ---------- Type coercion helpers ----------

/**
 * Coerce a registry value that may arrive as a Windows DWORD (0/1), a string
 * ("true"/"false"/"1"/"0"), or an actual boolean, to a real boolean.
 * Returns undefined for anything unrecognisable.
 */
function coerceBool(raw: unknown): boolean | undefined {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
  return undefined;
}

/**
 * Coerce a value that may be a JSON string or a real array to a string[].
 * Returns undefined when the input is neither.
 */
function coerceStringArray(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // malformed JSON — treat as undefined
    }
  }
  return undefined;
}

/**
 * Coerce a value to string or undefined.
 */
function coerceString(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

/**
 * Coerce a value to a safe HTTPS URL string, or undefined.
 * Rejects anything not starting with `https://`, longer than 1024 chars, or
 * containing control characters / whitespace. Blocks `javascript:`, `file://`,
 * `data:`, `http:`, and other schemes a malicious admin could abuse.
 *
 * Session 20: hardens `customAPIEndpoint` against Session-21 consumers that
 * will wire the value into fetch() / AIEngine providers.
 */
function coerceHttpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0 || raw.length > 1024) return undefined;
  if (!raw.startsWith('https://')) return undefined;
  // Reject control characters and whitespace — rules out split-request tricks.
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Coerce a value to a safe semver-ish string, or undefined.
 * Accepts MAJOR.MINOR.PATCH with optional pre-release / build metadata per
 * https://semver.org. Reject strings with shell metacharacters, spaces, etc.
 * so future consumers that interpolate the value into a command are safe.
 */
function coerceSemver(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0 || raw.length > 64) return undefined;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(raw)) {
    return undefined;
  }
  return raw;
}

// ---------- Public API ----------

/**
 * Read the current managed policy from chrome.storage.managed.
 * Returns an empty object when the API is unavailable (e.g. vitest environment)
 * or when no policy has been deployed. Never throws.
 */
export async function loadManagedPolicy(): Promise<ManagedPolicy> {
  try {
    const hasManagedStorage =
      typeof chrome !== 'undefined' &&
      typeof chrome.storage?.managed?.get === 'function';

    if (!hasManagedStorage) {
      return {};
    }

    const raw = await chrome.storage.managed.get(null);
    return parseManagedPolicyRaw(raw);
  } catch {
    return {};
  }
}

/**
 * Parse a raw chrome.storage.managed key-value bag into a typed ManagedPolicy.
 * All fields are coerced defensively; malformed values are treated as undefined.
 */
function parseManagedPolicyRaw(raw: Record<string, unknown>): ManagedPolicy {
  const policy: ManagedPolicy = {};

  const enabledArr = coerceStringArray(raw['enabledFeaturesLockdown']);
  if (enabledArr !== undefined) policy.enabledFeaturesLockdown = enabledArr;

  const disabledArr = coerceStringArray(raw['disabledFeaturesLockdown']);
  if (disabledArr !== undefined) policy.disabledFeaturesLockdown = disabledArr;

  const optIn = coerceBool(raw['observatoryOptInRequired']);
  if (optIn !== undefined) policy.observatoryOptInRequired = optIn;

  const cloudAI = coerceBool(raw['allowCloudAITier']);
  if (cloudAI !== undefined) policy.allowCloudAITier = cloudAI;

  // Session 20 SEC hardening: customAPIEndpoint is consumed by AIEngine in
  // Session 21 — validate as HTTPS URL here, not at the consumer, so every
  // code path sees a safe value. Rejects javascript:/file:/data:/http: etc.
  const endpoint = coerceHttpsUrl(raw['customAPIEndpoint']);
  if (endpoint !== undefined) policy.customAPIEndpoint = endpoint;

  const lang = coerceString(raw['defaultLanguage']);
  if (lang !== undefined) policy.defaultLanguage = lang;

  const syncMode = coerceString(raw['profileSyncMode']);
  if (syncMode === 'off' || syncMode === 'local-only' || syncMode === 'relay') {
    policy.profileSyncMode = syncMode;
  }

  const telemetry = coerceString(raw['telemetryLevel']);
  if (telemetry === 'none' || telemetry === 'aggregated' || telemetry === 'full') {
    policy.telemetryLevel = telemetry;
  }

  // Session 20 SEC hardening: minimumAgentVersion validated as semver to
  // rule out shell metacharacters / whitespace in case a future consumer
  // ever interpolates the value into a command or shell invocation.
  const minAgent = coerceSemver(raw['minimumAgentVersion']);
  if (minAgent !== undefined) policy.minimumAgentVersion = minAgent;

  const orgHash = coerceString(raw['orgHash']);
  if (orgHash !== undefined) policy.orgHash = orgHash;

  return policy;
}

/**
 * Merge a managed policy into an AccessibilityProfile.
 * Returns the (possibly mutated) profile copy and the set of locked dot-paths.
 *
 * Merge semantics:
 * - disabledFeaturesLockdown wins over enabledFeaturesLockdown when both list the same feature.
 * - observatoryOptInRequired: true/false forces shareAnonymousMetrics and locks it; undefined leaves it alone.
 * - allowCloudAITier: false adds 'aiAllowCloudTier' to lockedKeys (shadow key only; no profile field changed).
 * - defaultLanguage: forces profile.language, locks 'language'.
 * - profileSyncMode / telemetryLevel / customAPIEndpoint / minimumAgentVersion / orgHash:
 *   shadow-only keys — added to lockedKeys so the popup can display the managed banner.
 */
export function mergeWithProfile(
  profile: AccessibilityProfile,
  policy: ManagedPolicy,
): LockdownResult {
  // Work on a shallow clone to avoid mutating the caller's object.
  let merged: AccessibilityProfile = { ...profile };
  const lockedKeys = new Set<string>();

  // --- Feature lockdowns ---
  const enabled = new Set(
    (policy.enabledFeaturesLockdown ?? []).map((f) => f.toLowerCase()),
  );
  const disabled = new Set(
    (policy.disabledFeaturesLockdown ?? []).map((f) => f.toLowerCase()),
  );

  // disabled wins over enabled for the same key
  for (const featureName of enabled) {
    if (disabled.has(featureName)) continue;
    const path = FEATURE_NAME_MAP.get(featureName);
    if (path === undefined) {
      if (!_warnedUnknownFeatures.has(featureName)) {
        console.warn(
          `[AccessBridge enterprise] Unknown feature name in enabledFeaturesLockdown: "${featureName}" — ignored`,
        );
        _warnedUnknownFeatures.add(featureName);
      }
      continue;
    }
    merged = setProfilePath(merged, path, true);
    lockedKeys.add(path);
  }

  for (const featureName of disabled) {
    const path = FEATURE_NAME_MAP.get(featureName);
    if (path === undefined) {
      if (!_warnedUnknownFeatures.has(featureName)) {
        console.warn(
          `[AccessBridge enterprise] Unknown feature name in disabledFeaturesLockdown: "${featureName}" — ignored`,
        );
        _warnedUnknownFeatures.add(featureName);
      }
      continue;
    }
    merged = setProfilePath(merged, path, false);
    lockedKeys.add(path);
  }

  // --- Observatory opt-in ---
  if (policy.observatoryOptInRequired === true) {
    merged = { ...merged, shareAnonymousMetrics: true };
    lockedKeys.add('shareAnonymousMetrics');
  } else if (policy.observatoryOptInRequired === false) {
    merged = { ...merged, shareAnonymousMetrics: false };
    lockedKeys.add('shareAnonymousMetrics');
  }
  // undefined → leave as-is, do NOT lock

  // --- Cloud AI tier ---
  // No direct profile field; background reads this from managed policy.
  // We only signal it via lockedKeys so the popup can show the banner.
  if (policy.allowCloudAITier === false) {
    lockedKeys.add('aiAllowCloudTier');
  }

  // --- Default language ---
  if (policy.defaultLanguage) {
    merged = { ...merged, language: policy.defaultLanguage };
    lockedKeys.add('language');
  }

  // --- Shadow-only keys (no profile field, popup banner only) ---
  if (policy.profileSyncMode !== undefined) {
    lockedKeys.add('syncMode');
  }
  if (policy.telemetryLevel !== undefined) {
    lockedKeys.add('telemetryLevel');
  }
  if (policy.customAPIEndpoint !== undefined) {
    lockedKeys.add('customAPIEndpoint');
  }
  if (policy.minimumAgentVersion !== undefined) {
    lockedKeys.add('minimumAgentVersion');
  }
  if (policy.orgHash !== undefined) {
    lockedKeys.add('orgHash');
  }

  return { profile: merged, lockedKeys };
}

/**
 * Subscribe to chrome.storage.onChanged for the 'managed' area.
 * The callback fires with the freshly loaded ManagedPolicy on any change.
 * Returns an unsubscribe function.
 */
export function subscribeToPolicyChanges(
  callback: (policy: ManagedPolicy) => void,
): () => void {
  const hasManagedStorage =
    typeof chrome !== 'undefined' &&
    typeof chrome.storage?.onChanged?.addListener === 'function';

  if (!hasManagedStorage) {
    return () => {};
  }

  const listener = (
    _changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'managed') return;
    loadManagedPolicy()
      .then(callback)
      .catch(() => {});
  };

  chrome.storage.onChanged.addListener(listener);

  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}

/**
 * Convert a feature-name lockdown entry to its AccessibilityProfile dot-path.
 * Case-insensitive. Unknown names return null.
 */
export function featureNameToProfilePath(featureName: string): string | null {
  return FEATURE_NAME_MAP.get(featureName.toLowerCase()) ?? null;
}

// ---------- Internal helpers ----------

/**
 * Return a new profile object with the dot-path key set to value.
 * Supports one- and two-segment paths (e.g. 'language' and 'cognitive.focusModeEnabled').
 * Deeper paths are not needed by the current mapping.
 */
function setProfilePath(
  profile: AccessibilityProfile,
  path: string,
  value: boolean,
): AccessibilityProfile {
  const dot = path.indexOf('.');
  if (dot === -1) {
    // Top-level key
    return { ...profile, [path]: value };
  }

  const section = path.slice(0, dot) as keyof AccessibilityProfile;
  const field = path.slice(dot + 1);

  const sectionObj = profile[section];
  if (sectionObj !== null && typeof sectionObj === 'object' && !Array.isArray(sectionObj)) {
    return {
      ...profile,
      [section]: { ...(sectionObj as Record<string, unknown>), [field]: value },
    };
  }

  // Section doesn't exist or isn't an object — skip silently
  return profile;
}
