// Tests for Session 7 extensions to ActionItemsExtractor:
//   - detectContext() hostname matcher
//   - extract(text, context) standalone extractor
//   - confidence scoring + assignee detection
//   - configure({ minConfidence }) live filter
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ActionItem, ActionContext } from '../action-items.js';

// ── Minimal DOM shim (node env) ──────────────────────────────────────────────

class Elem {
  tagName: string;
  textContent: string;
  classList = { contains: (_c: string) => false };
  children: Elem[] = [];
  parentElement: Elem | null = null;
  nodeType = 1;
  constructor(tag: string, text = '') {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
  }
}

class FakeBody extends Elem {
  constructor() { super('body'); }
  set(items: Elem[]) {
    this.children = items;
    items.forEach((c) => { c.parentElement = this; });
  }
}

const body = new FakeBody();

const fakeDoc = {
  body,
  title: 'Test',
  createTreeWalker(_r: unknown, _show: number, f: { acceptNode: (n: unknown) => number } | null) {
    const FILTER_REJECT = 2;
    const nodes: Array<{ nodeType: number; nodeValue: string; parentElement: Elem }> = [];
    for (const ch of body.children) {
      if (!ch.textContent) continue;
      const n = { nodeType: 3, nodeValue: ch.textContent, parentElement: ch };
      const r = f?.acceptNode(n) ?? 1;
      if (r !== FILTER_REJECT && r !== 3) nodes.push(n);
    }
    let idx = -1;
    return {
      nextNode() { idx++; return idx < nodes.length ? nodes[idx] : null; },
    };
  },
};

const fakeLoc = { href: 'https://example.com/page' };

let detectContext: (href?: string) => ActionContext;
let ActionItemsExtractor: new () => {
  scan(opts?: { minConfidence?: number; context?: ActionContext }): ActionItem[];
  extract(text: string, context?: ActionContext): ActionItem[];
  configure(patch: { minConfidence?: number; context?: ActionContext }): void;
  stop(): void;
};

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g['document'] = fakeDoc;
  g['location'] = fakeLoc;
  g['NodeFilter'] = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
  g['MutationObserver'] = class { observe(): void {} disconnect(): void {} };
  g['Node'] = { ELEMENT_NODE: 1 };
  g['chrome'] = { runtime: { sendMessage: () => Promise.resolve() } };

  const mod = await import('../action-items.js');
  detectContext = mod.detectContext;
  ActionItemsExtractor = mod.ActionItemsExtractor as unknown as typeof ActionItemsExtractor;
});

beforeEach(() => { body.children = []; });
afterEach(() => { fakeLoc.href = 'https://example.com/page'; });

// ── detectContext ───────────────────────────────────────────────────────────

describe('detectContext', () => {
  it('Gmail URL → email', () => {
    expect(detectContext('https://mail.google.com/mail/u/0/#inbox')).toBe('email');
  });

  it('Outlook URL → email', () => {
    expect(detectContext('https://outlook.office.com/mail/')).toBe('email');
  });

  it('Google Docs URL → doc', () => {
    expect(detectContext('https://docs.google.com/document/d/abc')).toBe('doc');
  });

  it('Notion URL → doc', () => {
    expect(detectContext('https://www.notion.so/my-workspace/Page-abc')).toBe('doc');
  });

  it('Teams URL → meeting', () => {
    expect(detectContext('https://teams.microsoft.com/_#/conversations/foo')).toBe('meeting');
  });

  it('Zoom URL → meeting', () => {
    expect(detectContext('https://us02web.zoom.us/j/123456789')).toBe('meeting');
  });

  it('Slack URL → meeting', () => {
    expect(detectContext('https://myteam.slack.com/messages')).toBe('meeting');
  });

  it('unknown URL → generic', () => {
    expect(detectContext('https://example.com/hello')).toBe('generic');
  });

  it('no-arg uses globalThis.location.href', () => {
    fakeLoc.href = 'https://mail.google.com/';
    expect(detectContext()).toBe('email');
  });
});

// ── extract(text, context) ──────────────────────────────────────────────────

describe('extract', () => {
  it('finds imperative sentence', () => {
    const ext = new ActionItemsExtractor();
    const items = ext.extract('Send the quarterly report by Friday.');
    expect(items.length).toBe(1);
    expect(items[0]?.text).toMatch(/Send the quarterly/);
    expect((items[0]?.confidence ?? 0)).toBeGreaterThan(0.5);
  });

  it('finds multiple action sentences in one blob', () => {
    const ext = new ActionItemsExtractor();
    const items = ext.extract(
      'Review the contract carefully today. Submit the form by Monday. Call the vendor tomorrow.',
    );
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it('context field propagated to items', () => {
    const ext = new ActionItemsExtractor();
    const items = ext.extract('Please send the memo by EOD.', 'meeting');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.context).toBe('meeting');
  });

  it('@mention assignee captured', () => {
    const ext = new ActionItemsExtractor();
    const items = ext.extract('@jane please review this PR by tomorrow.');
    expect(items.length).toBeGreaterThan(0);
    const found = items.find((i) => i.assignee === '@jane');
    expect(found).toBeDefined();
  });

  it('Name-to-verb assignee captured', () => {
    const ext = new ActionItemsExtractor();
    // "by EOD" matches the deadline regex with a word boundary; "Bob" is not
    // an imperative verb, so it exercises the Name-to-Verb branch.
    const items = ext.extract('Bob to send the update by EOD.');
    expect(items.length).toBeGreaterThan(0);
    const found = items.find((i) => i.assignee === 'Bob');
    expect(found).toBeDefined();
  });

  it('results sorted by confidence descending', () => {
    const ext = new ActionItemsExtractor();
    const items = ext.extract(
      'Review the doc. TODO: urgent fix right now today. Please call the vendor by Friday.',
    );
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]?.confidence ?? 0).toBeGreaterThanOrEqual(items[i]?.confidence ?? 0);
    }
  });

  it('no action signals → empty', () => {
    const ext = new ActionItemsExtractor();
    const items = ext.extract('The weather is nice. Lunch was good.');
    expect(items).toEqual([]);
  });

  it('dedupes identical candidates', () => {
    const ext = new ActionItemsExtractor();
    const items = ext.extract(
      'Review the contract today. Review the contract today. Review the contract today.',
    );
    const matches = items.filter((i) => i.text.includes('Review the contract'));
    expect(matches.length).toBe(1);
  });

  it('all items carry a confidence number in [0,1]', () => {
    const ext = new ActionItemsExtractor();
    const items = ext.extract('Send the report by Friday. TODO: fix this. Call the vendor.');
    for (const item of items) {
      expect(typeof item.confidence).toBe('number');
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ── configure({ minConfidence }) filter ─────────────────────────────────────

describe('configure minConfidence', () => {
  it('scan respects minConfidence via options argument', () => {
    body.set([
      new Elem('p', 'Review the report today.'),          // imperative + urgency → high conf
      new Elem('p', 'We should consider the plan.'),       // no match
    ]);
    const ext = new ActionItemsExtractor();
    const strict = ext.scan({ minConfidence: 0.95 });
    const loose = ext.scan({ minConfidence: 0 });
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });

  it('configure() persists options for subsequent watch-triggered scans', () => {
    const ext = new ActionItemsExtractor();
    ext.configure({ minConfidence: 0.99 });
    body.set([new Elem('p', 'Send the update.')]);
    // scan() with no args picks up the configured minConfidence
    const items = ext.scan();
    // Very high threshold — should filter out most items
    expect(items.every((i) => (i.confidence ?? 0) >= 0.99)).toBe(true);
  });
});
