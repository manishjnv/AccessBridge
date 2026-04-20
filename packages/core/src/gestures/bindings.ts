import {
  DEFAULT_GESTURE_BINDINGS,
  GESTURE_TYPES,
  type GestureBinding,
  type GestureType,
} from './types.js';
import { getActionById } from './actions.js';

const STORAGE_KEY = 'accessbridge.gesture.bindings';

function getStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
      return (globalThis as { localStorage: Storage }).localStorage;
    }
  } catch {
    // Some environments throw on access.
  }
  return null;
}

function isGestureType(value: unknown): value is GestureType {
  return typeof value === 'string' && (GESTURE_TYPES as readonly string[]).includes(value);
}

function cloneDefaults(): GestureBinding[] {
  return DEFAULT_GESTURE_BINDINGS.map((b) => ({ ...b }));
}

export class GestureBindingStore {
  private bindings: GestureBinding[];
  private readonly storageKey: string;

  constructor(storageKey: string = STORAGE_KEY) {
    this.storageKey = storageKey;
    this.bindings = this.load();
  }

  getBindings(): GestureBinding[] {
    return this.bindings.map((b) => ({ ...b }));
  }

  getBinding(gesture: GestureType): GestureBinding | undefined {
    const hit = this.bindings.find((b) => b.gesture === gesture);
    return hit ? { ...hit } : undefined;
  }

  setBinding(gesture: GestureType, actionId: string): void {
    if (!isGestureType(gesture)) {
      console.warn(`[gestures] ignored setBinding: unknown gesture '${String(gesture)}'`);
      return;
    }
    if (!getActionById(actionId)) {
      console.warn(`[gestures] ignored setBinding: unknown actionId '${actionId}'`);
      return;
    }
    const idx = this.bindings.findIndex((b) => b.gesture === gesture);
    if (idx >= 0) {
      this.bindings[idx] = { ...this.bindings[idx], actionId };
    } else {
      this.bindings.push({ gesture, actionId, enabled: true });
    }
    this.persist();
  }

  setEnabled(gesture: GestureType, enabled: boolean): void {
    if (!isGestureType(gesture)) {
      console.warn(`[gestures] ignored setEnabled: unknown gesture '${String(gesture)}'`);
      return;
    }
    const idx = this.bindings.findIndex((b) => b.gesture === gesture);
    if (idx < 0) return;
    this.bindings[idx] = { ...this.bindings[idx], enabled };
    this.persist();
  }

  resetToDefaults(): void {
    this.bindings = cloneDefaults();
    this.persist();
  }

  private persist(): void {
    const storage = getStorage();
    if (!storage) return;
    try {
      storage.setItem(this.storageKey, JSON.stringify(this.bindings));
    } catch {
      // Quota / serialization errors are non-fatal.
    }
  }

  private load(): GestureBinding[] {
    const storage = getStorage();
    if (!storage) return cloneDefaults();
    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) return cloneDefaults();
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return cloneDefaults();
      const clean: GestureBinding[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        if (!isGestureType(rec.gesture)) continue;
        if (typeof rec.actionId !== 'string') continue;
        if (!getActionById(rec.actionId)) continue;
        const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : true;
        clean.push({ gesture: rec.gesture, actionId: rec.actionId, enabled });
      }
      return clean.length > 0 ? clean : cloneDefaults();
    } catch {
      return cloneDefaults();
    }
  }
}
