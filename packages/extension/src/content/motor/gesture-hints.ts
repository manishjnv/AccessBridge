import type { GestureBinding, GestureType } from '@accessbridge/core/gestures';
import { getActionById } from '@accessbridge/core/gestures';

const GESTURE_LABELS: Record<GestureType, { label: string; icon: string }> = {
  'swipe-left': { label: 'Swipe Left', icon: 'M18 12H6 M10 8l-4 4 4 4' },
  'swipe-right': { label: 'Swipe Right', icon: 'M6 12h12 M14 8l4 4-4 4' },
  'swipe-up': { label: 'Swipe Up', icon: 'M12 18V6 M8 10l4-4 4 4' },
  'swipe-down': { label: 'Swipe Down', icon: 'M12 6v12 M8 14l4 4 4-4' },
  'circle-cw': { label: 'Circle CW', icon: 'M12 4a8 8 0 1 0 7.5 5.3 M19.5 4v5.5h-5.5' },
  'circle-ccw': { label: 'Circle CCW', icon: 'M12 4a8 8 0 1 1 -7.5 5.3 M4.5 4v5.5h5.5' },
  'zigzag': { label: 'Zigzag', icon: 'M4 12l4-4 4 4 4-4 4 4' },
  'two-finger-tap': { label: '2-Finger Tap', icon: 'M8 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M16 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4' },
  'three-finger-tap': { label: '3-Finger Tap', icon: 'M6 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M12 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M18 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4' },
  'double-tap': { label: 'Double Tap', icon: 'M12 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M12 14a2 2 0 1 1 0 4 2 2 0 0 1 0-4' },
  'triple-tap': { label: 'Triple Tap', icon: 'M12 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3 M12 11a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3 M12 16a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3' },
  'long-press': { label: 'Long Press', icon: 'M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4 M12 4v2 M12 18v2 M4 12h2 M18 12h2' },
  'pinch-in': { label: 'Pinch In', icon: 'M6 6l5 5 M18 6l-5 5 M6 18l5-5 M18 18l-5-5' },
  'pinch-out': { label: 'Pinch Out', icon: 'M4 4l4 4 M20 4l-4 4 M4 20l4-4 M20 20l-4-4' },
  'two-finger-swipe-left': { label: '2-Finger Left', icon: 'M18 9H6 M10 5l-4 4 4 4 M18 15H6 M10 11l-4 4 4 4' },
  'two-finger-swipe-right': { label: '2-Finger Right', icon: 'M6 9h12 M14 5l4 4-4 4 M6 15h12 M14 11l4 4-4 4' },
};

function svg(path: string, cls: string): SVGSVGElement {
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('viewBox', '0 0 24 24');
  svgEl.setAttribute('class', cls);
  svgEl.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  svgEl.appendChild(p);
  return svgEl;
}

export class GestureHintOverlay {
  private indicator: HTMLDivElement | null = null;
  private hideTimer: number | null = null;
  private helpOverlay: HTMLDivElement | null = null;
  private helpKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  show(gestureType: GestureType, actionName: string, _tone: 'success' | 'warn' = 'success'): void {
    const meta = GESTURE_LABELS[gestureType] ?? { label: gestureType, icon: '' };
    if (!this.indicator) {
      this.indicator = document.createElement('div');
      this.indicator.className = 'a11y-gesture-indicator';
      this.indicator.setAttribute('role', 'status');
      this.indicator.setAttribute('aria-live', 'polite');
      document.body.appendChild(this.indicator);
    }
    this.indicator.textContent = '';
    if (meta.icon) {
      this.indicator.appendChild(svg(meta.icon, 'a11y-gesture-indicator-icon'));
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'a11y-gesture-indicator-name';
    nameEl.textContent = meta.label;
    this.indicator.appendChild(nameEl);
    const actionEl = document.createElement('span');
    actionEl.className = 'a11y-gesture-indicator-action';
    actionEl.textContent = actionName;
    this.indicator.appendChild(actionEl);

    // Double-raf nudge for smooth slide-in after DOM insertion.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.indicator?.classList.add('visible');
      });
    });

    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), 1500);
  }

  hide(): void {
    if (!this.indicator) return;
    this.indicator.classList.remove('visible');
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  showHelp(bindings: GestureBinding[]): void {
    if (this.helpOverlay) {
      this.hideHelp();
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'a11y-gesture-help-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Gesture shortcuts');

    const panel = document.createElement('div');
    panel.className = 'a11y-gesture-help-panel';

    const title = document.createElement('h2');
    title.className = 'a11y-gesture-help-title';
    title.textContent = 'Gesture Shortcuts';
    panel.appendChild(title);

    const hint = document.createElement('p');
    hint.className = 'a11y-gesture-help-hint';
    hint.textContent = 'Press ? or Escape to close. Customize in the popup Motor tab.';
    panel.appendChild(hint);

    const grid = document.createElement('div');
    grid.className = 'a11y-gesture-help-grid';
    for (const b of bindings) {
      if (!b.enabled) continue;
      const meta = GESTURE_LABELS[b.gesture] ?? { label: b.gesture, icon: '' };
      const action = getActionById(b.actionId);
      const row = document.createElement('div');
      row.className = 'a11y-gesture-help-item';
      if (meta.icon) row.appendChild(svg(meta.icon, 'a11y-gesture-help-item-icon'));
      const text = document.createElement('div');
      text.className = 'a11y-gesture-help-item-text';
      const g = document.createElement('span');
      g.className = 'a11y-gesture-help-item-gesture';
      g.textContent = meta.label;
      const a = document.createElement('span');
      a.className = 'a11y-gesture-help-item-action';
      a.textContent = action?.name ?? b.actionId;
      text.appendChild(g);
      text.appendChild(a);
      row.appendChild(text);
      grid.appendChild(row);
    }
    panel.appendChild(grid);

    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hideHelp();
    });

    this.helpKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        this.hideHelp();
      }
    };
    document.addEventListener('keydown', this.helpKeyHandler, true);

    document.body.appendChild(overlay);
    this.helpOverlay = overlay;
  }

  hideHelp(): void {
    if (this.helpOverlay && this.helpOverlay.parentNode) {
      this.helpOverlay.parentNode.removeChild(this.helpOverlay);
    }
    this.helpOverlay = null;
    if (this.helpKeyHandler) {
      document.removeEventListener('keydown', this.helpKeyHandler, true);
      this.helpKeyHandler = null;
    }
  }

  destroy(): void {
    this.hide();
    this.hideHelp();
    if (this.indicator && this.indicator.parentNode) {
      this.indicator.parentNode.removeChild(this.indicator);
    }
    this.indicator = null;
  }
}
