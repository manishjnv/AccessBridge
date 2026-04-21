import { describe, it, expect, beforeEach } from 'vitest';
import { UserCurationStore, type IDBFactoryLike } from '../user-curation-store.js';
import type { UnlabeledElement, RecoveredLabel, UserCurationRecord } from '../types.js';

// ----- In-memory IndexedDB stand-in ---------------------------------------
//
// Implements just enough of the IDB surface to exercise UserCurationStore.
// It is not a general-purpose IndexedDB mock — only the put/getAll/delete/clear
// transactions the store uses are supported.

type Rec = Record<string, unknown> & { id: string };

class MemoryObjectStore {
  records = new Map<string, Rec>();
  put(v: Rec) { this.records.set(v.id, v); }
  delete(id: string) { this.records.delete(id); }
  clear() { this.records.clear(); }
  getAll() { return Array.from(this.records.values()); }
}

class MemoryTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor(private store: MemoryObjectStore) {}
  objectStore(_name: string) {
    const self = this;
    return {
      put: (v: Rec) => { self.store.put(v); queueMicrotask(() => self.oncomplete?.()); },
      delete: (id: string) => { self.store.delete(id); queueMicrotask(() => self.oncomplete?.()); },
      clear: () => { self.store.clear(); queueMicrotask(() => self.oncomplete?.()); },
      getAll: () => {
        const req: { result: Rec[] | null; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
          result: null, onsuccess: null, onerror: null,
        };
        queueMicrotask(() => { req.result = self.store.getAll(); req.onsuccess?.(); });
        return req as unknown as IDBRequest;
      },
    } as unknown as IDBObjectStore;
  }
}

class MemoryDatabase {
  store = new MemoryObjectStore();
  objectStoreNames: { contains: (n: string) => boolean } = { contains: () => true };
  createObjectStore(_name: string, _opts: unknown) {
    return { createIndex: () => {} } as unknown as IDBObjectStore;
  }
  transaction(_names: string | string[], _mode?: string) {
    return new MemoryTransaction(this.store) as unknown as IDBTransaction;
  }
}

