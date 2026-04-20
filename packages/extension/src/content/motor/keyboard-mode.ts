/**
 * KeyboardOnlyMode – enhanced keyboard navigation for motor-impaired users
 * who cannot use a mouse.
 *
 * Features:
 * 1. Skip links (main content, nav, footer)
 * 2. Enhanced focus indicator (thick, high-contrast ring)
 * 3. Tab order optimizer (adds tabindex to clickable elements missing it)
 * 4. Keyboard shortcuts overlay (? or Shift+/)
 * 5. Arrow key navigation between groups of links/buttons
 * 6. Escape to deselect (blur current element)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CSS_PREFIX = 'ab-kbd-';

const CSS = {
  SKIP_NAV: `${CSS_PREFIX}skip-nav`,
  SKIP_LINK: `${CSS_PREFIX}skip-link`,
  FOCUS_STYLE: `${CSS_PREFIX}focus-style`,
  OVERLAY: `${CSS_PREFIX}overlay`,
  OVERLAY_BACKDROP: `${CSS_PREFIX}overlay-backdrop`,
  OVERLAY_TITLE: `${CSS_PREFIX}overlay-title`,
  OVERLAY_SECTION: `${CSS_PREFIX}overlay-section`,
  OVERLAY_KEY: `${CSS_PREFIX}overlay-key`,
  OVERLAY_CLOSE: `${CSS_PREFIX}overlay-close`,
  TAB_FIXED: `${CSS_PREFIX}tab-fixed`,
  ACTIVE_GROUP: `${CSS_PREFIX}active-group`,
} as const;

/** Interactive element selectors that should naturally be tabbable. */
const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"]';

/** Elements that act as clickable but often lack tabindex. */
const CLICKABLE_NO_TAB_SELECTOR =
  'div[onclick], span[onclick], div[role="button"]:not([tabindex]), span[role="button"]:not([tabindex]), div[role="link"]:not([tabindex]), span[role="link"]:not([tabindex]), [data-click]:not([tabindex]), [data-action]:not([tabindex])';

/** Grouping roles for arrow-key navigation. */
const GROUP_ROLES = ['toolbar', 'menubar', 'tablist', 'listbox', 'radiogroup'];

// ---------------------------------------------------------------------------
// KeyboardOnlyMode
// ---------------------------------------------------------------------------

export class KeyboardOnlyMode {
  private active = false;

  // DOM references for cleanup
  private skipNavEl: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private overlayBackdrop: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;

  /** Elements we added tabindex to — so we can revert. */
  private tabFixedEls: Set<Element> = new Set();

  /** MutationObserver watching for new clickable elements. */
  private mutationObserver: MutationObserver | null = null;

  // Bound event handlers
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onFocusIn: (e: FocusEvent) => void;

