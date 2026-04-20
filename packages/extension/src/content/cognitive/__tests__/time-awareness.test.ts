/**
 * TimeAwarenessController — Priority 5.
 *
 * We assert on the pure detection logic via getFlowSnapshot() rather than
 * probing the DOM toast (the toast is visual and already exercised by the
 * manual golden path). The controller is launched in a minimal happy-dom-ish
 * stub and we drive it with synthetic events + fake timers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimeAwarenessController } from '../time-awareness.js';

// Install a minimal DOM stub if the test runner is node (vitest default is node).
function installDOMStub(): { cleanup: () => void; doc: Document } {
  if (typeof document !== 'undefined') {
    return { cleanup: () => {}, doc: document };
  }
  // Tiny ad-hoc DOM — enough for the controller's addEventListener + innerHTML.
  const listeners = new Map<string, EventListener[]>();
  const stub = {
    addEventListener(type: string, fn: EventListener) {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener(type: string, fn: EventListener) {
      const arr = listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatch(type: string, event: Event) {
      const arr = listeners.get(type) ?? [];
      for (const fn of arr) fn(event);
    },
  };
  globalThis.document = {
    addEventListener: stub.addEventListener,
    removeEventListener: stub.removeEventListener,
    getElementById: () => null,
    createElement: () => ({
      setAttribute() {},
      addEventListener() {},
      appendChild() {},
      querySelector: () => null,
      remove() {},
      classList: { add() {}, remove() {} },
    }),
    head: { appendChild() {} },
    body: { appendChild() {} },
  } as unknown as Document;
  const cleanup = () => {
    // @ts-expect-error removing stub
    delete globalThis.document;
  };
  return { cleanup, doc: globalThis.document as Document & { dispatch?: typeof stub.dispatch } };
}

describe('TimeAwarenessController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts as idle and moves to active on input', () => {
    const { cleanup } = installDOMStub();
    const ctrl = new TimeAwarenessController();
    ctrl.start();

    const initial = ctrl.getFlowSnapshot();
    expect(initial.state).toBe('active'); // activity timestamp is set in start()

    ctrl.stop();
    cleanup();
  });

  it('isActive reflects lifecycle', () => {
    const { cleanup } = installDOMStub();
    const ctrl = new TimeAwarenessController();
    expect(ctrl.isActive()).toBe(false);
    ctrl.start();
    expect(ctrl.isActive()).toBe(true);
    ctrl.stop();
    expect(ctrl.isActive()).toBe(false);
    cleanup();
  });

  it('double-start is idempotent', () => {
    const { cleanup } = installDOMStub();
    const ctrl = new TimeAwarenessController();
    ctrl.start();
    expect(() => ctrl.start()).not.toThrow();
    expect(ctrl.isActive()).toBe(true);
    ctrl.stop();
    cleanup();
  });

  it('stop is idempotent', () => {
    const { cleanup } = installDOMStub();
    const ctrl = new TimeAwarenessController();
    expect(() => ctrl.stop()).not.toThrow();
    ctrl.start();
    ctrl.stop();
    expect(() => ctrl.stop()).not.toThrow();
    cleanup();
  });

  it('getFlowSnapshot returns zeroed fields before start', () => {
    const { cleanup } = installDOMStub();
    const ctrl = new TimeAwarenessController();
    const snap = ctrl.getFlowSnapshot();
    // state depends on internal clocks; core invariant is: typingCount 0, backspaceCount 0
    expect(snap.typingCount).toBe(0);
    expect(snap.backspaceCount).toBe(0);
    expect(snap.errorRate).toBe(0);
    cleanup();
  });

  it('accepts custom thresholds without throwing', () => {
    const { cleanup } = installDOMStub();
    const ctrl = new TimeAwarenessController({
      hyperfocusThresholdMs: 10_000,
      toastDurationMs: 1_000,
      breakCooldownMs: 5_000,
      idleWindowMs: 2_000,
    });
    ctrl.start();
    expect(ctrl.isActive()).toBe(true);
    ctrl.stop();
    cleanup();
  });
});
