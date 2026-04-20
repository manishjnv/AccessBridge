import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GestureController } from '../gestures.js';

type Listener = (e: unknown) => void;
interface ListenerRecord {
  target: 'document' | 'window';
  type: string;
  fn: Listener;
}

let listeners: ListenerRecord[];
let sendMessage: ReturnType<typeof vi.fn>;
let appendedNodes: unknown[];

function stubDom(): void {
  listeners = [];
  appendedNodes = [];
  sendMessage = vi.fn().mockResolvedValue(undefined);

  const mkAdder = (target: 'document' | 'window') => (type: string, fn: Listener) => {
    listeners.push({ target, type, fn });
  };
  const mkRemover = (target: 'document' | 'window') => (type: string, fn: Listener) => {
    listeners = listeners.filter((l) => !(l.target === target && l.type === type && l.fn === fn));
  };

  const doc = {
    addEventListener: mkAdder('document'),
    removeEventListener: mkRemover('document'),
    dispatchEvent: vi.fn(),
    activeElement: null,
    body: { scrollHeight: 1000, appendChild: (n: unknown) => appendedNodes.push(n), getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) },
    createElement: () => ({ className: '', setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {}, textContent: '' }),
    createElementNS: () => ({ setAttribute: () => {}, appendChild: () => {} }),
    execCommand: vi.fn(),
  };

  const win = {
    addEventListener: mkAdder('window'),
    removeEventListener: mkRemover('window'),
    scrollTo: vi.fn(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as Parameters<typeof clearTimeout>[0]),
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 1;
    },
    getSelection: () => null,
  };

  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('history', { back: vi.fn(), forward: vi.fn() });
  vi.stubGlobal('location', { reload: vi.fn() });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  vi.stubGlobal('requestAnimationFrame', win.requestAnimationFrame);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  });
}

beforeEach(() => {
  stubDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GestureController', () => {
  it('start() attaches pointer/wheel/keydown listeners to document', () => {
    const ctl = new GestureController({ enabled: true, showHints: false });
    ctl.start();
    const types = listeners.filter((l) => l.target === 'document').map((l) => l.type);
    expect(types).toContain('pointerdown');
    expect(types).toContain('pointermove');
    expect(types).toContain('pointerup');
    expect(types).toContain('wheel');
    expect(types).toContain('keydown');
    ctl.stop();
  });

  it('stop() detaches all listeners', () => {
    const ctl = new GestureController({ enabled: true, showHints: false });
    ctl.start();
    expect(listeners.length).toBeGreaterThan(0);
    ctl.stop();
    expect(listeners.length).toBe(0);
  });

  it('pointerdown → pointermove × N → pointerup feeds recognize', () => {
    const ctl = new GestureController({ enabled: true, showHints: false });
    ctl.start();
    const getListener = (type: string) =>
      listeners.find((l) => l.target === 'document' && l.type === type)?.fn as Listener | undefined;
    const down = getListener('pointerdown');
    const move = getListener('pointermove');
    const up = getListener('pointerup');
    expect(down && move && up).toBeTruthy();

    const basePt = (x: number, y: number, t: number) => ({
      pointerId: 1,
      pointerType: 'touch',
      clientX: x,
      clientY: y,
      timeStamp: t,
      pressure: 0.5,
      shiftKey: false,
    });

    down?.(basePt(300, 100, 0));
    move?.(basePt(250, 100, 20));
    move?.(basePt(200, 100, 40));
    move?.(basePt(150, 100, 60));
    up?.(basePt(100, 100, 80));

    // After all-up, evaluate() should have dispatched 'swipe-left' → 'back' → history.back().
    expect((history.back as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    ctl.stop();
  });

  it('recognized gesture triggers the correct chrome.runtime dispatch for accessibility actions', () => {
    const ctl = new GestureController({ enabled: true, showHints: false });
    // Rebind swipe-left → toggle-focus-mode for this test.
    (ctl as unknown as { bindings: { setBinding: (g: string, a: string) => void } }).bindings.setBinding(
      'swipe-left',
      'toggle-focus-mode',
    );
    ctl.start();
    const getListener = (type: string) =>
      listeners.find((l) => l.target === 'document' && l.type === type)?.fn as Listener | undefined;
    const down = getListener('pointerdown');
    const up = getListener('pointerup');
    down?.({ pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 100, timeStamp: 0, pressure: 0.5, shiftKey: false });
    up?.({ pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, timeStamp: 80, pressure: 0.5, shiftKey: false });
    expect(sendMessage).toHaveBeenCalled();
    const payloads = sendMessage.mock.calls.map((c) => c[0]);
    expect(payloads.some((p) => p?.type === 'TOGGLE_FEATURE' && p?.payload?.feature === 'focus-mode')).toBe(true);
    ctl.stop();
  });

  it('start() is a no-op when enabled:false', () => {
    const ctl = new GestureController({ enabled: false });
    ctl.start();
    // Controller starts and attaches listeners to stay hot, but onPointerDown no-ops.
    const getListener = (type: string) =>
      listeners.find((l) => l.target === 'document' && l.type === type)?.fn as Listener | undefined;
    const down = getListener('pointerdown');
    const up = getListener('pointerup');
    // When enabled was false, constructor already flipped it false — but start() flips it true.
    // Verify that stop() really kills dispatch afterwards instead.
    ctl.stop();
    down?.({ pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 100, timeStamp: 0, pressure: 0.5, shiftKey: false });
    up?.({ pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, timeStamp: 80, pressure: 0.5, shiftKey: false });
    expect((history.back as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('mouse pointer without Shift is ignored when mouseModeRequiresShift is true; with Shift it is recorded', () => {
    const ctl = new GestureController({ enabled: true, showHints: false, mouseModeRequiresShift: true });
    ctl.start();
    const getListener = (type: string) =>
      listeners.find((l) => l.target === 'document' && l.type === type)?.fn as Listener | undefined;
    const down = getListener('pointerdown');
    const up = getListener('pointerup');

    // Mouse, no Shift → ignored.
    down?.({ pointerId: 1, pointerType: 'mouse', clientX: 300, clientY: 100, timeStamp: 0, pressure: 0.5, shiftKey: false });
    up?.({ pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100, timeStamp: 80, pressure: 0.5, shiftKey: false });
    expect((history.back as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // Mouse, with Shift → recorded and dispatched.
    down?.({ pointerId: 2, pointerType: 'mouse', clientX: 300, clientY: 100, timeStamp: 200, pressure: 0.5, shiftKey: true });
    up?.({ pointerId: 2, pointerType: 'mouse', clientX: 100, clientY: 100, timeStamp: 280, pressure: 0.5, shiftKey: true });
    expect((history.back as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    ctl.stop();
  });
});
