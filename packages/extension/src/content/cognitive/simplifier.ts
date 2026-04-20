/**
 * CognitiveSimplifier — Cognitive accessibility features for AccessBridge.
 *
 * Provides three independent features that can be toggled individually:
 *   1. Focus Mode (spotlight)   – dims everything except the element under the cursor
 *   2. Distraction Shield       – hides ads, popups, modals, cookie banners, etc.
 *   3. Reading Guide            – horizontal highlight bar that follows the mouse
 */

const STYLE_ID_PREFIX = 'ab-cognitive-';
const Z_BASE = 999990;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function injectStyle(id: string, css: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = css;
  return el;
}

function removeStyle(id: string): void {
  document.getElementById(id)?.remove();
}

function removeElement(id: string): void {
  document.getElementById(id)?.remove();
}

// ---------------------------------------------------------------------------
// Focus Mode (Spotlight)
// ---------------------------------------------------------------------------

const FOCUS_STYLE_ID = `${STYLE_ID_PREFIX}focus-style`;
const SPOTLIGHT_ID = `${STYLE_ID_PREFIX}spotlight`;

const FOCUS_BORDER_ID = `${STYLE_ID_PREFIX}focus-border`;

function buildFocusCSS(): string {
  return `
    #${SPOTLIGHT_ID} {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: ${Z_BASE + 5};
      pointer-events: none;
      background: rgba(0, 0, 0, 0.55);
      transition: clip-path 0.4s ease-in-out;
      clip-path: inset(0 0 0 0);
    }
    #${FOCUS_BORDER_ID} {
      position: absolute;
      z-index: ${Z_BASE + 6};
      pointer-events: none;
      border: 3px solid rgba(123, 104, 238, 0.85);
      border-radius: 12px;
      box-shadow: 0 0 30px 6px rgba(123, 104, 238, 0.45),
                  inset 0 0 15px 3px rgba(123, 104, 238, 0.12);
      transition: top 0.4s ease-in-out,
                  left 0.4s ease-in-out,
                  width 0.4s ease-in-out,
                  height 0.4s ease-in-out;
    }
  `;
}

// ---------------------------------------------------------------------------
// Distraction Shield
// ---------------------------------------------------------------------------

const SHIELD_STYLE_ID = `${STYLE_ID_PREFIX}shield-style`;
const SHIELD_COUNTER_ID = `${STYLE_ID_PREFIX}shield-counter`;

const DISTRACTION_SELECTORS: string[] = [
  '[class*="ad-"]',
  '[class*="ad_"]',
  '[class*="ads-"]',
  '[class*="ads_"]',
  '[class*="advert"]',
  '[class*="popup"]',
  '[class*="pop-up"]',
  '[class*="modal"]',
  '[class*="cookie"]',
  '[class*="consent"]',
  '[class*="chat-widget"]',
  '[class*="chatwidget"]',
  '[class*="social-share"]',
  '[class*="social-embed"]',
  '[id*="ad-"]',
  '[id*="ad_"]',
  '[id*="ads-"]',
  '[id*="ads_"]',
  '[id*="advert"]',
  '[id*="cookie"]',
  '[id*="popup"]',
  '[id*="modal"]',
  'iframe[src*="doubleclick"]',
  'iframe[src*="googlesyndication"]',
  'iframe[src*="facebook.com/plugins"]',
  'iframe[src*="platform.twitter"]',
];

function buildShieldCSS(): string {
  const joined = DISTRACTION_SELECTORS.join(',\n    ');
  return `
    ${joined} {
      display: none !important;
      visibility: hidden !important;
    }

    #${SHIELD_COUNTER_ID} {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: ${Z_BASE + 8};
      background: #1a1a2e;
      color: #e2e8f0;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      padding: 8px 14px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      pointer-events: none;
      user-select: none;
    }
  `;
}

// ---------------------------------------------------------------------------
// Reading Guide
// ---------------------------------------------------------------------------

const GUIDE_STYLE_ID = `${STYLE_ID_PREFIX}guide-style`;
const GUIDE_BAR_ID = `${STYLE_ID_PREFIX}guide-bar`;

function buildGuideCSS(): string {
  return `
    #${GUIDE_BAR_ID} {
      position: fixed;
      left: 0;
      width: 100%;
      height: 40px;
      z-index: ${Z_BASE + 3};
      background: rgba(255, 235, 59, 0.18);
      border-top: 2px solid rgba(255, 235, 59, 0.5);
      border-bottom: 2px solid rgba(255, 235, 59, 0.5);
      pointer-events: none;
      transition: top 0.05s linear;
    }
  `;
}

