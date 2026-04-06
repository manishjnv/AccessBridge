/**
 * ProfileStore tests
 *
 * ProfileStore uses browser-only APIs (indexedDB, sessionStorage, crypto.subtle).
 * We replace all three with lightweight in-memory fakes so the tests run under
 * Node / Vitest without any extra dependencies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory IndexedDB fake
// ---------------------------------------------------------------------------

function makeIDBFake() {
  /** One store keyed by store-name → record map */
  const stores: Record<string, Map<string, unknown>> = {};

  function makeRequest<T>(
    executor: () => T | Promise<T>,
  ): IDBRequest<T> {
    const callbacks: {
      onsuccess?: ((ev: Event) => void) | null;
      onerror?: ((ev: Event) => void) | null;
    } = {};

    const req = {
      get onsuccess() { return callbacks.onsuccess ?? null; },
      set onsuccess(fn: ((ev: Event) => void) | null) { callbacks.onsuccess = fn; },
      get onerror() { return callbacks.onerror ?? null; },
      set onerror(fn: ((ev: Event) => void) | null) { callbacks.onerror = fn; },
      result: undefined as unknown as T,
      error: null,
      source: null,
      transaction: null,
      readyState: 'pending' as IDBRequestReadyState,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as IDBRequest<T>;

    // Schedule the resolution on the next microtask tick
    Promise.resolve().then(async () => {
      try {
        const result = await executor();
        (req as { result: T }).result = result;
        (req as { readyState: string }).readyState = 'done';
        if (callbacks.onsuccess) callbacks.onsuccess({} as Event);
      } catch (err) {
        (req as { error: unknown }).error = err;
        (req as { readyState: string }).readyState = 'done';
        if (callbacks.onerror) callbacks.onerror({} as Event);
      }
    });

    return req;
  }

  function makeObjectStore(storeName: string) {
    if (!stores[storeName]) stores[storeName] = new Map();
    const map = stores[storeName]!;

    return {
      get: (key: string) => makeRequest(() => map.get(key)),
      put: (value: unknown) => {
        const record = value as { id: string };
        map.set(record.id, value);
        return makeRequest<IDBValidKey>(() => record.id);
      },
      delete: (key: string) => {
        map.delete(key);
        return makeRequest<undefined>(() => undefined);
      },
    };
  }

  function makeTransaction(storeNames: string | string[]) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const objectStores: Record<string, ReturnType<typeof makeObjectStore>> = {};
    for (const n of names) objectStores[n] = makeObjectStore(n);
    return {
      objectStore: (name: string) => objectStores[name]!,
    };
  }

  const db = {
    objectStoreNames: {
      contains: (name: string) => !!stores[name],
    },
    createObjectStore: (name: string) => {
      stores[name] = new Map();
      return makeObjectStore(name);
    },
    transaction: (storeNames: string | string[], _mode?: string) =>
      makeTransaction(storeNames),
  } as unknown as IDBDatabase;

  /** open() fake */
  function open(_name: string, _version: number): IDBOpenDBRequest {
    const callbacks: {
      onupgradeneeded?: ((ev: IDBVersionChangeEvent) => void) | null;
      onsuccess?: ((ev: Event) => void) | null;
      onerror?: ((ev: Event) => void) | null;
    } = {};

    const req = {
      result: db,
      error: null,
      source: null,
      transaction: null,
      readyState: 'pending' as IDBRequestReadyState,
      get onupgradeneeded() { return callbacks.onupgradeneeded ?? null; },
      set onupgradeneeded(fn: ((ev: IDBVersionChangeEvent) => void) | null) {
        callbacks.onupgradeneeded = fn;
      },
      get onsuccess() { return callbacks.onsuccess ?? null; },
      set onsuccess(fn: ((ev: Event) => void) | null) { callbacks.onsuccess = fn; },
      get onerror() { return callbacks.onerror ?? null; },
      set onerror(fn: ((ev: Event) => void) | null) { callbacks.onerror = fn; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as IDBOpenDBRequest;

    Promise.resolve().then(() => {
      // Trigger upgrade if the store doesn't exist yet
      if (callbacks.onupgradeneeded) {
        callbacks.onupgradeneeded({ target: req } as unknown as IDBVersionChangeEvent);
      }
      if (callbacks.onsuccess) callbacks.onsuccess({} as Event);
    });

    return req;
  }

  const indexedDBFake = { open } as unknown as IDBFactory;
  return { indexedDBFake, stores };
}

// ---------------------------------------------------------------------------
// sessionStorage fake
// ---------------------------------------------------------------------------

function makeSessionStorageFake(): Storage {
  const data: Record<string, string> = {};
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
    removeItem: (key: string) => { delete data[key]; },
    clear: () => { for (const k in data) delete data[k]; },
    get length() { return Object.keys(data).length; },
    key: (index: number) => Object.keys(data)[index] ?? null,
  } as Storage;
}

