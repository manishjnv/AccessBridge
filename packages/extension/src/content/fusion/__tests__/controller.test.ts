/**
 * FusionController integration tests.
 *
 * Covers the public lifecycle surface: option merge, start/stop gating,
 * report* no-op when not running, rate limit on intent forwarding, and the
 * FUSION_GET_STATS message handler. DOM and chrome.* are stubbed; the engine
 * itself is covered by the 114 core-package fusion tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FusionController, registerFusionStatsHandler } from '../controller.js';

// ─── Stubs ──────────────────────────────────────────────────────────────────

type Listener = (e: Event) => void;
interface DocStub {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  elementFromPoint?: () => Element | null;
  hidden?: boolean;
  listeners: Map<string, Listener[]>;
}

function createDocStub(): DocStub {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    addEventListener: vi.fn((type: string, cb: Listener) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(cb);
    }),
    removeEventListener: vi.fn((type: string, cb: Listener) => {
      const list = listeners.get(type);
      if (list) listeners.set(type, list.filter((x) => x !== cb));
    }),
    elementFromPoint: () => null,
    hidden: false,
  };
}

let msgSpy: ReturnType<typeof vi.fn>;
let listenerSpy: ReturnType<typeof vi.fn>;
let onMessageListeners: Array<(msg: unknown, sender: unknown, sendResponse: (v: unknown) => void) => void>;

beforeEach(() => {
  const docStub = createDocStub();
  onMessageListeners = [];
  msgSpy = vi.fn().mockResolvedValue({ ok: true });
  listenerSpy = vi.fn((cb) => {
    onMessageListeners.push(cb);
  });
  vi.stubGlobal('document', docStub);
  vi.stubGlobal('window', {
    addEventListener: docStub.addEventListener,
    removeEventListener: docStub.removeEventListener,
    scrollY: 0,
  });
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: msgSpy,
      onMessage: {
        addListener: listenerSpy,
      },
    },
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('FusionController', () => {
  it('constructs with defaults when no options are passed', () => {
    const ctl = new FusionController();
    const opts = ctl.getOptions();
    expect(opts.enabled).toBe(false);
    expect(opts.windowMs).toBe(3000);
    expect(opts.compensationEnabled).toBe(true);
    expect(opts.intentMinConfidence).toBe(0.65);
  });

  it('merges partial options over defaults', () => {
    const ctl = new FusionController({ windowMs: 5000, intentMinConfidence: 0.8 });
    const opts = ctl.getOptions();
    expect(opts.windowMs).toBe(5000);
    expect(opts.intentMinConfidence).toBe(0.8);
    expect(opts.compensationEnabled).toBe(true);
  });

  it('setOptions patches without losing unspecified fields', () => {
    const ctl = new FusionController();
    ctl.setOptions({ intentMinConfidence: 0.9 });
    expect(ctl.getOptions().intentMinConfidence).toBe(0.9);
    expect(ctl.getOptions().windowMs).toBe(3000);
  });

  it('start() is a no-op when enabled=false', () => {
    const ctl = new FusionController({ enabled: false });
    ctl.start();
    expect(ctl.isRunning()).toBe(false);
    expect(ctl.getCurrentContext()).toBeNull();
    expect(ctl.getStats()).toBeNull();
  });

  it('start() attaches DOM listeners when enabled=true', () => {
    const ctl = new FusionController({ enabled: true });
    ctl.start();
    expect(ctl.isRunning()).toBe(true);
    // keyboard, mousemove, click, scroll, touchstart, pointerdown, visibility, beforeunload
    const doc = (globalThis as unknown as { document: DocStub }).document;
    expect(doc.addEventListener).toHaveBeenCalled();
    ctl.stop();
  });

  it('stop() detaches listeners and disposes engine', () => {
    const ctl = new FusionController({ enabled: true });
    ctl.start();
    ctl.stop();
    expect(ctl.isRunning()).toBe(false);
    expect(ctl.getCurrentContext()).toBeNull();
    const doc = (globalThis as unknown as { document: DocStub }).document;
    expect(doc.removeEventListener).toHaveBeenCalled();
  });

  it('report* methods are no-ops when not running', () => {
    const ctl = new FusionController({ enabled: false });
    ctl.reportGaze(10, 20);
    ctl.reportVoice('hello');
    ctl.reportEnvironment({ lightLevel: 0.5 });
    // No throw, no engine. sendMessage should NOT have fired.
    expect(msgSpy).not.toHaveBeenCalled();
  });

  it('rate-limits intent forwarding to once per 1500ms per type', () => {
    const ctl = new FusionController({ enabled: true, intentMinConfidence: 0.1 });
    ctl.start();
    // Directly invoke private onIntent via re-emit path. Simulate by calling
    // chrome sendMessage observationally: drive two fabricated dispatches.
    // Easier: call the private via forced typing.
    const emit = (ctl as unknown as { onIntent: (h: unknown) => void }).onIntent.bind(ctl);
    const hypothesis = {
      intent: 'reading',
      confidence: 0.9,
      supportingEvents: ['e1'],
      suggestedAdaptations: ['reading-mode'],
    };
    emit(hypothesis);
    emit(hypothesis); // second fire within 1500ms → suppressed
    const fusionCalls = msgSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'FUSION_INTENT_EMITTED',
    );
    expect(fusionCalls.length).toBe(1);
    ctl.stop();
  });

  it('allows the same intent to re-fire after 1500ms', () => {
    const ctl = new FusionController({ enabled: true, intentMinConfidence: 0.1 });
    ctl.start();
    const emit = (ctl as unknown as { onIntent: (h: unknown) => void }).onIntent.bind(ctl);
    const hypothesis = {
      intent: 'hesitation',
      confidence: 0.9,
      supportingEvents: ['e1'],
      suggestedAdaptations: ['inline-help'],
    };
    emit(hypothesis);
    vi.advanceTimersByTime(1600);
    emit(hypothesis);
    const fusionCalls = msgSpy.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'FUSION_INTENT_EMITTED',
    );
    expect(fusionCalls.length).toBe(2);
    ctl.stop();
  });

  it('registerFusionStatsHandler wires an onMessage listener', () => {
    registerFusionStatsHandler(() => null);
    expect(listenerSpy).toHaveBeenCalledTimes(1);
    expect(onMessageListeners.length).toBe(1);
  });

  it('FUSION_GET_STATS returns {running:false} when no controller', () => {
    registerFusionStatsHandler(() => null);
    const responses: unknown[] = [];
    onMessageListeners[0]({ type: 'FUSION_GET_STATS' }, {}, (r) => responses.push(r));
    expect(responses[0]).toEqual({ running: false });
  });

  it('FUSION_GET_STATS returns stats object when controller running', () => {
    const ctl = new FusionController({ enabled: true });
    ctl.start();
    registerFusionStatsHandler(() => ctl);
    const responses: unknown[] = [];
    onMessageListeners[0]({ type: 'FUSION_GET_STATS' }, {}, (r) => responses.push(r));
    expect(responses[0]).toHaveProperty('running', true);
    expect(responses[0]).toHaveProperty('stats');
    expect(responses[0]).toHaveProperty('weights');
    ctl.stop();
  });

  it('ignores messages other than FUSION_GET_STATS', () => {
    registerFusionStatsHandler(() => null);
    const responses: unknown[] = [];
    onMessageListeners[0]({ type: 'OTHER' }, {}, (r) => responses.push(r));
    expect(responses.length).toBe(0);
  });
});