function makeMockFactory(): IDBFactoryLike {
  return {
    open: () => {
      const db = new MemoryDatabase();
      const req: {
        result: MemoryDatabase;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = {
        result: db,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req as unknown as IDBOpenDBRequest;
    },
  };
}

// ----- Test fixtures ------------------------------------------------------

function el(overrides: Partial<UnlabeledElement> = {}): UnlabeledElement {
  return {
    nodeHint: 'button.icon',
    bbox: { x: 0, y: 0, w: 40, h: 40 },
    computedRole: 'button',
    currentAriaLabel: null,
    textContent: '',
    siblingContext: 'Submit form',
    classSignature: 'sig-ab',
    backgroundImageUrl: null,
    ...overrides,
  };
}

function rec(overrides: Partial<RecoveredLabel> = {}): RecoveredLabel {
  return {
    element: el(),
    inferredRole: 'button',
    inferredLabel: 'submit',
    inferredDescription: 'Submit the form',
    confidence: 0.8,
    source: 'on-device-vlm',
    tier: 3,
    screenshotHash: 'abc123',
    ...overrides,
  };
}

// ----- Tests --------------------------------------------------------------

describe('UserCurationStore', () => {
  let store: UserCurationStore;

  beforeEach(() => {
    store = new UserCurationStore({ idbFactory: makeMockFactory() });
  });

  it('save then list returns the record', async () => {
    const res = await store.save({
      element: el(),
      recovered: rec(),
      status: 'accepted',
      domain: 'example.com',
      appVersion: 'v1',
    });
    expect(res.ok).toBe(true);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect((list[0] as UserCurationRecord).status).toBe('accepted');
  });

  it('deterministic id: same (appVersion, classSignature, screenshotHash) → same id', () => {
    const id1 = UserCurationStore.buildId('v1', el({ classSignature: 'x' }), 'h1');
    const id2 = UserCurationStore.buildId('v1', el({ classSignature: 'x' }), 'h1');
    expect(id1).toBe(id2);
    expect(id1).toContain('v1');
    expect(id1).toContain('x');
    expect(id1).toContain('h1');
  });

  it('no screenshotHash → id uses "nohash" sentinel', () => {
    const id = UserCurationStore.buildId('v1', el({ classSignature: 'x' }), undefined);
    expect(id).toContain('nohash');
  });

  it('editedLabel is sanitized: HTML / quotes stripped', async () => {
    await store.save({
      element: el(),
      recovered: rec(),
      status: 'edited',
      editedLabel: '<script>alert(1)</script>"evil"',
      domain: 'example.com',
      appVersion: 'v1',
    });
    const list = await store.list();
    const edited = (list[0] as UserCurationRecord).editedLabel ?? '';
    expect(edited).not.toContain('<');
    expect(edited).not.toContain('>');
    expect(edited).not.toContain('"');
  });

  it('editedLabel is truncated at MAX_LABEL_CHARS', async () => {
    const long = 'x'.repeat(1000);
    await store.save({
      element: el(),
      recovered: rec(),
      status: 'edited',
      editedLabel: long,
      domain: 'example.com',
      appVersion: 'v1',
    });
    const list = await store.list();
    expect((list[0] as UserCurationRecord).editedLabel!.length).toBeLessThanOrEqual(UserCurationStore.MAX_LABEL_CHARS);
  });

  it('domain is sanitized: non-hostname chars stripped', async () => {
    await store.save({
      element: el(),
      recovered: rec(),
      status: 'accepted',
      domain: 'BAD<script>.com/path?q=1',
      appVersion: 'v1',
    });
    const list = await store.list();
    const d = (list[0] as UserCurationRecord).domain;
    expect(d).not.toContain('<');
    expect(d).not.toContain('?');
    expect(d).not.toContain('/');
    // strip: 'BAD<script>.com/path?q=1' -> 'BADscript.compathq1' -> lowercased
    expect(d).toBe('badscript.compathq1');
  });

  it('same id upsert replaces (no duplicate records)', async () => {
    const element = el({ classSignature: 'same' });
    const recorded = rec({ element, screenshotHash: 'H' });
    await store.save({ element, recovered: recorded, status: 'accepted', domain: 'x.com', appVersion: 'v1' });
    await store.save({ element, recovered: recorded, status: 'rejected', domain: 'x.com', appVersion: 'v1' });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect((list[0] as UserCurationRecord).status).toBe('rejected');
  });

  it('delete by id removes record', async () => {
    const element = el({ classSignature: 'd1' });
    const recorded = rec({ element, screenshotHash: 'h1' });
    const saved = await store.save({
      element, recovered: recorded, status: 'accepted', domain: 'x.com', appVersion: 'v1',
    });
    const del = await store.delete(saved.id!);
    expect(del.ok).toBe(true);
    const list = await store.list();
    expect(list).toHaveLength(0);
  });

  it('clear removes all records', async () => {
    for (let i = 0; i < 5; i++) {
      await store.save({
        element: el({ classSignature: 'c' + i }),
        recovered: rec({ screenshotHash: 'h' + i }),
        status: 'accepted',
        domain: 'x.com',
        appVersion: 'v1',
      });
    }
    await store.clear();
    const list = await store.list();
    expect(list).toHaveLength(0);
  });

  it('exportAsJson returns a valid JSON string with schema + records', async () => {
    await store.save({
      element: el(),
      recovered: rec(),
      status: 'accepted',
      domain: 'x.com',
      appVersion: 'v1',
    });
    const json = await store.exportAsJson();
    const parsed = JSON.parse(json) as { schema: number; count: number; records: UserCurationRecord[] };
    expect(parsed.schema).toBe(1);
    expect(parsed.count).toBe(1);
    expect(Array.isArray(parsed.records)).toBe(true);
  });

  it('null idbFactory → all methods null-safe (no throw)', async () => {
    const noDb = new UserCurationStore({ idbFactory: null });
    const r = await noDb.save({
      element: el(),
      recovered: rec(),
      status: 'accepted',
      domain: 'x.com',
      appVersion: 'v1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('idb-unavailable');
    expect(await noDb.list()).toEqual([]);
  });

  it('editedLabel — null bytes and control characters stripped', async () => {
    await store.save({
      element: el(),
      recovered: rec(),
      status: 'edited',
      editedLabel: 'hi thereworld',
      domain: 'x.com',
      appVersion: 'v1',
    });
    const list = await store.list();
    expect((list[0] as UserCurationRecord).editedLabel).toBe('hithereworld');
  });
});