// ---------------------------------------------------------------------------
// crypto.subtle fake (AES-GCM encrypt/decrypt round-trip via plain JSON)
// ---------------------------------------------------------------------------

function makeCryptoFake() {
  const keyStore = new Map<object, string>();

  const subtle = {
    generateKey: async () => {
      const key = {};
      keyStore.set(key, 'fake-key');
      return key as CryptoKey;
    },
    importKey: async (
      _format: string,
      _raw: ArrayBuffer,
      _algo: string,
      _extractable: boolean,
      _usages: string[],
    ) => {
      const key = {};
      keyStore.set(key, 'imported-key');
      return key as CryptoKey;
    },
    exportKey: async (_format: string, _key: CryptoKey) => {
      // Return a small dummy ArrayBuffer (12 bytes)
      return new Uint8Array(12).buffer;
    },
    encrypt: async (
      _algo: { name: string; iv: Uint8Array },
      _key: CryptoKey,
      data: ArrayBuffer,
    ) => {
      // "Encrypt" = identity (just copy bytes) for testing purposes
      return (data as ArrayBuffer).slice(0);
    },
    decrypt: async (
      _algo: { name: string; iv: Uint8Array },
      _key: CryptoKey,
      data: ArrayBuffer,
    ) => {
      return (data as ArrayBuffer).slice(0);
    },
  };

  const getRandomValues = <T extends ArrayBufferView>(array: T): T => {
    // Fill with zeros for determinism in tests
    if (array instanceof Uint8Array) {
      array.fill(0);
    }
    return array;
  };

  return { subtle, getRandomValues } as unknown as Crypto;
}

// ---------------------------------------------------------------------------
// Set up globals before importing ProfileStore
// ---------------------------------------------------------------------------

const { indexedDBFake } = makeIDBFake();
vi.stubGlobal('indexedDB', indexedDBFake);
vi.stubGlobal('sessionStorage', makeSessionStorageFake());
vi.stubGlobal('crypto', makeCryptoFake());