// ---------------------------------------------------------------------------
// CognitiveSimplifier class
// ---------------------------------------------------------------------------

export class CognitiveSimplifier {
  // ---- state flags ----
  private focusActive = false;
  private shieldActive = false;
  private guideActive = false;

  // ---- DOM refs (created lazily) ----
  private spotlightEl: HTMLElement | null = null;
  private focusBorderEl: HTMLElement | null = null;
  private guideBarEl: HTMLElement | null = null;
  private shieldCounterEl: HTMLElement | null = null;

  // ---- bound listeners (so we can remove them) ----
  private readonly handleFocusMove: (e: MouseEvent) => void;
  private readonly handleGuideMove: (e: MouseEvent) => void;

  // ---- focus mode debounce ----
  private focusRafId: number | null = null;
  private lastFocusTarget: HTMLElement | null = null;

  // ---- distraction tracking ----
  private hiddenFixedEls: { el: HTMLElement; prev: string }[] = [];

  constructor() {
    this.handleFocusMove = this.onFocusMouseMove.bind(this);
    this.handleGuideMove = this.onGuideMouseMove.bind(this);
  }

  // =====================================================================
  // Focus Mode
  // =====================================================================

  // SVG elements for focus mode
  private svgOverlay: SVGSVGElement | null = null;
  private svgCutout: SVGRectElement | null = null;
  private svgBorder: SVGRectElement | null = null;

  enableFocusMode(): void {
    if (this.focusActive) return;
    this.focusActive = true;
    console.log('[AccessBridge] Focus Mode ENABLED');

    injectStyle(FOCUS_STYLE_ID, buildFocusCSS());

    // SVG overlay — full screen with a masked rounded-rect cutout
    // This approach gives mathematically perfect rounded corners, zero artifacts
    const ns = 'http://www.w3.org/2000/svg';
    const W = window.innerWidth;
    const H = window.innerHeight;

    const svg = document.createElementNS(ns, 'svg');
    svg.id = SPOTLIGHT_ID;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    Object.assign(svg.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      zIndex: String(Z_BASE + 5),
      pointerEvents: 'none',
    });

    // Mask: white = visible (dim), black = hidden (cutout)
    const defs = document.createElementNS(ns, 'defs');
    const mask = document.createElementNS(ns, 'mask');
    mask.id = 'ab-focus-mask';

    // White full-screen rect = everything is dimmed
    const maskBg = document.createElementNS(ns, 'rect');
    maskBg.setAttribute('width', '100%');
    maskBg.setAttribute('height', '100%');
    maskBg.setAttribute('fill', 'white');

    // Black rounded rect = cutout (this area is NOT dimmed)
    const maskHole = document.createElementNS(ns, 'rect');
    maskHole.setAttribute('x', String(W / 2 - 100));
    maskHole.setAttribute('y', String(H / 2 - 50));
    maskHole.setAttribute('width', '200');
    maskHole.setAttribute('height', '100');
    maskHole.setAttribute('rx', '12');
    maskHole.setAttribute('ry', '12');
    maskHole.setAttribute('fill', 'black');

    mask.appendChild(maskBg);
    mask.appendChild(maskHole);
    defs.appendChild(mask);
    svg.appendChild(defs);

    // Dim layer (uses the mask)
    const dimRect = document.createElementNS(ns, 'rect');
    dimRect.setAttribute('width', '100%');
    dimRect.setAttribute('height', '100%');
    dimRect.setAttribute('fill', '#000');
    dimRect.setAttribute('fill-opacity', '0.6');
    dimRect.setAttribute('mask', 'url(#ab-focus-mask)');
    svg.appendChild(dimRect);

    // Purple border — stroke-alignment: outside by offsetting rect 1.5px outward
    // SVG stroke is centered on path, so we shrink the border rect by half stroke-width
    // to make stroke sit exactly on the cutout edge (outside the clear area)
    const sw = 2;
    const border = document.createElementNS(ns, 'rect');
    border.setAttribute('x', String(W / 2 - 100 - sw / 2));
    border.setAttribute('y', String(H / 2 - 50 - sw / 2));
    border.setAttribute('width', String(200 + sw));
    border.setAttribute('height', String(100 + sw));
    border.setAttribute('rx', '12');
    border.setAttribute('ry', '12');
    border.setAttribute('fill', 'none');
    border.setAttribute('stroke', '#7b68ee');
    border.setAttribute('stroke-opacity', '0.85');
    border.setAttribute('stroke-width', String(sw));
    svg.appendChild(border);

