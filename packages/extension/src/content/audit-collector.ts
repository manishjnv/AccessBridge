import type {
  AuditInput,
  AuditNode,
  TableSummary,
  HeadingInfo,
  FrameInfo,
  ComputedStyleSummary,
} from '@accessbridge/core/audit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_ELEMENTS = 5000;

const LANDMARK_TAGS = new Set(['main', 'nav', 'header', 'footer', 'aside', 'section']);
const LANDMARK_ROLES = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const FOCUSABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
const MEDIA_TAGS = new Set(['audio', 'video', 'source']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getAttr(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  return v !== null && v !== '' ? v : null;
}

function getAttrOrNull(el: Element, name: string): string | null {
  return el.getAttribute(name);
}

function parseNum(val: string, fallback: number): number {
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

function buildStyleSummary(cs: CSSStyleDeclaration): ComputedStyleSummary {
  return {
    color: cs.color,
    backgroundColor: cs.backgroundColor,
    fontSize: parseNum(cs.fontSize, 16),
    fontWeight: parseNum(cs.fontWeight, 400),
    display: cs.display,
    visibility: cs.visibility,
    opacity: parseNum(cs.opacity, 1),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
  };
}

function sanitizeSnippet(raw: string): string {
  const snippet = raw.slice(0, 200);
  return snippet.replace(/data:image\/[^"');\s]*/g, '[data-uri-redacted]');
}

function buildSelector(el: Element, tag: string): string {
  if (el.id) return `#${el.id}`;
  const classes = Array.from(el.classList).slice(0, 3);
  const cls = classes.length ? '.' + classes.join('.') : '';
  return `${tag}${cls}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export function collectAuditInput(): AuditInput {
  const allElements = document.documentElement.querySelectorAll('*');
  const totalElements = allElements.length;
  const collectCount = Math.min(totalElements, MAX_ELEMENTS);

  // Pre-index label[for] → id map
  const labelForIds = new Map<string, true>();
  document.querySelectorAll('label[for]').forEach((lbl) => {
    const forId = (lbl as HTMLLabelElement).htmlFor;
    if (forId) labelForIds.set(forId, true);
  });

  // Pre-index elements with id for duplicate detection
  const idCount = new Map<string, number>();

  const elements: AuditNode[] = [];
  const headings: HeadingInfo[] = [];
  const landmarks: number[] = [];
  const tables: TableSummary[] = [];
  const frames: FrameInfo[] = [];
  const forms: number[] = [];
  const autoplayMedia: number[] = [];
  const animatedElements: number[] = [];

  // For skip-link detection we need to track focusable order up to first 3
  const focusableIndices: { index: number; tabIdx: number; natural: number }[] = [];
  const candidateSkipLinks: number[] = [];

  allElements.forEach((el, natural) => {
    if (natural >= collectCount) {
      // Still count ids for duplicate detection
      const elId = el.getAttribute('id');
      if (elId) idCount.set(elId, (idCount.get(elId) ?? 0) + 1);
      return;
    }

    const index = natural;
    const tag = el.tagName.toLowerCase();
    const elId = el.getAttribute('id') || null;
    const classes = Array.from(el.classList);
    const role = getAttrOrNull(el, 'role');
    const ariaLabel = getAttrOrNull(el, 'aria-label');
    const ariaLabelledBy = getAttrOrNull(el, 'aria-labelledby');
    const ariaDescribedBy = getAttrOrNull(el, 'aria-describedby');
    const ariaHiddenAttr = el.getAttribute('aria-hidden');
    const ariaHidden = ariaHiddenAttr === 'true';
    const ariaLive = getAttrOrNull(el, 'aria-live');
    const alt = getAttrOrNull(el, 'alt');
    const src = getAttrOrNull(el, 'src');
    const href = getAttrOrNull(el, 'href');
    const title = getAttrOrNull(el, 'title');
    const type = getAttrOrNull(el, 'type');
    const name = getAttrOrNull(el, 'name');
    const value = getAttrOrNull(el, 'value');
    const placeholder = getAttrOrNull(el, 'placeholder');
    const lang = getAttrOrNull(el, 'lang');

    const tabIndexAttr = el.getAttribute('tabindex');
    const tabIndex = tabIndexAttr !== null ? parseInt(tabIndexAttr, 10) : null;

    const autoplay = el.hasAttribute('autoplay');
    const muted = el.hasAttribute('muted');
    const controls = el.hasAttribute('controls');

    // Label and fieldset detection
    const hasLabelElement = elId ? labelForIds.has(elId) : false;
    const hasFieldsetLabel = !!el.closest('fieldset > legend') || !!el.closest('fieldset[aria-labelledby]') || !!el.closest('fieldset[aria-label]');

    const parentTag = el.parentElement ? el.parentElement.tagName.toLowerCase() : null;

    // BBox
    const rect = el.getBoundingClientRect();
    const bbox = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };

    // Computed style
    const cs = window.getComputedStyle(el);
    const style = buildStyleSummary(cs);

    // HTML snippet
    const htmlSnippet = sanitizeSnippet(el.outerHTML);

    // Text content (direct, trimmed)
    const text = (el.textContent ?? '').trim().slice(0, 500);

    const node: AuditNode = {
      index, tag, id: elId, classes, role,
      ariaLabel, ariaLabelledBy, ariaDescribedBy,
      ariaHidden, ariaLive, alt, src, href, title,
      type, name, value, placeholder, text, tabIndex,
      autoplay, muted, controls, lang,
      hasLabelElement, hasFieldsetLabel, parentTag,
      bbox, style, htmlSnippet,
    };

    elements.push(node);

    // ID count
    if (elId) idCount.set(elId, (idCount.get(elId) ?? 0) + 1);

    // Landmarks
    const isLandmarkTag = LANDMARK_TAGS.has(tag);
    const isLandmarkRole = role !== null && LANDMARK_ROLES.has(role);
    if (isLandmarkTag || isLandmarkRole) landmarks.push(index);

    // Headings
    if (HEADING_TAGS.has(tag)) {
      const level = parseInt(tag[1], 10);
      headings.push({ nodeIndex: index, level, text: (el.textContent ?? '').trim().slice(0, 200) });
    }

    // Tables
    if (tag === 'table') {
      const rows = el.querySelectorAll('tr');
      const hasHeaders = el.querySelector('th, [role="columnheader"], [role="rowheader"]') !== null;
      const hasCaption = el.querySelector('caption') !== null;
      const rowCount = rows.length;
      let colCount = 0;
      if (rows.length > 0) {
        colCount = rows[0].querySelectorAll('td, th').length;
      }
      tables.push({ nodeIndex: index, hasHeaders, hasCaption, rowCount, colCount });
    }

    // Frames
    if (tag === 'iframe' || tag === 'frame') {
      frames.push({
        nodeIndex: index,
        title: getAttrOrNull(el, 'title'),
        src: getAttrOrNull(el, 'src'),
      });
    }

    // Forms
    if (tag === 'form') forms.push(index);

    // Autoplay media
    if (MEDIA_TAGS.has(tag) && autoplay) autoplayMedia.push(index);

    // Animated elements
    const animName = cs.animationName;
    const classStr = el.className;
    const classNames = typeof classStr === 'string' ? classStr : '';
    if ((animName && animName !== 'none') || /flash|blink|strobe|pulse|shake/i.test(classNames)) {
      animatedElements.push(index);
    }

    // Focusable tracking
    const isFocusableTag = FOCUSABLE_TAGS.has(tag) || (tag === 'a' && href !== null);
    const hasPositiveTabIndex = tabIndex !== null && tabIndex >= 0;
    if (isFocusableTag || hasPositiveTabIndex) {
      focusableIndices.push({ index, tabIdx: tabIndex ?? 0, natural });
    }

    // Skip link candidates: <a href="#...">
    if (tag === 'a' && href && href.startsWith('#')) {
      candidateSkipLinks.push(index);
    }
  });

  // Duplicate IDs
  const duplicateIds: string[] = [];
  idCount.forEach((count, id) => {
    if (count > 1) duplicateIds.push(id);
  });

  // Focus order: explicit positive tabIndex first (ascending), then natural order for 0/native
  const focusOrder = focusableIndices
    .slice()
    .sort((a, b) => {
      const aPos = a.tabIdx > 0;
      const bPos = b.tabIdx > 0;
      if (aPos && bPos) return a.tabIdx - b.tabIdx;
      if (aPos) return -1;
      if (bPos) return 1;
      return a.natural - b.natural;
    })
    .map((f) => f.index);

  // Skip links: anchors with href starting # that appear within first 3 focusable elements in document order
  const first3FocusableNatural = new Set(focusableIndices.slice(0, 3).map((f) => f.index));
  const skipLinks = candidateSkipLinks.filter((idx) => first3FocusableNatural.has(idx));

  return {
    url: location.href,
    pageTitle: document.title,
    documentLang: document.documentElement.lang || null,
    scannedAt: Date.now(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    elements,
    headings,
    landmarks,
    tables,
    frames,
    forms,
    skipLinks,
    duplicateIds,
    focusOrder,
    autoplayMedia,
    animatedElements,
    totalElements,
  };
}