// Now it is safe to import the module that uses these globals
const { ProfileStore } = await import('../profile/store.js');
const { DEFAULT_PROFILE } = await import('../types/profile.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileStore', () => {
  let store: InstanceType<typeof ProfileStore>;

  beforeEach(async () => {
    // Fresh store + fresh sessionStorage so key is re-generated each suite
    vi.stubGlobal('sessionStorage', makeSessionStorageFake());
    const { indexedDBFake: freshDB } = makeIDBFake();
    vi.stubGlobal('indexedDB', freshDB);
    store = new ProfileStore();
    await store.init();
  });

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------

  describe('init()', () => {
    it('initializes without throwing', async () => {
      const s = new ProfileStore();
      await expect(s.init()).resolves.toBeUndefined();
    });

    it('throws if any method is called before init()', async () => {
      const s = new ProfileStore();
      await expect(s.getProfile()).rejects.toThrow(/not initialized/i);
    });
  });

  // -------------------------------------------------------------------------
  // Default profile
  // -------------------------------------------------------------------------

  describe('getProfile() — default profile', () => {
    it('returns a profile with the requested id when none is stored', async () => {
      const profile = await store.getProfile('default');
      expect(profile.id).toBe('default');
    });

    it('falls back to DEFAULT_PROFILE values for sensory settings', async () => {
      const profile = await store.getProfile('default');
      expect(profile.sensory.fontScale).toBe(DEFAULT_PROFILE.sensory.fontScale);
      expect(profile.sensory.reducedMotion).toBe(DEFAULT_PROFILE.sensory.reducedMotion);
    });

    it('uses the correct default adaptation mode', async () => {
      const profile = await store.getProfile('default');
      expect(profile.adaptationMode).toBe('suggest');
    });

    it('uses the correct default confidence threshold', async () => {
      const profile = await store.getProfile('default');
      expect(profile.confidenceThreshold).toBe(0.6);
    });

    it('returns a distinct default profile for each id when none is saved', async () => {
      const a = await store.getProfile('alice');
      const b = await store.getProfile('bob');
      expect(a.id).toBe('alice');
      expect(b.id).toBe('bob');
    });
  });

  // -------------------------------------------------------------------------
  // saveProfile() / getProfile() round-trip
  // -------------------------------------------------------------------------

  describe('saveProfile() and getProfile() round-trip', () => {
    it('persists and retrieves a saved profile', async () => {
      const profile = await store.getProfile('default');
      profile.language = 'fr';
      await store.saveProfile(profile);

      const retrieved = await store.getProfile('default');
      expect(retrieved.language).toBe('fr');
    });

    it('saveProfile updates the updatedAt timestamp', async () => {
      const before = Date.now();
      const profile = await store.getProfile('default');
      await store.saveProfile(profile);
      const retrieved = await store.getProfile('default');
      expect(retrieved.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('can save and retrieve multiple distinct profiles', async () => {
      const p1 = { ...(await store.getProfile('user-1')), language: 'de' };
      const p2 = { ...(await store.getProfile('user-2')), language: 'ja' };
      await store.saveProfile(p1);
      await store.saveProfile(p2);

      const r1 = await store.getProfile('user-1');
      const r2 = await store.getProfile('user-2');
      expect(r1.language).toBe('de');
      expect(r2.language).toBe('ja');
    });

    it('overwrites existing profile on second save', async () => {
      const profile = await store.getProfile('default');
      profile.adaptationMode = 'auto';
      await store.saveProfile(profile);

      profile.adaptationMode = 'manual';
      await store.saveProfile(profile);

      const retrieved = await store.getProfile('default');
      expect(retrieved.adaptationMode).toBe('manual');
    });
  });

  // -------------------------------------------------------------------------
  // Updating profile fields
  // -------------------------------------------------------------------------

  describe('updating profile fields', () => {
    it('persists sensory profile changes', async () => {
      const profile = await store.getProfile('default');
      profile.sensory.fontScale = 1.5;
      await store.saveProfile(profile);

      const retrieved = await store.getProfile('default');
      expect(retrieved.sensory.fontScale).toBe(1.5);
    });

    it('persists cognitive profile changes', async () => {
      const profile = await store.getProfile('default');
      profile.cognitive.focusModeEnabled = true;
      await store.saveProfile(profile);

      const retrieved = await store.getProfile('default');
      expect(retrieved.cognitive.focusModeEnabled).toBe(true);
    });

    it('persists motor profile changes', async () => {
      const profile = await store.getProfile('default');
      profile.motor.voiceNavigationEnabled = true;
      await store.saveProfile(profile);

      const retrieved = await store.getProfile('default');
      expect(retrieved.motor.voiceNavigationEnabled).toBe(true);
    });

    it('preserves unmodified fields after partial update', async () => {
      const profile = await store.getProfile('default');
      const originalLineHeight = profile.sensory.lineHeight;
      profile.sensory.fontScale = 2.0;
      await store.saveProfile(profile);

      const retrieved = await store.getProfile('default');
      expect(retrieved.sensory.lineHeight).toBe(originalLineHeight);
    });
  });

  // -------------------------------------------------------------------------
  // clearProfile()
  // -------------------------------------------------------------------------

  describe('clearProfile()', () => {
    it('removing a profile causes getProfile to return the default again', async () => {
      const profile = await store.getProfile('default');
      profile.language = 'es';
      await store.saveProfile(profile);
      await store.clearProfile('default');

      const retrieved = await store.getProfile('default');
      // After clearing, language should be back to the default 'en'
      expect(retrieved.language).toBe('en');
    });

    it('clearProfile does not throw for a non-existent id', async () => {
      await expect(store.clearProfile('does-not-exist')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // exportProfile() / importProfile() round-trip
  // -------------------------------------------------------------------------

  describe('exportProfile() and importProfile() round-trip', () => {
    it('exported data is a JSON string', async () => {
      const exported = await store.exportProfile('default');
      expect(() => JSON.parse(exported)).not.toThrow();
    });

    it('round-trips a profile through export/import', async () => {
      const profile = await store.getProfile('default');
      profile.language = 'zh';
      await store.saveProfile(profile);

      const exported = await store.exportProfile('default');
      await store.clearProfile('default');

      const imported = await store.importProfile(exported);
      expect(imported.language).toBe('zh');
    });

    it('importProfile persists the profile so getProfile returns it', async () => {
      const profile = await store.getProfile('default');
      profile.adaptationMode = 'auto';
      await store.saveProfile(profile);

      const exported = await store.exportProfile('default');
      await store.clearProfile('default');
      await store.importProfile(exported);

      const retrieved = await store.getProfile('default');
      expect(retrieved.adaptationMode).toBe('auto');
    });
  });
});
