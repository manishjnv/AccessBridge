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
      color: #e0e0e0;
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

  enableFocusMode(): void {
    if (this.focusActive) return;
    this.focusActive = true;
    console.log('[AccessBridge] Focus Mode ENABLED');

    injectStyle(FOCUS_STYLE_ID, buildFocusCSS());

    // Spotlight overlay — starts as a small transparent box with huge box-shadow to dim surroundings
    const overlay = document.createElement('div');
    overlay.id = SPOTLIGHT_ID;
    overlay.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      width: 200px;
      height: 100px;
      z-index: ${Z_BASE + 5};
      pointer-events: none;
      background: transparent;
      border-radius: 12px;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
      transition: top 0.35s ease, left 0.35s ease, width 0.35s ease, height 0.35s ease;
    `;
    document.body.appendChild(overlay);
    this.spotlightEl = overlay;

    // Purple border element that follows the focused block — fixed position to match spotlight
    const border = document.createElement('div');
    border.id = FOCUS_BORDER_ID;
    border.style.cssText = `
      position: fixed;
      z-index: ${Z_BASE + 6};
      pointer-events: none;
      border: 3px solid rgba(123, 104, 238, 0.85);
      border-radius: 10px;
      box-shadow: 0 0 24px 4px rgba(123, 104, 238, 0.4);
      transition: top 0.35s ease, left 0.35s ease, width 0.35s ease, height 0.35s ease;
      top: 50%;
      left: 50%;
      width: 200px;
      height: 100px;
    `;
    document.body.appendChild(border);
    this.focusBorderEl = border;

    document.addEventListener('mousemove', this.handleFocusMove, { passive: true });
  }

  disableFocusMode(): void {
    if (!this.focusActive) return;
    this.focusActive = false;

    if (this.focusRafId !== null) {
      cancelAnimationFrame(this.focusRafId);
      this.focusRafId = null;
    }
    this.lastFocusTarget = null;

    document.removeEventListener('mousemove', this.handleFocusMove);
    removeElement(SPOTLIGHT_ID);
    removeElement(FOCUS_BORDER_ID);
    removeStyle(FOCUS_STYLE_ID);
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

  private onFocusMouseMove(e: MouseEvent): void {
    if (!this.spotlightEl) return;

    if (this.focusRafId !== null) return;
    this.focusRafId = requestAnimationFrame(() => {
      this.focusRafId = null;
      if (!this.spotlightEl) return;

      // Temporarily hide overlay so elementFromPoint hits actual content
      this.spotlightEl.style.display = 'none';
      if (this.focusBorderEl) this.focusBorderEl.style.display = 'none';

      let target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;

      this.spotlightEl.style.display = '';
      if (this.focusBorderEl) this.focusBorderEl.style.display = '';

      if (!target) return;

      // Walk up to a meaningful content block
      target = this.findFocusBlock(target);

      // Skip if same target
      if (target === this.lastFocusTarget) return;
      this.lastFocusTarget = target;

      const rect = target.getBoundingClientRect();
      const pad = 10;
      const r = 10;

      // Spotlight: fixed position, viewport coords
      const top = rect.top - pad;
      const left = rect.left - pad;
      const w = rect.width + pad * 2;
      const h = rect.height + pad * 2;

      this.spotlightEl.style.top = `${top}px`;
      this.spotlightEl.style.left = `${left}px`;
      this.spotlightEl.style.width = `${w}px`;
      this.spotlightEl.style.height = `${h}px`;
      this.spotlightEl.style.borderRadius = `${r}px`;

      // Border: also fixed position to match spotlight
      if (this.focusBorderEl) {
        this.focusBorderEl.style.top = `${top}px`;
        this.focusBorderEl.style.left = `${left}px`;
        this.focusBorderEl.style.width = `${w}px`;
        this.focusBorderEl.style.height = `${h}px`;
      }
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
