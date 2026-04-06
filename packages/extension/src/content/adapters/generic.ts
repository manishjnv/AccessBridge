/**
 * Generic fallback adapter that works on any web page.
 */

import type { Adaptation, BehaviorSignal } from '@accessbridge/core/types';
import { AdaptationType, SignalType } from '@accessbridge/core/types';
import { BaseAdapter } from './base.js';

export class GenericAdapter extends BaseAdapter {
  detect(): boolean {
    return true; // Always matches as fallback
  }

  apply(adaptation: Adaptation): void {
    this.trackAdaptation(adaptation);

    switch (adaptation.type) {
      case AdaptationType.FOCUS_MODE: {
        this.addBodyClass('a11y-focus-visible');
        // Dim non-main content
        this.injectStyle(
          'a11y-generic-focus',
          `
          aside, nav:not([aria-label="main"]), footer,
          [role="complementary"], [role="banner"] ~ *:not(main):not([role="main"]) {
            opacity: 0.3 !important;
            transition: opacity 0.3s !important;
          }
          aside:hover, nav:hover, footer:hover,
          [role="complementary"]:hover {
            opacity: 1 !important;
          }
        `,
        );
        break;
      }
      case AdaptationType.CLICK_TARGET_ENLARGE: {
        this.addBodyClass('a11y-smart-targets');
        break;
      }
      case AdaptationType.LAYOUT_SIMPLIFY: {
        this.injectStyle(
          'a11y-generic-simplify',
          `
          aside, [role="complementary"],
          [class*="sidebar"], [class*="Sidebar"],
          [class*="ad-"], [class*="Ad-"],
          [id*="sidebar"], [id*="ad-"] {
            display: none !important;
          }
          main, [role="main"], article, .content, #content {
            max-width: 800px !important;
            margin: 0 auto !important;
          }
        `,
        );
        break;
      }
      default:
        break;
    }
  }

  revert(adaptationId: string): void {
    const adaptation = this.appliedAdaptations.get(adaptationId);
    if (!adaptation) return;

    switch (adaptation.type) {
      case AdaptationType.FOCUS_MODE:
        this.removeBodyClass('a11y-focus-visible');
        this.removeStyle('a11y-generic-focus');
        break;
      case AdaptationType.CLICK_TARGET_ENLARGE:
        this.removeBodyClass('a11y-smart-targets');
        break;
      case AdaptationType.LAYOUT_SIMPLIFY:
        this.removeStyle('a11y-generic-simplify');
        break;
    }

    this.untrackAdaptation(adaptationId);
  }

  collectSignals(): BehaviorSignal[] {
    const signals: BehaviorSignal[] = [];
    const now = Date.now();

    // Check page zoom level
    const zoom = window.devicePixelRatio;
    if (zoom > 1.25) {
      signals.push({
        type: SignalType.ZOOM_EVENTS,
        value: zoom,
        timestamp: now,
        normalized: Math.min((zoom - 1) / 2, 1),
      });
    }

    // Check if user has OS-level reduced motion preference
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      signals.push({
        type: SignalType.HESITATION,
        value: 1,
        timestamp: now,
        normalized: 0.5,
      });
    }

    return signals;
  }
}
