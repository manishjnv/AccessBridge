/**
 * Sensory Adapter – applies visual/sensory accessibility adaptations
 * using CSS injection, CSS custom properties, and SVG filters.
 */

import type { Adaptation } from '@accessbridge/core/types';
import { AdaptationType } from '@accessbridge/core/types';

const STYLE_ID = 'a11y-sensory-styles';
const SVG_FILTERS_ID = 'a11y-svg-filters';

export class SensoryAdapter {
  private styleEl: HTMLStyleElement | null = null;
  private svgEl: HTMLElement | null = null;
  private activeAdaptations = new Set<string>();

  constructor() {
    this.ensureStyleElement();
    this.injectSvgFilters();
  }

  // ---------- Public API ----------

  applyAdaptation(adaptation: Adaptation): void {
    this.activeAdaptations.add(adaptation.id);

    switch (adaptation.type) {
      case AdaptationType.FONT_SCALE:
        this.applyFontScale(adaptation.value as number);
        break;
      case AdaptationType.CONTRAST:
        this.applyContrast(adaptation.value as number);
        break;
      case AdaptationType.COLOR_CORRECTION:
        this.applyColorCorrection(adaptation.value as string);
        break;
      case AdaptationType.LINE_HEIGHT:
        this.applyLineHeight(adaptation.value as number);
        break;
      case AdaptationType.LETTER_SPACING:
        this.applyLetterSpacing(adaptation.value as number);
        break;
      case AdaptationType.CURSOR_SIZE:
        this.applyCursorSize(adaptation.value as number);
        break;
      case AdaptationType.REDUCED_MOTION:
        this.applyReducedMotion(adaptation.value as boolean);
        break;
      case AdaptationType.READING_MODE:
        this.applyReadingMode(adaptation.value as boolean);
        break;
    }
  }

  applyFontScale(scale: number): void {
    const clamped = Math.max(0.5, Math.min(3.0, scale));
    // Direct inline zoom — most reliable across all sites
    document.body.style.zoom = String(clamped);
    console.log(`[AccessBridge] Font scale applied: ${clamped}`);
  }

  applyContrast(level: number): void {
    const clamped = Math.max(0.5, Math.min(3.0, level));
    this.currentContrast = clamped;
    this.rebuildFilter();
    console.log(`[AccessBridge] Contrast applied: ${clamped}`);
  }

  applyColorCorrection(mode: string): void {
    this.currentColorMode = mode;
    this.rebuildFilter();
    console.log(`[AccessBridge] Color correction applied: ${mode}`);
  }

  /** Combine contrast + color correction into a single filter string */
  private currentContrast = 1.0;
  private currentColorMode = 'none';

  private rebuildFilter(): void {
    const parts: string[] = [];
    if (this.currentContrast !== 1.0) {
      parts.push(`contrast(${this.currentContrast})`);
    }
    const colorFilterMap: Record<string, string> = {
      protanopia: 'url(#a11y-protanopia)',
      deuteranopia: 'url(#a11y-deuteranopia)',
      tritanopia: 'url(#a11y-tritanopia)',
    };
    const colorFilter = colorFilterMap[this.currentColorMode];
    if (colorFilter) {
      parts.push(colorFilter);
    }
    document.body.style.filter = parts.length > 0 ? parts.join(' ') : '';
  }

  applyLineHeight(height: number): void {
    const clamped = Math.max(1.0, Math.min(4.0, height));
    // Inject a style rule that overrides all elements
    this.injectRule('a11y-line-height', `* { line-height: ${clamped} !important; }`);
    console.log(`[AccessBridge] Line height applied: ${clamped}`);
  }

  applyLetterSpacing(spacing: number): void {
    const clamped = Math.max(0, Math.min(10, spacing));
    this.injectRule('a11y-letter-spacing', `* { letter-spacing: ${clamped}px !important; }`);
    console.log(`[AccessBridge] Letter spacing applied: ${clamped}px`);
  }

  applyCursorSize(size: number): void {
    if (size > 1.5) {
      this.injectRule('a11y-cursor', 'body { cursor: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'32\'%3E%3Ccircle cx=\'16\' cy=\'16\' r=\'14\' fill=\'%237b68ee\' opacity=\'0.7\'/%3E%3C/svg%3E") 16 16, auto !important; }');
    } else {
      this.removeRule('a11y-cursor');
    }
    console.log(`[AccessBridge] Cursor size applied: ${size}`);
  }

