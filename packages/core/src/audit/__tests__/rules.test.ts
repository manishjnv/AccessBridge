import { describe, it, expect } from 'vitest';
import {
  AUDIT_RULES,
  parseRgb,
  relativeLuminance,
  contrastRatio,
  buildElementSelector,
  principleForCriterion,
} from '../rules.js';
import type { AuditInput, AuditNode } from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeInput(partial: Partial<AuditInput> = {}): AuditInput {
  return {
    url: 'https://example.com',
    pageTitle: 'Test',
    documentLang: 'en',
    scannedAt: 1700000000000,
    viewport: { w: 1280, h: 800 },
    elements: [],
    headings: [],
    landmarks: [],
    tables: [],
    frames: [],
    forms: [],
    skipLinks: [],
    duplicateIds: [],
    focusOrder: [],
    autoplayMedia: [],
    animatedElements: [],
    totalElements: 0,
    ...partial,
  };
}

function makeNode(partial: Partial<AuditNode> = {}): AuditNode {
  return {
    index: 0,
    tag: 'div',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    ariaLabelledBy: null,
    ariaDescribedBy: null,
    ariaHidden: false,
    ariaLive: null,
    alt: null,
    src: null,
    href: null,
    title: null,
    type: null,
    name: null,
    value: null,
    placeholder: null,
    text: '',
    tabIndex: null,
    autoplay: false,
    muted: false,
    controls: false,
    lang: null,
    hasLabelElement: false,
    hasFieldsetLabel: false,
    parentTag: null,
    bbox: { x: 0, y: 0, w: 100, h: 50 },
    style: {
      color: 'rgb(0, 0, 0)',
      backgroundColor: 'rgb(255, 255, 255)',
      fontSize: 16,
      fontWeight: 400,
      display: 'block',
      visibility: 'visible',
      opacity: 1,
      outlineStyle: 'none',
      outlineWidth: '0px',
    },
    htmlSnippet: '<div></div>',
    ...partial,
  };
}

function findRule(id: string) {
  const rule = AUDIT_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`Rule "${id}" not found`);
  return rule;
}

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe('parseRgb', () => {
  it('parses rgb(r, g, b)', () => {
    expect(parseRgb('rgb(0, 128, 255)')).toEqual([0, 128, 255, 1]);
  });
  it('parses rgba(r, g, b, a)', () => {
    expect(parseRgb('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30, 0.5]);
  });
  it('parses #rrggbb', () => {
    expect(parseRgb('#ff8800')).toEqual([255, 136, 0, 1]);
  });
  it('parses #rgb shorthand', () => {
    expect(parseRgb('#f80')).toEqual([255, 136, 0, 1]);
  });
  it('returns null for unrecognised string', () => {
    expect(parseRgb('transparent')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('black has luminance 0', () => {
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0);
  });
  it('white has luminance 1', () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1);
  });
});

describe('contrastRatio', () => {
  it('black on white is 21:1', () => {
    const ratio = contrastRatio('rgb(0,0,0)', 'rgb(255,255,255)');
    expect(ratio).toBeCloseTo(21, 0);
  });
  it('returns null for unparseable color', () => {
    expect(contrastRatio('transparent', 'rgb(255,255,255)')).toBeNull();
  });
  it('returns null when bg has alpha < 1', () => {
    expect(contrastRatio('rgb(0,0,0)', 'rgba(255,255,255,0.5)')).toBeNull();
  });
});

describe('buildElementSelector', () => {
  it('builds tag#id.class selector', () => {
    const node = makeNode({ tag: 'button', id: 'submit', classes: ['btn', 'primary'] });
    expect(buildElementSelector(node)).toBe('button#submit.btn');
  });
  it('falls back to just tag when no id or class', () => {
    expect(buildElementSelector(makeNode({ tag: 'span' }))).toBe('span');
  });
});

describe('principleForCriterion', () => {
  it('1.x.x → perceivable', () => expect(principleForCriterion('1.1.1')).toBe('perceivable'));
  it('2.x.x → operable', () => expect(principleForCriterion('2.4.3')).toBe('operable'));
  it('3.x.x → understandable', () => expect(principleForCriterion('3.3.2')).toBe('understandable'));
  it('4.x.x → robust', () => expect(principleForCriterion('4.1.1')).toBe('robust'));
});

// ---------------------------------------------------------------------------
// Rule: img-alt
// ---------------------------------------------------------------------------

describe('img-alt', () => {
  const rule = findRule('img-alt');

  it('flags <img> with null alt and no aria-label', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'img', alt: null, index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag <img> with alt=""', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'img', alt: '', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag <img> with aria-label', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'img', alt: null, ariaLabel: 'Logo', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag <img> with role="presentation"', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'img', alt: null, role: 'presentation', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('produces deterministic finding id', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'img', alt: null, index: 5 })],
    });
    const [f] = rule.check(input);
    expect(f.id).toBe('img-alt-5-0');
  });
});

