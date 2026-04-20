// Tests for Session 7 extensions to CaptionsController:
//   - constructor options (language, position, fontSize, targetLanguage, translate)
//   - configure() live updates
//   - translation callback integration
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Minimal DOM shim (matching captions.test.ts pattern) ────────────────────

class FakeElement {
  tagName: string;
  className = '';
  textContent = '';
  children: FakeElement[] = [];
  private attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  private listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  offsetWidth = 640;
  offsetHeight = 360;
  dataset: Record<string, string> = {};

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  appendChild(ch: FakeElement) { this.children.push(ch); return ch; }
  removeChild(ch: FakeElement) { this.children = this.children.filter((x) => x !== ch); }
  addEventListener(ev: string, cb: (...a: unknown[]) => void) {
    (this.listeners[ev] ??= []).push(cb);
  }
  removeEventListener(ev: string, cb: (...a: unknown[]) => void) {
    this.listeners[ev] = (this.listeners[ev] ?? []).filter((l) => l !== cb);
  }
  dispatchEvent(ev: string, ...args: unknown[]) {
    for (const cb of this.listeners[ev] ?? []) cb(...args);
  }
  querySelector(sel: string): FakeElement | null {
    const cls = sel.replace(/^\./, '');
    for (const ch of this.children) {
      if (ch.className === cls) return ch;
    }
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    if (sel === 'video') return this.children.filter((c) => c.tagName === 'VIDEO');
    return [];
  }
  get parentNode() { return fakeBody; }
  getBoundingClientRect() {
    return { left: 100, top: 100, width: 300, height: 40, right: 400, bottom: 140, x: 100, y: 100, toJSON: () => ({}) };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

const fakeBody = new FakeElement('body');
const fakeDoc = {
  body: fakeBody,
  documentElement: { lang: '' },
  createElement: (t: string) => new FakeElement(t),
  querySelectorAll: (s: string) => fakeBody.querySelectorAll(s),
  querySelector: (s: string) => fakeBody.querySelector(s),
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

let savedGlobals: Record<string, unknown> = {};
let lastRecognizer: FakeSpeechRecognition | null = null;

function installGlobals(lang = '') {
  const g = globalThis as unknown as Record<string, unknown>;
  savedGlobals = {
    document: g['document'],
    window: g['window'],
    MutationObserver: g['MutationObserver'],
  };
  fakeDoc.documentElement.lang = lang;
  g['document'] = fakeDoc;
  g['MutationObserver'] = class { observe(): void {} disconnect(): void {} };
  g['window'] = {
    getComputedStyle: () => ({ display: '', visibility: '', opacity: '1' }),
    SpeechRecognition: vi.fn(() => {
      lastRecognizer = new FakeSpeechRecognition();
      return lastRecognizer;
    }),
  };
}

function restoreGlobals() {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(savedGlobals)) g[k] = v;
  fakeBody.children = [];
  fakeDoc.documentElement.lang = '';
  lastRecognizer = null;
}

async function importCaptions() {
  const { CaptionsController } = await import('../captions.js');
  return CaptionsController;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CaptionsController constructor options', () => {
  beforeEach(() => {
    fakeBody.children = [];
    installGlobals();
  });
  afterEach(() => {
    restoreGlobals();
    vi.resetModules();
  });

  it('default options — no language → falls back to en-US', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const ctrl = new CaptionsController();
    ctrl.start();
    expect(lastRecognizer?.lang).toBe('en-US');
    ctrl.stop();
  });

  it('language option propagates to SpeechRecognition.lang', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const ctrl = new CaptionsController({ language: 'hi-IN' });
    ctrl.start();
    expect(lastRecognizer?.lang).toBe('hi-IN');
    ctrl.stop();
  });

  it('empty language + documentElement.lang wins over en-US fallback', async () => {
    restoreGlobals();
    installGlobals('fr-FR');
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const ctrl = new CaptionsController();
    ctrl.start();
    expect(lastRecognizer?.lang).toBe('fr-FR');
    ctrl.stop();
  });

  it('fontSize option applied to overlay style', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const ctrl = new CaptionsController({ fontSize: 24 });
    ctrl.start();
    const overlay = fakeBody.children.find((c) => c.className === 'ab-captions-overlay');
    expect(overlay?.style.fontSize).toBe('24px');
    ctrl.stop();
  });

  it('position: "top" places overlay at top', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const ctrl = new CaptionsController({ position: 'top' });
    ctrl.start();
    const overlay = fakeBody.children.find((c) => c.className === 'ab-captions-overlay');
    expect(overlay?.style.top).toBe('10%');
    expect(overlay?.style.bottom).toBe('auto');
    ctrl.stop();
  });
});

