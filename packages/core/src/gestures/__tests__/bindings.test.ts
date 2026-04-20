import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GestureBindingStore } from '../bindings.js';
import { DEFAULT_GESTURE_BINDINGS } from '../types.js';

function mockStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
  };
}

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = mockStorage();
  vi.restoreAllMocks();
});

describe('GestureBindingStore', () => {
  it('loads defaults when localStorage has no entry', () => {
    const store = new GestureBindingStore();
    expect(store.getBindings()).toHaveLength(DEFAULT_GESTURE_BINDINGS.length);
    expect(store.getBinding('swipe-left')?.actionId).toBe('back');
  });

  it('persists setBinding so a new instance reads back the change', () => {
    const a = new GestureBindingStore();
    a.setBinding('swipe-left', 'reload');
    const b = new GestureBindingStore();
    expect(b.getBinding('swipe-left')?.actionId).toBe('reload');
  });

  it('resetToDefaults clears custom bindings', () => {
    const a = new GestureBindingStore();
    a.setBinding('swipe-left', 'reload');
    a.resetToDefaults();
    expect(a.getBinding('swipe-left')?.actionId).toBe('back');
    const b = new GestureBindingStore();
    expect(b.getBinding('swipe-left')?.actionId).toBe('back');
  });

  it('bindings survive reload via localStorage mock', () => {
    const a = new GestureBindingStore();
    a.setBinding('circle-cw', 'toggle-high-contrast');
    a.setEnabled('zigzag', false);
    const b = new GestureBindingStore();
    expect(b.getBinding('circle-cw')?.actionId).toBe('toggle-high-contrast');
    expect(b.getBinding('zigzag')?.enabled).toBe(false);
  });

  it('rejects invalid gesture types (warns, no state change)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GestureBindingStore();
    const before = store.getBindings();
    store.setBinding('not-a-gesture' as unknown as 'swipe-left', 'back');
    expect(store.getBindings()).toEqual(before);
    expect(warn).toHaveBeenCalled();
  });

  it('overwrites a duplicate gesture instead of appending a second entry', () => {
    const store = new GestureBindingStore();
    store.setBinding('swipe-left', 'reload');
    store.setBinding('swipe-left', 'new-tab');
    const matches = store.getBindings().filter((b) => b.gesture === 'swipe-left');
    expect(matches).toHaveLength(1);
    expect(matches[0].actionId).toBe('new-tab');
  });
});
