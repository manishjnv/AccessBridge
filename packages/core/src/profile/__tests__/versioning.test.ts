import { describe, it, expect } from 'vitest';
import {
  ProfileVersionStore,
  InMemoryKeyValueStore,
  diffProfiles,
  VERSIONS_STORAGE_KEY,
  DEFAULT_VERSION_CAP,
} from '../versioning.js';
import { DEFAULT_PROFILE } from '../../types/profile.js';

function cloneProfile(overrides: Partial<typeof DEFAULT_PROFILE> = {}) {
  return structuredClone({ ...DEFAULT_PROFILE, ...overrides });
}

describe('ProfileVersionStore', () => {
  it('returns empty list when storage is empty', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    expect(await store.list()).toEqual([]);
    expect(await store.latest()).toBeNull();
  });

  it('saves a version and reads it back', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    const v = await store.save(DEFAULT_PROFILE);
    expect(v.source).toBe('manual');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(v.id);
  });

  it('saves newest-first in list()', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    await store.save(cloneProfile({ language: 'en' }));
    await new Promise((r) => setTimeout(r, 1));
    const latest = await store.save(cloneProfile({ language: 'hi' }));
    const list = await store.list();
    expect(list[0].id).toBe(latest.id);
    expect(list[0].profile.language).toBe('hi');
  });

  it('skips consecutive duplicates', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    const a = await store.save(DEFAULT_PROFILE);
    const b = await store.save(DEFAULT_PROFILE);
    expect(a.id).toBe(b.id); // same version returned, no new snapshot
    expect(await store.list()).toHaveLength(1);
  });

  it('caps to N versions (default 10)', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    for (let i = 0; i < DEFAULT_VERSION_CAP + 5; i++) {
      await store.save(cloneProfile({ confidenceThreshold: 0.1 + i * 0.05 }));
      await new Promise((r) => setTimeout(r, 1));
    }
    const list = await store.list();
    expect(list.length).toBe(DEFAULT_VERSION_CAP);
    // Oldest were dropped
    expect(list[list.length - 1].profile.confidenceThreshold).toBeGreaterThan(0.1);
  });

  it('respects a custom cap', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore(), 3);
    for (let i = 0; i < 5; i++) {
      await store.save(cloneProfile({ confidenceThreshold: 0.1 + i * 0.05 }));
      await new Promise((r) => setTimeout(r, 1));
    }
    expect((await store.list()).length).toBe(3);
  });

  it('delete removes a specific version by id', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    const v = await store.save(DEFAULT_PROFILE);
    expect(await store.delete(v.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
  });

  it('delete returns false when id is not found', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    expect(await store.delete('nope')).toBe(false);
  });

  it('clear wipes all versions', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    await store.save(DEFAULT_PROFILE);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('get(id) returns the matching version', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    const v = await store.save(DEFAULT_PROFILE);
    const fetched = await store.get(v.id);
    expect(fetched?.id).toBe(v.id);
  });

  it('save defensive-copies the profile (caller mutation is isolated)', async () => {
    const store = new ProfileVersionStore(new InMemoryKeyValueStore());
    const input = cloneProfile();
    await store.save(input);
    input.language = 'mutated';
    const list = await store.list();
    expect(list[0].profile.language).toBe(DEFAULT_PROFILE.language);
  });

  it('tolerates corrupt stored entries', async () => {
    const kv = new InMemoryKeyValueStore();
    await kv.set(VERSIONS_STORAGE_KEY, [
      { not: 'a version' },
      { id: '1', savedAt: 1, source: 'manual', profile: DEFAULT_PROFILE },
    ]);
    const store = new ProfileVersionStore(kv);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('1');
  });
});

describe('diffProfiles', () => {
  it('returns empty when profiles are identical', () => {
    expect(diffProfiles(DEFAULT_PROFILE, structuredClone(DEFAULT_PROFILE))).toEqual([]);
  });

  it('finds a top-level scalar change', () => {
    const after = cloneProfile({ language: 'hi' });
    const diff = diffProfiles(DEFAULT_PROFILE, after);
    expect(diff).toHaveLength(1);
    expect(diff[0].path).toBe('language');
    expect(diff[0].before).toBe('en');
    expect(diff[0].after).toBe('hi');
  });

  it('finds a nested scalar change', () => {
    const after = structuredClone(DEFAULT_PROFILE);
    after.sensory.fontScale = 1.5;
    const diff = diffProfiles(DEFAULT_PROFILE, after);
    expect(diff).toHaveLength(1);
    expect(diff[0].path).toBe('sensory.fontScale');
    expect(diff[0].after).toBe(1.5);
  });

  it('finds multiple nested changes', () => {
    const after = structuredClone(DEFAULT_PROFILE);
    after.sensory.fontScale = 1.2;
    after.sensory.contrastLevel = 1.5;
    after.motor.dwellClickDelay = 1200;
    const diff = diffProfiles(DEFAULT_PROFILE, after);
    expect(diff).toHaveLength(3);
    const paths = diff.map((d) => d.path).sort();
    expect(paths).toEqual([
      'motor.dwellClickDelay',
      'sensory.contrastLevel',
      'sensory.fontScale',
    ]);
  });
});
