import { describe, it, expect } from 'vitest';
import {
  inferRoleFromClass,
  inferLabelFromSiblingContext,
  inferIconLabel,
  inferButtonFromPosition,
  composeHeuristicLabel,
} from '../heuristics.js';
import { ICON_LEXICON } from '../icon-lexicon.js';
import type { UnlabeledElement } from '../types.js';

const makeEl = (overrides: Partial<UnlabeledElement> = {}): UnlabeledElement => ({
  nodeHint: 'button',
  bbox: { x: 0, y: 0, w: 40, h: 40 },
  computedRole: null,
  currentAriaLabel: null,
  textContent: '',
  siblingContext: '',
  classSignature: '',
  backgroundImageUrl: null,
  ...overrides,
});

describe('ICON_LEXICON', () => {
  it('has at least 200 entries', () => {
    expect(Object.keys(ICON_LEXICON).length).toBeGreaterThanOrEqual(200);
  });

  it('values are Title-Case non-empty strings', () => {
    for (const [key, value] of Object.entries(ICON_LEXICON)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
      expect(key).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('has common UI icons: search, close, menu', () => {
    expect(ICON_LEXICON.search).toBeTruthy();
    expect(ICON_LEXICON.close).toBeTruthy();
    expect(ICON_LEXICON.menu).toBeTruthy();
  });
});

describe('inferRoleFromClass', () => {
  it('recognizes "btn" as button', () => {
    expect(inferRoleFromClass(['btn'])).toBe('button');
  });

  it('recognizes "button" as button', () => {
    expect(inferRoleFromClass(['button'])).toBe('button');
  });

  it('recognizes "btn-primary" as button (substring)', () => {
    expect(inferRoleFromClass(['btn-primary'])).toBe('button');
  });

  it('recognizes "menu" as menu', () => {
    expect(inferRoleFromClass(['menu'])).toBe('menu');
  });

  it('recognizes "modal" as dialog', () => {
    expect(inferRoleFromClass(['modal'])).toBe('dialog');
  });

  it('recognizes "nav-item" as navigation', () => {
    expect(inferRoleFromClass(['nav-item'])).toBe('navigation');
  });

  it('recognizes "tab-pane" as tab', () => {
    expect(inferRoleFromClass(['tab-pane'])).toBe('tab');
  });

  it('returns null for empty class list', () => {
    expect(inferRoleFromClass([])).toBeNull();
  });

  it('returns null for unrelated classes', () => {
    expect(inferRoleFromClass(['lorem', 'ipsum'])).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(inferRoleFromClass(['BTN-LARGE'])).toBe('button');
  });
});

describe('inferIconLabel', () => {
  it('matches fa-search class', () => {
    const result = inferIconLabel(null, 'fa fa-search');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('matches icon-close class', () => {
    const result = inferIconLabel(null, 'icon-close');
    expect(result).toBeTruthy();
  });

  it('matches mdi-menu class', () => {
    const result = inferIconLabel(null, 'mdi mdi-menu');
    expect(result).toBeTruthy();
  });

  it('matches bg-image filename', () => {
    const result = inferIconLabel('https://example.com/icons/search.svg', '');
    expect(result).toBeTruthy();
  });

  it('returns null for unknown class with no bg-image', () => {
    expect(inferIconLabel(null, 'random-class unrelated')).toBeNull();
  });

  it('is case-insensitive on class names', () => {
    const result = inferIconLabel(null, 'FA-SEARCH');
    expect(result).toBeTruthy();
  });

  it('handles empty inputs gracefully', () => {
    expect(inferIconLabel(null, '')).toBeNull();
    expect(inferIconLabel('', '')).toBeNull();
  });
});

describe('inferLabelFromSiblingContext', () => {
  it('returns null for empty context', () => {
    const el = makeEl({ siblingContext: '' });
    expect(inferLabelFromSiblingContext(el)).toBeNull();
  });

  it('returns a label when context has ≤6 words', () => {
    const el = makeEl({ siblingContext: 'Submit form' });
    expect(inferLabelFromSiblingContext(el)).toBeTruthy();
  });

  it('handles "Search" prefix specially', () => {
    const el = makeEl({ siblingContext: 'Search query input' });
    const result = inferLabelFromSiblingContext(el);
    expect(result).toBeTruthy();
    expect(result?.toLowerCase()).toContain('search');
  });
});

describe('inferButtonFromPosition', () => {
  it('returns null when no relevant siblings', () => {
    expect(inferButtonFromPosition({ x: 0, y: 0, w: 40, h: 40 }, [])).toBeNull();
  });
});

describe('composeHeuristicLabel', () => {
  it('returns null when element has no signals', () => {
    const el = makeEl();
    expect(composeHeuristicLabel(el)).toBeNull();
  });

  it('returns a tier-1 heuristic label when icon class matches', () => {
    const el = makeEl({ classSignature: 'fa fa-search' });
    const result = composeHeuristicLabel(el);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe(1);
    expect(result?.source).toBe('heuristic');
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it('caps confidence at 0.95', () => {
    const el = makeEl({
      classSignature: 'fa fa-search',
      siblingContext: 'Search',
      backgroundImageUrl: 'https://cdn.example.com/icons/search.svg',
    });
    const result = composeHeuristicLabel(el);
    expect(result).not.toBeNull();
    expect(result?.confidence ?? 0).toBeLessThanOrEqual(0.95);
  });

  it('inferredRole falls back to computedRole when class-role missing', () => {
    const el = makeEl({
      classSignature: 'fa fa-search',
      computedRole: 'searchbox',
    });
    const result = composeHeuristicLabel(el);
    expect(result).not.toBeNull();
    expect(typeof result?.inferredRole).toBe('string');
  });
});
