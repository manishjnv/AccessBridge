// --- Priority 1: Captions + Actions ---
/**
 * Tests for ActionItemsExtractor.
 * Uses a minimal DOM shim since vitest runs in node environment (no jsdom).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { ActionItem } from '../action-items.js';

// ── Minimal DOM shim ─────────────────────────────────────────────────────────

class ElemShim {
  tagName: string;
  textContent: string;
  classList = { contains: (_c: string) => false };
  children: ElemShim[] = [];
  parentElement: ElemShim | null = null;
  nodeType = 1;

  constructor(tag: string, text = '') {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
  }
}

type MutObserverCb = (mutations: Array<{ addedNodes: unknown[] }>) => void;

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  private cb: MutObserverCb;

  constructor(cb: MutObserverCb) {
    this.cb = cb;
    FakeMutationObserver.instances.push(this);
  }

  observe() {}
  disconnect() {
    FakeMutationObserver.instances = FakeMutationObserver.instances.filter(i => i !== this);
  }

  trigger(addedNodes: unknown[]) {
    this.cb([{ addedNodes }]);
  }
}

class FakeBody extends ElemShim {
  constructor() { super('body'); }

  setChildren(items: ElemShim[]) {
    this.children = items;
    items.forEach(c => { c.parentElement = this; });
  }
}

const fakeBody = new FakeBody();

const fakeDocument = {
  body: fakeBody,
  title: 'Test Page',
  createTreeWalker(
    _root: unknown,
    _whatToShow: number,
    filter: { acceptNode: (n: unknown) => number } | null,
  ) {
    const FILTER_REJECT = 2;
    const textNodes: Array<{ nodeType: number; nodeValue: string; parentElement: ElemShim }> = [];
    for (const child of fakeBody.children) {
      if (!child.textContent) continue;
      const n = { nodeType: 3, nodeValue: child.textContent, parentElement: child };
      const result = filter?.acceptNode(n) ?? 1;
      if (result !== FILTER_REJECT && result !== 3) textNodes.push(n);
    }
    let idx = -1;
    return {
      nextNode() {
        idx++;
        return idx < textNodes.length ? textNodes[idx] : null;
      },
    };
  },
};

const fakeLocation = { href: 'https://test.example.com/page' };
const fakeNodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
const fakeNode = { ELEMENT_NODE: 1 };

// ── Install globals ONCE before all tests ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ActionItemsExtractor: new () => {
  scan(): ActionItem[];
  watch(): void;
  stop(): void;
  readonly observer: unknown;
  readonly debounceTimer: unknown;
};

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g['document'] = fakeDocument;
  g['location'] = fakeLocation;
  g['NodeFilter'] = fakeNodeFilter;
  g['MutationObserver'] = FakeMutationObserver;
  g['Node'] = fakeNode;
  g['chrome'] = { runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) } };

  const mod = await import('../action-items.js');
  ActionItemsExtractor = mod.ActionItemsExtractor as unknown as typeof ActionItemsExtractor;
});

beforeEach(() => {
  fakeBody.children = [];
  FakeMutationObserver.instances = [];
});

afterEach(() => {
  FakeMutationObserver.instances = [];
});

// ── Helper ────────────────────────────────────────────────────────────────────

function setChildren(items: Array<[string, string]>) {
  fakeBody.setChildren(items.map(([tag, text]) => new ElemShim(tag, text)));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActionItemsExtractor', () => {
  it('extracts imperative verb at sentence start', () => {
    setChildren([['p', 'Review the quarterly report and prepare summary.']]);
    const ext = new ActionItemsExtractor();
    const items = ext.scan();
    expect(items.length).toBeGreaterThan(0);
    const found = items.find(i => i.text.includes('Review'));
    expect(found).toBeDefined();
  });

  it('extracts [ ] marker', () => {
    setChildren([['p', '[ ] Buy groceries and supplies this week']]);
    const ext = new ActionItemsExtractor();
    const items = ext.scan();
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(i => i.text.includes('[ ]'))).toBe(true);
  });

  it('extracts TODO marker', () => {
    setChildren([['p', 'TODO: fix the login bug in production today']]);
    const ext = new ActionItemsExtractor();
    const items = ext.scan();
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(i => i.text.includes('TODO'))).toBe(true);
  });

  it('detects urgent keyword → high priority', () => {
    setChildren([['p', 'Send the urgent report immediately to the manager.']]);
    const ext = new ActionItemsExtractor();
    const items = ext.scan();
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.priority).toBe('high');
  });

  it('detects deadline → medium priority', () => {
    setChildren([['p', 'Submit the form by next Friday please.']]);
    const ext = new ActionItemsExtractor();
    const items = ext.scan();
    const submits = items.filter(i => i.text.includes('Submit'));
    expect(submits.length).toBeGreaterThan(0);
    expect(submits[0]!.priority).toBe('medium');
    expect(submits[0]!.dueDate).not.toBeNull();
  });

  it('dedupes identical items', () => {
    setChildren([
      ['p', 'Review the contract document carefully today.'],
      ['p', 'Review the contract document carefully today.'],
    ]);
    const ext = new ActionItemsExtractor();
    const items = ext.scan();
    const reviews = items.filter(i => i.text.includes('Review the contract'));
    expect(reviews.length).toBe(1);
  });

  it('caps at 50 items', () => {
    fakeBody.setChildren(
      Array.from({ length: 60 }, (_, i) => {
        const el = new ElemShim('p', `Send email number ${i + 1} to the team member right now today.`);
        el.parentElement = fakeBody;
        return el;
      }),
    );
    const ext = new ActionItemsExtractor();
    const items = ext.scan();
    expect(items.length).toBeLessThanOrEqual(50);
  });

  it('watch debounces rescans', async () => {
    setChildren([['p', 'Review the quarterly report soon.']]);
    const ext = new ActionItemsExtractor();
    const scanSpy = vi.spyOn(ext, 'scan');

    ext.watch();
    expect(scanSpy).toHaveBeenCalledTimes(1);

    // Trigger MutationObserver with a block-level element node
    const obs = FakeMutationObserver.instances[0];
    expect(obs).toBeDefined();
    obs?.trigger([{ nodeType: 1, tagName: 'P', textContent: 'Submit the updated version today.' }]);

    // Wait for debounce (1000ms)
    await new Promise(r => setTimeout(r, 1300));
    expect(scanSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    ext.stop();
  });

  it('stop disconnects observer', () => {
    setChildren([['p', 'Check the report status today.']]);
    const ext = new ActionItemsExtractor();
    ext.watch();
    // Access private fields via bracket notation for test
    expect((ext as unknown as Record<string, unknown>)['observer']).not.toBeNull();
    ext.stop();
    expect((ext as unknown as Record<string, unknown>)['observer']).toBeNull();
    expect((ext as unknown as Record<string, unknown>)['debounceTimer']).toBeNull();
  });

  it('skips script and style text', () => {
    const scriptEl = new ElemShim('script', 'Review the code(); // TODO: fix this thing');
    const styleEl = new ElemShim('style', '.review { color: red; }');
    const normalEl = new ElemShim('p', 'Regular paragraph text without special markers here.');
    fakeBody.setChildren([scriptEl, styleEl, normalEl]);

    const ext = new ActionItemsExtractor();
    const items = ext.scan();
    expect(items.filter(i => i.text.includes('Review the code'))).toHaveLength(0);
    expect(items.filter(i => i.text.includes('.review'))).toHaveLength(0);
  });
});
