/**
 * Outlook Web adapter.
 * Targets Outlook's DOM structure for accessibility adaptations.
 */

import type { Adaptation, BehaviorSignal } from '@accessbridge/core/types';
import { AdaptationType, SignalType } from '@accessbridge/core/types';
import { BaseAdapter } from './base.js';

export class OutlookAdapter extends BaseAdapter {
  detect(): boolean {
    const { hostname } = window.location;
    return hostname.includes('outlook.live.com') || hostname.includes('outlook.office.com');
  }

  apply(adaptation: Adaptation): void {
    this.trackAdaptation(adaptation);

    switch (adaptation.type) {
      case AdaptationType.FOCUS_MODE: {
        // Hide Outlook's navigation panes and tips
        this.injectStyle(
          'a11y-outlook-focus',
          `
          [data-app-section="NavigationPane"],
          [data-app-section="TipsPane"],
          .ms-Panel { display: none !important; }
          [data-app-section="MainModule"] { margin-left: 0 !important; }
        `,
        );
        break;
      }
      case AdaptationType.CLICK_TARGET_ENLARGE: {
        this.injectStyle(
          'a11y-outlook-targets',
          `
          button, [role="button"], [role="menuitem"],
          .ms-Button {
            min-height: 40px !important;
            min-width: 40px !important;
          }
          .customScrollBar [role="option"] {
            padding: 8px 16px !important;
          }
        `,
        );
        break;
      }
      case AdaptationType.LAYOUT_SIMPLIFY: {
        this.injectStyle(
          'a11y-outlook-simplify',
          `
          [data-app-section="TopBarRegion"] .ms-FocusZone > div:not(:first-child) {
            display: none !important;
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
        this.removeStyle('a11y-outlook-focus');
        break;
      case AdaptationType.CLICK_TARGET_ENLARGE:
        this.removeStyle('a11y-outlook-targets');
        break;
      case AdaptationType.LAYOUT_SIMPLIFY:
        this.removeStyle('a11y-outlook-simplify');
        break;
    }

    this.untrackAdaptation(adaptationId);
  }

  collectSignals(): BehaviorSignal[] {
    const signals: BehaviorSignal[] = [];
    const now = Date.now();

    // Check reading pane size for potential readability issues
    const readingPane = document.querySelector('[data-app-section="ConversationContainer"]');
    if (readingPane) {
      const rect = readingPane.getBoundingClientRect();
      if (rect.width < 400) {
        signals.push({
          type: SignalType.READING_SPEED,
          value: rect.width,
          timestamp: now,
          normalized: Math.max(0, 1 - rect.width / 800),
        });
      }
    }

    return signals;
  }
}