  constructor() {
    this.onKeyDown = this.handleKeyDown.bind(this);
    this.onFocusIn = this.handleFocusIn.bind(this);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  start(): void {
    if (this.active) return;
    this.active = true;

    this.injectStyle();
    this.createSkipLinks();
    this.fixTabOrder();
    this.observeDOM();

    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('focusin', this.onFocusIn, true);

    // Add a class to <html> so CSS can activate the enhanced focus ring
    document.documentElement.classList.add(CSS.FOCUS_STYLE);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;

    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('focusin', this.onFocusIn, true);

    this.removeSkipLinks();
    this.removeOverlay();
    this.revertTabOrder();
    this.removeStyle();
    this.stopObserving();

    document.documentElement.classList.remove(CSS.FOCUS_STYLE);
  }

  // -----------------------------------------------------------------------
  // Skip Links
  // -----------------------------------------------------------------------

  private createSkipLinks(): void {
    if (this.skipNavEl) return;

    const nav = document.createElement('div');
    nav.id = `${CSS_PREFIX}skip-nav-container`;
    nav.className = CSS.SKIP_NAV;
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Skip links');

    const targets: { label: string; selector: string }[] = [
      { label: 'Skip to main content', selector: 'main, [role="main"], #main, #content, .main-content, article' },
      { label: 'Skip to navigation', selector: 'nav, [role="navigation"]' },
      { label: 'Skip to footer', selector: 'footer, [role="contentinfo"]' },
    ];

    for (const { label, selector } of targets) {
      const link = document.createElement('a');
      link.className = CSS.SKIP_LINK;
      link.href = '#';
      link.textContent = label;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.querySelector(selector);
        if (target) {
          // Make it focusable if it is not
          if (!target.hasAttribute('tabindex')) {
            target.setAttribute('tabindex', '-1');
          }
          (target as HTMLElement).focus();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      nav.appendChild(link);
    }

    // Insert as the very first child of <body>
    document.body.insertBefore(nav, document.body.firstChild);
    this.skipNavEl = nav;
  }

  private removeSkipLinks(): void {
    this.skipNavEl?.remove();
    this.skipNavEl = null;
  }

  // -----------------------------------------------------------------------
  // Tab Order Optimizer
  // -----------------------------------------------------------------------

  private fixTabOrder(): void {
    const els = document.querySelectorAll(CLICKABLE_NO_TAB_SELECTOR);
    for (const el of els) {
      if (!el.hasAttribute('tabindex')) {
        el.setAttribute('tabindex', '0');
        el.classList.add(CSS.TAB_FIXED);
        this.tabFixedEls.add(el);
      }
    }

    // Also find elements with click handlers via addEventListener
    // (we can't detect those directly, but look for common patterns)
    const clickableDivs = document.querySelectorAll(
      'div[class*="btn"]:not([tabindex]), div[class*="button"]:not([tabindex]), span[class*="btn"]:not([tabindex]), span[class*="button"]:not([tabindex])',
    );
    for (const el of clickableDivs) {
      if (
        !el.hasAttribute('tabindex') &&
        !el.closest('button') &&
        !el.closest('a')
      ) {
        el.setAttribute('tabindex', '0');
        el.classList.add(CSS.TAB_FIXED);
        this.tabFixedEls.add(el);
      }
    }
  }

  private revertTabOrder(): void {
    for (const el of this.tabFixedEls) {
      el.removeAttribute('tabindex');
      el.classList.remove(CSS.TAB_FIXED);
    }
    this.tabFixedEls.clear();
  }

  // -----------------------------------------------------------------------
  // DOM Observer (for dynamically added content)
  // -----------------------------------------------------------------------

  private observeDOM(): void {
    this.mutationObserver = new MutationObserver((mutations) => {
      let hasNew = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          hasNew = true;
          break;
        }
      }
      if (hasNew) this.fixTabOrder();
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private stopObserving(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
  }

  // -----------------------------------------------------------------------
  // Keyboard Event Handler
  // -----------------------------------------------------------------------

  private handleKeyDown(e: KeyboardEvent): void {
    // Ignore events inside text inputs (unless Escape)
    const tag = (e.target as HTMLElement)?.tagName;
    const isInput =
      tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;

    // --- Escape to deselect ---
    if (e.key === 'Escape') {
      if (this.overlayEl) {
        this.removeOverlay();
        e.preventDefault();
        return;
      }
      if (document.activeElement && document.activeElement !== document.body) {
        (document.activeElement as HTMLElement).blur();
        e.preventDefault();
        return;
      }
    }

    // Don't intercept typing in inputs for the rest
    if (isInput && e.key !== 'Escape') return;

    // --- Shortcuts overlay: ? or Shift+/ ---
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      e.preventDefault();
      this.toggleOverlay();
      return;
    }

    // --- Arrow key navigation in groups ---
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      const handled = this.handleArrowNav(e);
      if (handled) {
        e.preventDefault();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Focus tracking (for arrow key groups)
  // -----------------------------------------------------------------------

  private handleFocusIn(_e: FocusEvent): void {
    // Clear previous active group highlight
    const prev = document.querySelectorAll(`.${CSS.ACTIVE_GROUP}`);
    for (const el of prev) el.classList.remove(CSS.ACTIVE_GROUP);

    // If the focused element is in a group, highlight the group
    const focused = document.activeElement as HTMLElement;
    if (!focused) return;
    const group = this.findParentGroup(focused);
    if (group) {
      group.classList.add(CSS.ACTIVE_GROUP);
    }
  }

  // -----------------------------------------------------------------------
  // Arrow Key Navigation
  // -----------------------------------------------------------------------

  private handleArrowNav(e: KeyboardEvent): boolean {
    const focused = document.activeElement as HTMLElement;
    if (!focused) return false;

    // Find if the focused element is inside a navigable group
    const group = this.findParentGroup(focused);
    if (!group) return false;

    const items = Array.from(
      group.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR + ', [tabindex="0"]'),
    ).filter((el) => !el.hidden && el.offsetParent !== null);

    if (items.length < 2) return false;

    const currentIndex = items.indexOf(focused);
    if (currentIndex === -1) return false;

    const isVertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
    const isForward = e.key === 'ArrowDown' || e.key === 'ArrowRight';

    let nextIndex: number;
    if (isForward) {
      nextIndex = (currentIndex + 1) % items.length;
    } else {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    }

    items[nextIndex].focus();
    return true;
  }

  private findParentGroup(el: HTMLElement): HTMLElement | null {
    // Check for ARIA group roles
    for (const role of GROUP_ROLES) {
      const group = el.closest(`[role="${role}"]`) as HTMLElement | null;
      if (group) return group;
    }

    // Also treat <nav>, <ul> with links, <ol> with links as groups
    const nav = el.closest('nav') as HTMLElement | null;
    if (nav) return nav;

    // Check for list containers with multiple interactive children
    const list = el.closest('ul, ol') as HTMLElement | null;
    if (list) {
      const interactiveCount = list.querySelectorAll(INTERACTIVE_SELECTOR).length;
      if (interactiveCount >= 2) return list;
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Shortcuts Overlay
  // -----------------------------------------------------------------------

  private toggleOverlay(): void {
    if (this.overlayEl) {
      this.removeOverlay();
    } else {
      this.showOverlay();
    }
  }

  private showOverlay(): void {
    if (this.overlayEl) return;

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = CSS.OVERLAY_BACKDROP;
    backdrop.addEventListener('click', () => this.removeOverlay());

    // Panel
    const panel = document.createElement('div');
    panel.className = CSS.OVERLAY;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Keyboard shortcuts');

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.className = CSS.OVERLAY_TITLE;
    titleBar.innerHTML = `
      <span>Keyboard Shortcuts</span>
      <button class="${CSS.OVERLAY_CLOSE}" aria-label="Close shortcuts overlay">&times;</button>
    `;
    titleBar.querySelector('button')?.addEventListener('click', () => this.removeOverlay());
    panel.appendChild(titleBar);

    // Shortcut sections
    const sections: { heading: string; shortcuts: [string, string][] }[] = [
      {
        heading: 'AccessBridge',
        shortcuts: [
          ['?', 'Show / hide this shortcuts panel'],
          ['Escape', 'Close overlay or unfocus element'],
          ['Tab', 'Move to next interactive element'],
          ['Shift + Tab', 'Move to previous interactive element'],
          ['Arrow keys', 'Navigate within toolbars, menus, tab lists'],
          ['Enter / Space', 'Activate focused element'],
        ],
      },
      {
        heading: 'Common Page Shortcuts',
        shortcuts: [
          ['/', 'Focus search (on many sites)'],
          ['Home / End', 'Scroll to top / bottom'],
          ['Page Up / Down', 'Scroll by page'],
          ['Ctrl + F', 'Find on page'],
          ['Ctrl + L', 'Focus address bar'],
          ['Ctrl + T', 'New tab'],
          ['Ctrl + W', 'Close tab'],
          ['Ctrl + Tab', 'Next tab'],
          ['Ctrl + Shift + Tab', 'Previous tab'],
        ],
      },
    ];

    const content = document.createElement('div');
    content.style.cssText = 'padding: 12px 20px 20px; overflow-y: auto; max-height: 60vh;';

    for (const section of sections) {
      const heading = document.createElement('h3');
      heading.className = CSS.OVERLAY_SECTION;
      heading.textContent = section.heading;
      content.appendChild(heading);

      const list = document.createElement('dl');
      list.style.cssText = 'margin: 0 0 16px; display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; align-items: center;';

      for (const [key, desc] of section.shortcuts) {
        const dt = document.createElement('dt');
        dt.style.cssText = 'text-align: right;';
        // Split combined keys (e.g. "Ctrl + F") into separate <kbd> elements
        const keys = key.split(/\s*\+\s*/);
        dt.innerHTML = keys.map((k) => `<kbd class="${CSS.OVERLAY_KEY}">${k}</kbd>`).join(' + ');

        const dd = document.createElement('dd');
        dd.style.cssText = 'margin: 0; color: #94a3b8; font-size: 13px;';
        dd.textContent = desc;

        list.appendChild(dt);
        list.appendChild(dd);
      }
      content.appendChild(list);
    }

    panel.appendChild(content);

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    this.overlayBackdrop = backdrop;
    this.overlayEl = panel;

    // Focus the close button
    const closeBtn = panel.querySelector('button');
    if (closeBtn) closeBtn.focus();
  }

  private removeOverlay(): void {
    this.overlayBackdrop?.remove();
    this.overlayBackdrop = null;
    this.overlayEl?.remove();
    this.overlayEl = null;
  }

  // -----------------------------------------------------------------------
  // Dynamic Style Injection
  // -----------------------------------------------------------------------

  private injectStyle(): void {
    if (this.styleEl) return;

    const style = document.createElement('style');
    style.id = `${CSS_PREFIX}dynamic-styles`;
    style.textContent = `
      /* Injected dynamically by KeyboardOnlyMode — cleaned up on stop() */
    `;
    document.head.appendChild(style);
    this.styleEl = style;
  }

  private removeStyle(): void {
    this.styleEl?.remove();
    this.styleEl = null;
  }
}