describe('CaptionsController.configure', () => {
  beforeEach(() => {
    fakeBody.children = [];
    installGlobals();
  });
  afterEach(() => {
    restoreGlobals();
    vi.resetModules();
  });

  it('configure({ fontSize }) updates overlay after start', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const ctrl = new CaptionsController({ fontSize: 18 });
    ctrl.start();
    ctrl.configure({ fontSize: 28 });
    const overlay = fakeBody.children.find((c) => c.className === 'ab-captions-overlay');
    expect(overlay?.style.fontSize).toBe('28px');
    ctrl.stop();
  });

  it('configure({ position: "bottom" }) flips overlay position', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const ctrl = new CaptionsController({ position: 'top' });
    ctrl.start();
    ctrl.configure({ position: 'bottom' });
    const overlay = fakeBody.children.find((c) => c.className === 'ab-captions-overlay');
    expect(overlay?.style.bottom).toBe('15%');
    expect(overlay?.style.top).toBe('auto');
    ctrl.stop();
  });

  it('configure({ language }) calls recognition.stop so lang applies on restart', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const ctrl = new CaptionsController({ language: 'en-US' });
    ctrl.start();
    const stopSpy = lastRecognizer?.stop;
    ctrl.configure({ language: 'es-ES' });
    expect(stopSpy).toHaveBeenCalled();
    expect(lastRecognizer?.lang).toBe('es-ES');
    ctrl.stop();
  });
});

describe('CaptionsController translation hook', () => {
  beforeEach(() => {
    fakeBody.children = [];
    installGlobals();
  });
  afterEach(() => {
    restoreGlobals();
    vi.resetModules();
  });

  it('translate() invoked on final result when targetLanguage ≠ language', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const translate = vi.fn(async (text: string) => `T:${text}`);
    const ctrl = new CaptionsController({
      language: 'en-US',
      targetLanguage: 'hi-IN',
      translate,
    });
    ctrl.start();
    // Simulate a 'result' event with a final result
    const evt = {
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          isFinal: true,
          length: 1,
          0: { transcript: 'hello world', confidence: 0.9 },
        },
      },
    };
    lastRecognizer?.dispatchEvent('result', evt);
    // Allow microtask to flush
    await new Promise((r) => setTimeout(r, 5));
    expect(translate).toHaveBeenCalledWith('hello world', 'en-US', 'hi-IN');
    ctrl.stop();
  });

  it('translate() NOT invoked when targetLanguage === language', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const translate = vi.fn(async (t: string) => t);
    const ctrl = new CaptionsController({
      language: 'en-US',
      targetLanguage: 'en-US',
      translate,
    });
    ctrl.start();
    const evt = {
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: true, length: 1, 0: { transcript: 'hello', confidence: 0.9 } },
      },
    };
    lastRecognizer?.dispatchEvent('result', evt);
    await new Promise((r) => setTimeout(r, 5));
    expect(translate).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it('translate() NOT invoked when targetLanguage is null', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const translate = vi.fn(async (t: string) => t);
    const ctrl = new CaptionsController({
      language: 'en-US',
      targetLanguage: null,
      translate,
    });
    ctrl.start();
    const evt = {
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: true, length: 1, 0: { transcript: 'hello', confidence: 0.9 } },
      },
    };
    lastRecognizer?.dispatchEvent('result', evt);
    await new Promise((r) => setTimeout(r, 5));
    expect(translate).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it('if translate() rejects, original text is kept', async () => {
    const CaptionsController = await importCaptions();
    fakeBody.appendChild(new FakeElement('video'));
    const translate = vi.fn(async () => { throw new Error('net'); });
    const ctrl = new CaptionsController({
      language: 'en-US',
      targetLanguage: 'hi-IN',
      translate,
    });
    ctrl.start();
    const evt = {
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: true, length: 1, 0: { transcript: 'hello', confidence: 0.9 } },
      },
    };
    lastRecognizer?.dispatchEvent('result', evt);
    await new Promise((r) => setTimeout(r, 10));
    // Overlay text still shows original "hello"
    const overlay = fakeBody.children.find((c) => c.className === 'ab-captions-overlay');
    const textSpan = overlay?.children.find((c) => c.className === 'ab-captions-text');
    expect(textSpan?.textContent ?? overlay?.textContent).toContain('hello');
    ctrl.stop();
  });
});
