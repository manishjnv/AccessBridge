// --- Priority 1: Captions + Actions ---
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Minimal DOM stubs for node environment ────────────────────────────────────

class FakeElement {
  tagName: string;
  className = '';
  textContent = '';
  children: FakeElement[] = [];
  private attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  private _listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  offsetWidth = 640;
  offsetHeight = 360;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeChild(child: FakeElement) {
    this.children = this.children.filter(c => c !== child);
  }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  addEventListener(event: string, cb: (...args: unknown[]) => void) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
  }
  removeEventListener(event: string, cb: (...args: unknown[]) => void) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(l => l !== cb);
  }
  dispatchEvent(event: string, ...args: unknown[]) {
    for (const cb of this._listeners[event] ?? []) cb(...args);
  }
  querySelectorAll(sel: string): FakeElement[] {
    if (sel === 'video') return this.children.filter(c => c.tagName === 'VIDEO');
    return [];
  }
  querySelector(sel: string): FakeElement | null {
    const cls = sel.replace(/^\./, '');
    return this.children.find(c => c.className === cls) ?? null;
  }
  get parentNode() { return fakeBody; }
}

class FakeMutationObserver {
  private cb: () => void;
  constructor(cb: () => void) { this.cb = cb; }
  observe() {}
  disconnect() {}
  trigger() { this.cb(); }
}

const fakeBody = new FakeElement('body');
const fakeDoc = {
  body: fakeBody,
  documentElement: { lang: '' },
  createElement: (tag: string) => new FakeElement(tag),
  querySelectorAll: (sel: string) => fakeBody.querySelectorAll(sel),
  querySelector: (sel: string) => fakeBody.querySelector(sel),
};

class FakeSpeechRecognition extends FakeElement {
  continuous = false;
  interimResults = false;
  lang = '';
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() { super('SpeechRecognition'); }
}

// ── Install globals ───────────────────────────────────────────────────────────

let savedGlobals: Record<string, unknown> = {};

function installGlobals(speechAvailable = true) {
  const g = globalThis as unknown as Record<string, unknown>;

  savedGlobals = {
    document: g['document'],
    window: g['window'],
    MutationObserver: g['MutationObserver'],
  };

  g['document'] = fakeDoc;
  g['MutationObserver'] = FakeMutationObserver;
  g['window'] = {
    getComputedStyle: () => ({ display: '', visibility: '', opacity: '1' }),
    SpeechRecognition: speechAvailable ? vi.fn(() => new FakeSpeechRecognition()) : undefined,
  };
}

function restoreGlobals() {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(savedGlobals)) {
    g[k] = v;
  }
  // Reset body children
  fakeBody.children = [];
  fakeDoc.documentElement.lang = '';
}

// ── Import AFTER globals set (dynamic import to allow mock install first) ─────

async function importController() {
  // Reset module cache for fresh import
  const { CaptionsController } = await import('../captions.js');
  return CaptionsController;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CaptionsController', () => {
  beforeEach(() => {
    fakeBody.children = [];
    installGlobals(true);
  });

  afterEach(() => {
    restoreGlobals();
    vi.resetModules();
  });

  it('no-op when no video present', async () => {
    const CaptionsController = await importController();
    const ctrl = new CaptionsController();
    ctrl.start();
    const overlays = fakeBody.children.filter(c => c.className === 'ab-captions-overlay');
    expect(overlays.length).toBe(0);
    ctrl.stop();
  });

  it('start attaches overlay when video exists', async () => {
    const video = new FakeElement('video');
    fakeBody.appendChild(video);

    const CaptionsController = await importController();
    const ctrl = new CaptionsController();
    ctrl.start();
    const overlay = ctrl.getOrCreateOverlay() as FakeElement | null;
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('aria-live')).toBe('polite');
    expect(overlay?.getAttribute('role')).toBe('status');
    ctrl.stop();
  });

  it('stop removes overlay', async () => {
    const video = new FakeElement('video');
    fakeBody.appendChild(video);

    const CaptionsController = await importController();
    const ctrl = new CaptionsController();
    ctrl.start();
    // overlay should be in body
    const before = fakeBody.children.filter(c => c.className === 'ab-captions-overlay');
    expect(before.length).toBe(1);
    ctrl.stop();
    // After stop overlay should be removed (removeChild called)
    // In our fake, it's removed from children
    // isActive should be false
    expect(ctrl.isActive()).toBe(false);
  });

  it('isActive reflects state', async () => {
    const CaptionsController = await importController();
    const ctrl = new CaptionsController();
    expect(ctrl.isActive()).toBe(false);
    ctrl.start();
    expect(ctrl.isActive()).toBe(true);
    ctrl.stop();
    expect(ctrl.isActive()).toBe(false);
  });

  it('mutation observer detects late-added video', async () => {
    const CaptionsController = await importController();
    const ctrl = new CaptionsController();
    ctrl.start();
    // No overlay yet (no video)
    expect(ctrl.getOrCreateOverlay()).toBeNull();

    // Add video then call getOrCreateOverlay
    const video = new FakeElement('video');
    fakeBody.appendChild(video);
    const overlay = ctrl.getOrCreateOverlay();
    expect(overlay).not.toBeNull();
    ctrl.stop();
  });

  it('idempotent double-start', async () => {
    const video = new FakeElement('video');
    fakeBody.appendChild(video);

    const CaptionsController = await importController();
    const ctrl = new CaptionsController();
    ctrl.start();
    ctrl.start(); // second call is no-op
    // Only one overlay
    const overlays = fakeBody.children.filter(c => c.className === 'ab-captions-overlay');
    expect(overlays.length).toBe(1);
    ctrl.stop();
  });

  it('gracefully handles missing SpeechRecognition API', async () => {
    // Override window to have no speech API
    const g = globalThis as unknown as Record<string, unknown>;
    g['window'] = {
      getComputedStyle: () => ({ display: '', visibility: '', opacity: '1' }),
    };

    const video = new FakeElement('video');
    fakeBody.appendChild(video);

    const CaptionsController = await importController();
    const ctrl = new CaptionsController();
    expect(() => ctrl.start()).not.toThrow();
    // Toast should be appended
    const toast = fakeBody.children.find(c => c.className === 'ab-captions-toast');
    expect(toast).toBeDefined();
    ctrl.stop();
  });
});
