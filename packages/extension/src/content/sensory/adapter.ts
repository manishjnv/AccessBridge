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
    document.documentElement.style.setProperty('--a11y-font-scale', String(clamped));
    document.body.classList.add('a11y-font-scaled', 'a11y-transition');
  }

  applyContrast(level: number): void {
    const clamped = Math.max(0.5, Math.min(3.0, level));
    document.documentElement.style.setProperty('--a11y-contrast', String(clamped));
    document.body.classList.add('a11y-contrast', 'a11y-transition');
  }

  applyColorCorrection(mode: string): void {
    // Remove any existing color correction
    document.body.style.removeProperty('filter');

    if (mode === 'none') return;

    const filterMap: Record<string, string> = {
      protanopia: 'url(#a11y-protanopia)',
      deuteranopia: 'url(#a11y-deuteranopia)',
      tritanopia: 'url(#a11y-tritanopia)',
    };

    const filterUrl = filterMap[mode];
    if (filterUrl) {
      document.body.style.filter = filterUrl;
    }
  }

  applyLineHeight(height: number): void {
    const clamped = Math.max(1.0, Math.min(4.0, height));
    document.documentElement.style.setProperty('--a11y-line-height', String(clamped));
    document.body.classList.add('a11y-line-height', 'a11y-transition');
  }

  applyLetterSpacing(spacing: number): void {
    const clamped = Math.max(0, Math.min(10, spacing));
    document.documentElement.style.setProperty('--a11y-letter-spacing', `${clamped}px`);
    document.body.classList.add('a11y-letter-spacing', 'a11y-transition');
  }

  applyCursorSize(size: number): void {
    if (size > 1.5) {
      document.body.classList.add('a11y-cursor-large');
    } else {
      document.body.classList.remove('a11y-cursor-large');
    }
  }

  applyReducedMotion(enabled: boolean): void {
    if (enabled) {
      document.body.classList.add('a11y-reduced-motion');
    } else {
      document.body.classList.remove('a11y-reduced-motion');
    }
  }

  applyReadingMode(enabled: boolean): void {
    const main = this.getMainContent();
    if (enabled) {
      main?.classList.add('a11y-reading-mode');
      document.body.classList.add('a11y-transition');
    } else {
      main?.classList.remove('a11y-reading-mode');
    }
  }

  revertAll(): void {
    // Remove all CSS classes
    const classesToRemove = [
      'a11y-font-scaled',
      'a11y-contrast',
      'a11y-line-height',
      'a11y-letter-spacing',
      'a11y-cursor-large',
      'a11y-reduced-motion',
      'a11y-transition',
      'a11y-focus-visible',
      'a11y-smart-targets',
      'a11y-high-contrast',
    ];
    classesToRemove.forEach((c) => document.body.classList.remove(c));

    // Remove reading mode from main content
    this.getMainContent()?.classList.remove('a11y-reading-mode');

    // Reset CSS custom properties
    const varsToReset = [
      '--a11y-font-scale',
      '--a11y-contrast',
      '--a11y-line-height',
      '--a11y-letter-spacing',
      '--a11y-cursor-size',
    ];
    varsToReset.forEach((v) => document.documentElement.style.removeProperty(v));

    // Remove color correction filter
    document.body.style.removeProperty('filter');

    this.activeAdaptations.clear();
  }

  // ---------- Private helpers ----------

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