    document.body.appendChild(svg);
    this.svgOverlay = svg;
    this.svgCutout = maskHole;
    this.svgBorder = border;
    this.spotlightEl = svg as unknown as HTMLElement;
    this.focusBorderEl = null;

    // Track target rect for smooth lerp animation
    this.targetRect = { top: 0, left: 0, width: 200, height: 100 };
    this.currentRect = { top: H / 2 - 50, left: W / 2 - 100, width: 200, height: 100 };
    this.startLerpLoop();

    // Resize handler to update SVG viewBox
    window.addEventListener('resize', this.handleResize);
    document.addEventListener('mousemove', this.handleFocusMove, { passive: true });
  }

  private handleResize = (): void => {
    if (this.svgOverlay) {
      const W = window.innerWidth;
      const H = window.innerHeight;
      this.svgOverlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
  };

  disableFocusMode(): void {
    if (!this.focusActive) return;
    this.focusActive = false;

    if (this.focusRafId !== null) {
      cancelAnimationFrame(this.focusRafId);
      this.focusRafId = null;
    }
    if (this.lerpRafId !== null) {
      cancelAnimationFrame(this.lerpRafId);
      this.lerpRafId = null;
    }
    this.lastFocusTarget = null;

    document.removeEventListener('mousemove', this.handleFocusMove);
    window.removeEventListener('resize', this.handleResize);
    removeElement(SPOTLIGHT_ID);
    removeStyle(FOCUS_STYLE_ID);
    this.svgOverlay = null;
    this.svgCutout = null;
    this.svgBorder = null;
    this.spotlightEl = null;
    this.focusBorderEl = null;
  }

  /**
   * Walk up the DOM to find a meaningful content block rather than
   * spotlighting tiny inline elements like <span> or <em>.
   */
  private findFocusBlock(el: HTMLElement): HTMLElement {
    const MIN_SIZE = 30; // track small and large blocks equally
    const BLOCK_TAGS = new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'BLOCKQUOTE',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGURE', 'TABLE',
      'FORM', 'UL', 'OL', 'NAV', 'HEADER', 'FOOTER', 'MAIN',
      'PRE', 'CODE', 'TD', 'TH', 'TR', 'DETAILS', 'SUMMARY',
      'A', 'BUTTON', 'IMG', 'SPAN', 'LABEL', 'INPUT', 'SELECT',
    ]);

    let current: HTMLElement | null = el;
    while (current && current !== document.body) {
      const rect = current.getBoundingClientRect();
      if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE && BLOCK_TAGS.has(current.tagName)) {
        return current;
      }
      current = current.parentElement;
    }

    // Fallback: just use the original element if nothing better found
    return el;
  }

  // Smooth lerp animation state
  private targetRect = { top: 0, left: 0, width: 200, height: 100 };
  private currentRect = { top: 0, left: 0, width: 200, height: 100 };
  private lerpRafId: number | null = null;

  private startLerpLoop(): void {
    const LERP = 0.1; // smoothing factor — lower = smoother/slower
    const tick = () => {
      if (!this.focusActive || !this.svgCutout || !this.svgBorder) return;
      this.lerpRafId = requestAnimationFrame(tick);

      // Interpolate current towards target
      this.currentRect.top += (this.targetRect.top - this.currentRect.top) * LERP;
      this.currentRect.left += (this.targetRect.left - this.currentRect.left) * LERP;
      this.currentRect.width += (this.targetRect.width - this.currentRect.width) * LERP;
      this.currentRect.height += (this.targetRect.height - this.currentRect.height) * LERP;

      const x = this.currentRect.left;
      const y = this.currentRect.top;
      const w = this.currentRect.width;
      const h = this.currentRect.height;
      const sw = 2; // stroke width — border offset

      // Mask cutout — exact content area
      this.svgCutout.setAttribute('x', String(x));
      this.svgCutout.setAttribute('y', String(y));
      this.svgCutout.setAttribute('width', String(w));
      this.svgCutout.setAttribute('height', String(h));

      // Border — expanded by half stroke-width so stroke sits outside cutout
      this.svgBorder.setAttribute('x', String(x - sw / 2));
      this.svgBorder.setAttribute('y', String(y - sw / 2));
      this.svgBorder.setAttribute('width', String(w + sw));
      this.svgBorder.setAttribute('height', String(h + sw));
    };
    this.lerpRafId = requestAnimationFrame(tick);
  }

  private onFocusMouseMove(e: MouseEvent): void {
    if (!this.spotlightEl) return;

    // Use rAF to find target element (throttled to once per frame)
    if (this.focusRafId !== null) return;
    this.focusRafId = requestAnimationFrame(() => {
      this.focusRafId = null;
      if (!this.spotlightEl) return;

      // Hide SVG overlay so elementFromPoint hits actual content
      if (this.svgOverlay) this.svgOverlay.style.display = 'none';
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (this.svgOverlay) this.svgOverlay.style.display = '';

      if (!target) return;

      const block = this.findFocusBlock(target);
      if (block === this.lastFocusTarget) return;
      this.lastFocusTarget = block;

      const rect = block.getBoundingClientRect();
      const pad = 16;

      // Set target — lerp loop will smoothly animate towards it
      this.targetRect.top = rect.top - pad;
      this.targetRect.left = rect.left - pad;
      this.targetRect.width = rect.width + pad * 2;
      this.targetRect.height = rect.height + pad * 2;
    });
  }

  // =====================================================================
  // Distraction Shield
  // =====================================================================

  enableDistractionShield(): void {
    if (this.shieldActive) return;
    this.shieldActive = true;

    injectStyle(SHIELD_STYLE_ID, buildShieldCSS());
    this.hideFixedOverlays();

    const count = this.countHiddenDistractions();

    const counter = document.createElement('div');
    counter.id = SHIELD_COUNTER_ID;
    counter.textContent = `${count} distraction${count !== 1 ? 's' : ''} blocked`;
    document.body.appendChild(counter);
    this.shieldCounterEl = counter;
  }

  disableDistractionShield(): void {
    if (!this.shieldActive) return;
    this.shieldActive = false;

    removeStyle(SHIELD_STYLE_ID);
    removeElement(SHIELD_COUNTER_ID);
    this.shieldCounterEl = null;
    this.restoreFixedOverlays();
  }

  /**
   * Hides `position: fixed` elements that look like overlays
   * (covering a significant portion of the viewport).
   */
  private hideFixedOverlays(): void {
    this.hiddenFixedEls = [];
    const all = document.querySelectorAll<HTMLElement>('*');
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    all.forEach((el) => {
      if (el.id?.startsWith(STYLE_ID_PREFIX)) return; // skip our own UI
      const style = getComputedStyle(el);
      if (style.position !== 'fixed') return;
      const rect = el.getBoundingClientRect();
      const coversWidth = rect.width > vw * 0.5;
      const coversHeight = rect.height > vh * 0.5;
      if (coversWidth && coversHeight) {
        this.hiddenFixedEls.push({ el, prev: el.style.display });
        el.style.setProperty('display', 'none', 'important');
      }
    });
  }

  private restoreFixedOverlays(): void {
    for (const { el, prev } of this.hiddenFixedEls) {
      el.style.display = prev;
    }
    this.hiddenFixedEls = [];
  }

  private countHiddenDistractions(): number {
    let count = 0;

    for (const selector of DISTRACTION_SELECTORS) {
      try {
        count += document.querySelectorAll(selector).length;
      } catch {
        // invalid selector on this page — skip
      }
    }

    count += this.hiddenFixedEls.length;

    return count;
  }

  // =====================================================================
  // Reading Guide
  // =====================================================================

  enableReadingGuide(): void {
    if (this.guideActive) return;
    this.guideActive = true;

    injectStyle(GUIDE_STYLE_ID, buildGuideCSS());

    const bar = document.createElement('div');
    bar.id = GUIDE_BAR_ID;
    bar.style.top = '0px';
    document.body.appendChild(bar);
    this.guideBarEl = bar;

    document.addEventListener('mousemove', this.handleGuideMove, { passive: true });
  }

  disableReadingGuide(): void {
    if (!this.guideActive) return;
    this.guideActive = false;

    document.removeEventListener('mousemove', this.handleGuideMove);
    removeElement(GUIDE_BAR_ID);
    removeStyle(GUIDE_STYLE_ID);
    this.guideBarEl = null;
  }

  private onGuideMouseMove(e: MouseEvent): void {
    if (!this.guideBarEl) return;
    // Centre the bar on the cursor's vertical position
    this.guideBarEl.style.top = `${e.clientY - 20}px`;
  }

  // =====================================================================
  // Aggregate controls
  // =====================================================================

  enableAll(): void {
    this.enableFocusMode();
    this.enableDistractionShield();
    this.enableReadingGuide();
  }

  disableAll(): void {
    this.disableFocusMode();
    this.disableDistractionShield();
    this.disableReadingGuide();
  }

  getActiveFeatures(): string[] {
    const features: string[] = [];
    if (this.focusActive) features.push('focus-mode');
    if (this.shieldActive) features.push('distraction-shield');
    if (this.guideActive) features.push('reading-guide');
    return features;
  }
}
