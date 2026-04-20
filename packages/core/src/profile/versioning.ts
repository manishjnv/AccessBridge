/**
 * AccessBridge — Profile Versioning (Priority 3)
 *
 * Keeps a rolling log of the last N saved profiles so the user can
 * (a) see a timeline of their accessibility tuning and
 * (b) roll back if a recent change turns out to be worse than the prior state.
 *
 * The library is storage-agnostic: `VersionStore` depends on a `KeyValueStore`
 * contract implemented by the caller. The extension wires it to
 * chrome.storage.local; tests wire it to an in-memory Map.
 */

import type { AccessibilityProfile } from '../types/profile.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface ProfileVersion {
  /** Monotonically increasing id — timestamp-based, hex-encoded, 12 chars. */
  id: string;
  /** ms since epoch at the time this version was captured. */
  savedAt: number;
  /** What triggered the capture. */
  source: 'manual' | 'auto' | 'import' | 'rollback';
  /** The full profile snapshot at this version. */
  profile: AccessibilityProfile;
}

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const VERSIONS_STORAGE_KEY = 'accessbridge_profile_versions_v1';
export const DEFAULT_VERSION_CAP = 10;

// ---------------------------------------------------------------------------
// ProfileVersionStore
// ---------------------------------------------------------------------------

export class ProfileVersionStore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly cap: number = DEFAULT_VERSION_CAP,
  ) {}

  async list(): Promise<ProfileVersion[]> {
    const raw = await this.store.get(VERSIONS_STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isProfileVersion).sort((a, b) => b.savedAt - a.savedAt);
  }

  async latest(): Promise<ProfileVersion | null> {
    const all = await this.list();
    return all[0] ?? null;
  }

  async get(id: string): Promise<ProfileVersion | null> {
    const all = await this.list();
    return all.find((v) => v.id === id) ?? null;
  }

  async save(
    profile: AccessibilityProfile,
    source: ProfileVersion['source'] = 'manual',
  ): Promise<ProfileVersion> {
    const version: ProfileVersion = {
      id: newVersionId(),
      savedAt: Date.now(),
      source,
      // deep-clone to isolate from caller mutations
      profile: structuredClone(profile),
    };
    const existing = await this.list();
    // Skip consecutive duplicates to avoid churn when save is re-triggered
    const prior = existing[0];
    if (prior && structurallyEqual(prior.profile, version.profile)) {
      return prior;
    }
    const merged = [version, ...existing].slice(0, this.cap);
    await this.store.set(VERSIONS_STORAGE_KEY, merged);
    return version;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.list();
    const filtered = existing.filter((v) => v.id !== id);
    if (filtered.length === existing.length) return false;
    await this.store.set(VERSIONS_STORAGE_KEY, filtered);
    return true;
  }

  async clear(): Promise<void> {
    await this.store.set(VERSIONS_STORAGE_KEY, []);
  }
}

// ---------------------------------------------------------------------------
// Diff engine — shallow + deep traversal over the profile tree
// ---------------------------------------------------------------------------

export interface ProfileDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

/**
 * Return a flat list of changed paths between two profiles. Nested objects
 * are traversed; arrays compared structurally. Paths use dot notation.
 */
export function diffProfiles(
  before: AccessibilityProfile,
  after: AccessibilityProfile,
): ProfileDiffEntry[] {
  const diffs: ProfileDiffEntry[] = [];
  walk(before as unknown, after as unknown, '', diffs);
  return diffs;
}

function walk(a: unknown, b: unknown, path: string, out: ProfileDiffEntry[]): void {
  if (shallowEqual(a, b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const nextPath = path === '' ? key : `${path}.${key}`;
      walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], nextPath, out);
    }
    return;
  }
  out.push({ path: path || '<root>', before: a, after: b });
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => Object.is(x, b[i]));
  }
  return false;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canonical);
  if (isPlainObject(x)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(x).sort()) sorted[key] = canonical(x[key]);
    return sorted;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function newVersionId(): string {
  // 12 hex chars = 48 bits = no practical collision within a 10-deep ring
  const rand = Math.floor(Math.random() * 0xffffff);
  return (Date.now().toString(16) + rand.toString(16).padStart(6, '0')).slice(-12);
}

function isProfileVersion(x: unknown): x is ProfileVersion {
  if (!isPlainObject(x)) return false;
  return (
    typeof x.id === 'string' &&
    typeof x.savedAt === 'number' &&
    typeof x.source === 'string' &&
    typeof x.profile === 'object' &&
    x.profile !== null
  );
}

// ---------------------------------------------------------------------------
// In-memory KeyValueStore for testing
// ---------------------------------------------------------------------------

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
}
