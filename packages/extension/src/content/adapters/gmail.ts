/**
 * Gmail-specific adapter.
 * Knows about Gmail's DOM structure for targeted accessibility improvements.
 */

import type { Adaptation, BehaviorSignal } from '@accessbridge/core/types';
import { AdaptationType, SignalType } from '@accessbridge/core/types';
import { BaseAdapter } from './base.js';

export class GmailAdapter extends BaseAdapter {
  detect(): boolean {
    return window.location.hostname === 'mail.google.com';
  }

  apply(adaptation: Adaptation): void {
    this.trackAdaptation(adaptation);

    switch (adaptation.type) {
      case AdaptationType.FOCUS_MODE: {
        // Hide Gmail side panels and chat to reduce distractions
        this.injectStyle(
          'a11y-gmail-focus',
          `
          .aeN, .aj3, .aDl,
          [role="complementary"],
          .bAw .brC-brG { display: none !important; }
          .nH.bkK { max-width: 100% !important; }
        `,
        );
        break;
      }
      case AdaptationType.CLICK_TARGET_ENLARGE: {
        // Enlarge Gmail's tiny action buttons
        this.injectStyle(
          'a11y-gmail-targets',
          `
          .T-I, .asa,
          [role="button"],
          .aim .TN {
            min-height: 40px !important;
            min-width: 40px !important;
            padding: 8px !important;
          }
          .xY .xS { padding: 8px 16px !important; }
        `,
        );
        break;
      }
      case AdaptationType.LAYOUT_SIMPLIFY: {
        // Simplify Gmail layout
        this.injectStyle(
          'a11y-gmail-simplify',
          `
          .btA, .aDg, .aDj { display: none !important; }
          .zA { padding: 12px 16px !important; }
        `,
        );
        break;
      }
      default:
        // Delegate to generic handling
        break;
    }
  }

  revert(adaptationId: string): void {
    const adaptation = this.appliedAdaptations.get(adaptationId);
    if (!adaptation) return;

    switch (adaptation.type) {
      case AdaptationType.FOCUS_MODE:
        this.removeStyle('a11y-gmail-focus');
        break;
      case AdaptationType.CLICK_TARGET_ENLARGE:
        this.removeStyle('a11y-gmail-targets');
        break;
      case AdaptationType.LAYOUT_SIMPLIFY:
        this.removeStyle('a11y-gmail-simplify');
        break;
    }

    this.untrackAdaptation(adaptationId);
  }

  collectSignals(): BehaviorSignal[] {
    const signals: BehaviorSignal[] = [];
    const now = Date.now();

    // Gmail-specific: check if compose window is open and measure typing area size
    const composeBody = document.querySelector('.Am.Al.editable');
    if (composeBody) {
      const rect = composeBody.getBoundingClientRect();
      if (rect.width < 300) {
        signals.push({
          type: SignalType.DWELL_TIME,
          value: rect.width,
          timestamp: now,
          normalized: Math.max(0, 1 - rect.width / 600),
        });
      }
    }

    // Check unread count for cognitive load estimation
    const unreadBadges = this.queryAll('.bsU');
    if (unreadBadges.length > 0) {
      const totalUnread = unreadBadges.reduce((sum, el) => {
        const n = parseInt(el.textContent ?? '0', 10);
        return sum + (isNaN(n) ? 0 : n);
      }, 0);

      if (totalUnread > 50) {
        signals.push({
          type: SignalType.ERROR_RATE,
          value: totalUnread,
          timestamp: now,
          normalized: Math.min(totalUnread / 200, 1),
        });
      }
    }

    return signals;
  }
}