  applyReducedMotion(enabled: boolean): void {
    if (enabled) {
      this.injectRule('a11y-reduced-motion',
        '*, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }');
    } else {
      this.removeRule('a11y-reduced-motion');
    }
    console.log(`[AccessBridge] Reduced motion: ${enabled}`);
  }

  applyHighContrast(enabled: boolean): void {
    if (enabled) {
      this.injectRule('a11y-high-contrast',
        'body { filter: contrast(1.5) !important; } ' +
        '* { border-color: currentColor !important; outline-color: currentColor !important; } ' +
        'a, a * { color: #ffff00 !important; } ' +
        'button, [role="button"] { border: 2px solid currentColor !important; }');
    } else {
      this.removeRule('a11y-high-contrast');
    }
    console.log(`[AccessBridge] High contrast: ${enabled}`);
  }

  applyReadingMode(enabled: boolean): void {
    if (enabled) {
      const main = this.getMainContent();
      if (main && main instanceof HTMLElement) {
        main.style.maxWidth = '65ch';
        main.style.marginLeft = 'auto';
        main.style.marginRight = 'auto';
        main.style.lineHeight = '1.8';
        main.style.wordSpacing = '0.16em';
      }
    } else {
      const main = this.getMainContent();
      if (main && main instanceof HTMLElement) {
        main.style.removeProperty('max-width');
        main.style.removeProperty('margin-left');
        main.style.removeProperty('margin-right');
        main.style.removeProperty('line-height');
        main.style.removeProperty('word-spacing');
      }
    }
    console.log(`[AccessBridge] Reading mode: ${enabled}`);
  }

  revertAll(): void {
    // Reset inline styles
    document.body.style.zoom = '';
    document.body.style.filter = '';

    // Reset filter state
    this.currentContrast = 1.0;
    this.currentColorMode = 'none';

    // Remove all injected style rules
    const rules = ['a11y-line-height', 'a11y-letter-spacing', 'a11y-cursor',
      'a11y-reduced-motion', 'a11y-high-contrast'];
    rules.forEach(r => this.removeRule(r));

    // Revert reading mode
    this.applyReadingMode(false);

    this.activeAdaptations.clear();
    console.log('[AccessBridge] All sensory adaptations reverted');
  }

  // ---------- Private helpers ----------

  private injectRule(id: string, css: string): void {
    this.removeRule(id);
    const style = document.createElement('style');
    style.id = `a11y-rule-${id}`;
    style.textContent = css;
    document.head.appendChild(style);
  }

  private removeRule(id: string): void {
    document.getElementById(`a11y-rule-${id}`)?.remove();
  }

  private ensureStyleElement(): void {
    this.styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!this.styleEl) {
      this.styleEl = document.createElement('style');
      this.styleEl.id = STYLE_ID;
      document.head.appendChild(this.styleEl);
    }
  }

  private getMainContent(): Element | null {
    return (
      document.querySelector('main') ??
      document.querySelector('[role="main"]') ??
      document.querySelector('article') ??
      document.querySelector('#content') ??
      document.body
    );
  }

  /**
   * Inject SVG filter definitions for colour blindness correction.
   * Uses clinically-derived colour transformation matrices.
   */
  private injectSvgFilters(): void {
    if (document.getElementById(SVG_FILTERS_ID)) return;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = SVG_FILTERS_ID;
    svg.setAttribute('class', 'a11y-svg-filters');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `
      <!-- Protanopia (red-blind) correction -->
      <filter id="a11y-protanopia">
        <feColorMatrix type="matrix" values="
          0.567, 0.433, 0,     0, 0
          0.558, 0.442, 0,     0, 0
          0,     0.242, 0.758, 0, 0
          0,     0,     0,     1, 0
        "/>
      </filter>

      <!-- Deuteranopia (green-blind) correction -->
      <filter id="a11y-deuteranopia">
        <feColorMatrix type="matrix" values="
          0.625, 0.375, 0,     0, 0
          0.7,   0.3,   0,     0, 0
          0,     0.3,   0.7,   0, 0
          0,     0,     0,     1, 0
        "/>
      </filter>

      <!-- Tritanopia (blue-blind) correction -->
      <filter id="a11y-tritanopia">
        <feColorMatrix type="matrix" values="
          0.95, 0.05,  0,     0, 0
          0,    0.433, 0.567, 0, 0
          0,    0.475, 0.525, 0, 0
          0,    0,     0,     1, 0
        "/>
      </filter>
    `;

    document.body.appendChild(svg);
    this.svgEl = svg as unknown as HTMLElement;
  }
}