// ---------------------------------------------------------------------------
// Rule: empty-link
// ---------------------------------------------------------------------------

describe('empty-link', () => {
  const rule = findRule('empty-link');

  it('flags <a> with href but no text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: '/page', text: '', index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag <a> with descriptive text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: '/page', text: 'About us', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag <a> with aria-label', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: '/page', text: '', ariaLabel: 'Home', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag <a> without href', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: null, text: '', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: empty-button
// ---------------------------------------------------------------------------

describe('empty-button', () => {
  const rule = findRule('empty-button');

  it('flags <button> with no text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', text: '', index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('flags role=button element with no name', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'div', role: 'button', text: '', index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag <button> with text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', text: 'Submit', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag <button> with aria-label', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', text: '', ariaLabel: 'Close', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: form-label
// ---------------------------------------------------------------------------

describe('form-label', () => {
  const rule = findRule('form-label');

  it('flags <input type="text"> with no label', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'input', type: 'text', hasLabelElement: false, index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag <input type="hidden">', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'input', type: 'hidden', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag input with hasLabelElement=true', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'input', type: 'text', hasLabelElement: true, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('flags <select> with no label', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'select', hasLabelElement: false, index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag input with aria-label', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'input', type: 'email', ariaLabel: 'Email', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: heading-order
// ---------------------------------------------------------------------------

describe('heading-order', () => {
  const rule = findRule('heading-order');

  it('flags skipped heading level (h1 → h3)', () => {
    const input = makeInput({
      elements: [
        makeNode({ tag: 'h1', index: 0 }),
        makeNode({ tag: 'h3', index: 1 }),
      ],
      headings: [
        { nodeIndex: 0, level: 1, text: 'Title' },
        { nodeIndex: 1, level: 3, text: 'Section' },
      ],
    });
    expect(rule.check(input).length).toBeGreaterThan(0);
  });

  it('does not flag sequential headings (h1 → h2 → h3)', () => {
    const input = makeInput({
      elements: [
        makeNode({ tag: 'h1', index: 0 }),
        makeNode({ tag: 'h2', index: 1 }),
        makeNode({ tag: 'h3', index: 2 }),
      ],
      headings: [
        { nodeIndex: 0, level: 1, text: 'Title' },
        { nodeIndex: 1, level: 2, text: 'Subtitle' },
        { nodeIndex: 2, level: 3, text: 'Section' },
      ],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('flags multiple h1 elements', () => {
    const input = makeInput({
      elements: [
        makeNode({ tag: 'h1', index: 0 }),
        makeNode({ tag: 'h1', index: 1 }),
      ],
      headings: [
        { nodeIndex: 0, level: 1, text: 'First' },
        { nodeIndex: 1, level: 1, text: 'Second' },
      ],
    });
    expect(rule.check(input).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: contrast-aa
// ---------------------------------------------------------------------------

describe('contrast-aa', () => {
  const rule = findRule('contrast-aa');

  it('flags text with low contrast ratio (grey on white)', () => {
    // rgb(150,150,150) on white ≈ 3.95:1 which is < 4.5
    const input = makeInput({
      elements: [makeNode({
        tag: 'p', text: 'Hello',
        style: {
          color: 'rgb(150, 150, 150)',
          backgroundColor: 'rgb(255, 255, 255)',
          fontSize: 16, fontWeight: 400,
          display: 'block', visibility: 'visible', opacity: 1,
          outlineStyle: 'none', outlineWidth: '0px',
        },
        index: 0,
      })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag black on white (21:1)', () => {
    const input = makeInput({
      elements: [makeNode({
        tag: 'p', text: 'Hello',
        style: {
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgb(255, 255, 255)',
          fontSize: 16, fontWeight: 400,
          display: 'block', visibility: 'visible', opacity: 1,
          outlineStyle: 'none', outlineWidth: '0px',
        },
        index: 0,
      })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('skips element with opacity < 1', () => {
    const input = makeInput({
      elements: [makeNode({
        tag: 'p', text: 'Hello',
        style: {
          color: 'rgb(150, 150, 150)',
          backgroundColor: 'rgb(255, 255, 255)',
          fontSize: 16, fontWeight: 400,
          display: 'block', visibility: 'visible', opacity: 0.5,
          outlineStyle: 'none', outlineWidth: '0px',
        },
        index: 0,
      })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('uses 3.0 threshold for large text (≥18px)', () => {
    // rgb(120,120,120) on white ≈ 5.74:1 > 3.0 but < 4.5
    const input = makeInput({
      elements: [makeNode({
        tag: 'p', text: 'Large',
        style: {
          color: 'rgb(120, 120, 120)',
          backgroundColor: 'rgb(255, 255, 255)',
          fontSize: 18, fontWeight: 400,
          display: 'block', visibility: 'visible', opacity: 1,
          outlineStyle: 'none', outlineWidth: '0px',
        },
        index: 0,
      })],
    });
    // 5.74 > 3.0, should not flag
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: contrast-aaa
// ---------------------------------------------------------------------------

describe('contrast-aaa', () => {
  const rule = findRule('contrast-aaa');

  it('flags text that meets AA but not AAA', () => {
    // rgb(100,100,100) on white ≈ 7.0:1 — borderline, let's use 110 ≈ 5.9:1 < 7.0
    const input = makeInput({
      elements: [makeNode({
        tag: 'p', text: 'Hello',
        style: {
          color: 'rgb(110, 110, 110)',
          backgroundColor: 'rgb(255, 255, 255)',
          fontSize: 16, fontWeight: 400,
          display: 'block', visibility: 'visible', opacity: 1,
          outlineStyle: 'none', outlineWidth: '0px',
        },
        index: 0,
      })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag very dark text on white (21:1)', () => {
    const input = makeInput({
      elements: [makeNode({
        tag: 'p', text: 'Hello',
        style: {
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgb(255, 255, 255)',
          fontSize: 16, fontWeight: 400,
          display: 'block', visibility: 'visible', opacity: 1,
          outlineStyle: 'none', outlineWidth: '0px',
        },
        index: 0,
      })],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: target-size-aa
// ---------------------------------------------------------------------------

describe('target-size-aa', () => {
  const rule = findRule('target-size-aa');

  it('flags <button> smaller than 24×24', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', bbox: { x: 0, y: 0, w: 20, h: 20 }, index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag <button> exactly 24×24', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', bbox: { x: 0, y: 0, w: 24, h: 24 }, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('skips zero-size elements', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', bbox: { x: 0, y: 0, w: 0, h: 0 }, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('flags <a> smaller than 24 px', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: '#', bbox: { x: 0, y: 0, w: 16, h: 16 }, index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rule: target-size-aaa
// ---------------------------------------------------------------------------

describe('target-size-aaa', () => {
  const rule = findRule('target-size-aaa');

  it('flags <button> smaller than 44×44', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', bbox: { x: 0, y: 0, w: 30, h: 30 }, index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag <button> at 44×44', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', bbox: { x: 0, y: 0, w: 44, h: 44 }, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: document-lang
// ---------------------------------------------------------------------------

describe('document-lang', () => {
  const rule = findRule('document-lang');

  it('flags missing lang', () => {
    expect(rule.check(makeInput({ documentLang: null })).length).toBe(1);
  });

  it('flags empty lang', () => {
    expect(rule.check(makeInput({ documentLang: '' })).length).toBe(1);
  });

  it('does not flag valid lang', () => {
    expect(rule.check(makeInput({ documentLang: 'en' })).length).toBe(0);
  });

  it('finding has nodeIndex null (global)', () => {
    const [f] = rule.check(makeInput({ documentLang: null }));
    expect(f.nodeIndex).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule: duplicate-id
// ---------------------------------------------------------------------------

describe('duplicate-id', () => {
  const rule = findRule('duplicate-id');

  it('produces one finding per duplicate id', () => {
    const input = makeInput({ duplicateIds: ['nav', 'main'] });
    expect(rule.check(input).length).toBe(2);
  });

  it('does not flag when no duplicates', () => {
    expect(rule.check(makeInput({ duplicateIds: [] })).length).toBe(0);
  });

  it('finding message includes the id', () => {
    const [f] = rule.check(makeInput({ duplicateIds: ['hero'] }));
    expect(f.message).toContain('hero');
  });
});

// ---------------------------------------------------------------------------
// Rule: table-headers
// ---------------------------------------------------------------------------

describe('table-headers', () => {
  const rule = findRule('table-headers');

  it('flags multi-cell table without headers', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'table', index: 0 })],
      tables: [{ nodeIndex: 0, hasHeaders: false, hasCaption: false, rowCount: 3, colCount: 3 }],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag table with headers', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'table', index: 0 })],
      tables: [{ nodeIndex: 0, hasHeaders: true, hasCaption: false, rowCount: 3, colCount: 3 }],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag single-row table', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'table', index: 0 })],
      tables: [{ nodeIndex: 0, hasHeaders: false, hasCaption: false, rowCount: 1, colCount: 3 }],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: keyboard-trap
// ---------------------------------------------------------------------------

describe('keyboard-trap', () => {
  const rule = findRule('keyboard-trap');

  it('flags <div> with positive tabindex', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'div', tabIndex: 5, index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag <div> with tabIndex=0', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'div', tabIndex: 0, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag <div> with no tabIndex', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'div', tabIndex: null, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag <button> with tabIndex=1', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', tabIndex: 1, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: autoplay-media
// ---------------------------------------------------------------------------

describe('autoplay-media', () => {
  const rule = findRule('autoplay-media');

  it('flags autoplay video with no controls and unmuted as critical', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'video', autoplay: true, muted: false, controls: false, index: 0 })],
      autoplayMedia: [0],
    });
    const [f] = rule.check(input);
    expect(f.severity).toBe('critical');
  });

  it('flags autoplay muted video as serious', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'video', autoplay: true, muted: true, controls: false, index: 0 })],
      autoplayMedia: [0],
    });
    const [f] = rule.check(input);
    expect(f.severity).toBe('serious');
  });

  it('does not flag elements not in autoplayMedia list', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'video', autoplay: false, index: 0 })],
      autoplayMedia: [],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: flashing-content
// ---------------------------------------------------------------------------

describe('flashing-content', () => {
  const rule = findRule('flashing-content');

  it('flags animated element with "flash" class as critical', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'div', classes: ['flash'], index: 0 })],
      animatedElements: [0],
    });
    const [f] = rule.check(input);
    expect(f.severity).toBe('critical');
  });

  it('flags animated element without danger class as serious', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'div', classes: ['animated'], index: 0 })],
      animatedElements: [0],
    });
    const [f] = rule.check(input);
    expect(f.severity).toBe('serious');
  });

  it('does not flag non-animated elements', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'div', classes: ['flash'], index: 0 })],
      animatedElements: [],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: skip-link
// ---------------------------------------------------------------------------

describe('skip-link', () => {
  const rule = findRule('skip-link');

  it('flags page with landmarks but no skip links', () => {
    const input = makeInput({ skipLinks: [], landmarks: [0] });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag page with skip links', () => {
    const input = makeInput({ skipLinks: [0], landmarks: [1] });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag page with no landmarks (no skip link needed)', () => {
    const input = makeInput({ skipLinks: [], landmarks: [] });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: frame-title
// ---------------------------------------------------------------------------

describe('frame-title', () => {
  const rule = findRule('frame-title');

  it('flags iframe without title', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'iframe', title: null, index: 0 })],
      frames: [{ nodeIndex: 0, title: null, src: 'https://example.com' }],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('flags iframe with empty title', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'iframe', title: '', index: 0 })],
      frames: [{ nodeIndex: 0, title: '', src: 'https://example.com' }],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag iframe with descriptive title', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'iframe', title: 'Map', index: 0 })],
      frames: [{ nodeIndex: 0, title: 'Map', src: 'https://maps.example.com' }],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: focus-order
// ---------------------------------------------------------------------------

describe('focus-order', () => {
  const rule = findRule('focus-order');

  it('flags element with positive tabindex', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', tabIndex: 3, index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag element with tabIndex=0', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', tabIndex: 0, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag element with tabIndex=-1', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', tabIndex: -1, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: link-purpose
// ---------------------------------------------------------------------------

describe('link-purpose', () => {
  const rule = findRule('link-purpose');

  it('flags "click here" link text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: '#', text: 'click here', index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('flags "read more" link text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: '#', text: 'Read More', index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag descriptive link text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: '#', text: 'View our pricing plans', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag vague text when aria-label is present', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', href: '#', text: 'here', ariaLabel: 'Download our report', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule: redundant-title
// ---------------------------------------------------------------------------

describe('redundant-title', () => {
  const rule = findRule('redundant-title');

  it('flags <a> where title duplicates text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', text: 'Contact Us', title: 'Contact Us', index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });

  it('does not flag <a> where title differs from text', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', text: 'Contact', title: 'Opens in new window', index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('does not flag <a> with no title', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'a', text: 'Contact', title: null, index: 0 })],
    });
    expect(rule.check(input).length).toBe(0);
  });

  it('flags <button> where title duplicates text (case-insensitive)', () => {
    const input = makeInput({
      elements: [makeNode({ tag: 'button', text: 'Submit', title: 'submit', index: 0 })],
    });
    expect(rule.check(input).length).toBe(1);
  });
});
