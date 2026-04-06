/**
 * DwellClickSystem – gaze/hover-based auto-click for motor-impaired users
 * who cannot perform a physical mouse click.
 *
 * When the cursor rests over an interactive element for a configurable
 * dwell period (default 800 ms) without moving more than 15 px from the
 * dwell-start position, the element is automatically clicked.  A radial
 * SVG progress indicator follows the cursor and fills clockwise to give
 * clear visual feedback of the countdown.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DWELL_DELAY_MS = 800;

/** Maximum cursor drift (px) allowed before the dwell resets. */
const MOVE_THRESHOLD_PX = 15;

/** Radius of the SVG progress ring (px). */
const RING_RADIUS = 20;

/** Stroke width of the SVG progress ring (px). */
const RING_STROKE = 4;

/** Full SVG viewBox size = 2 * (RING_RADIUS + RING_STROKE) + padding */
const SVG_SIZE = (RING_RADIUS + RING_STROKE) * 2 + 4;

/** Circumference of the dwell progress circle. */
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** CSS class names — kept in one place to simplify cleanup. */
const CSS = {
  INDICATOR: 'ab-dwell-indicator',
  TARGET: 'ab-dwell-target',
  PULSE: 'ab-dwell-click-pulse',
  KEYFRAMES: 'ab-dwell-keyframes',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the element is one that should never be dwell-clicked. */
function isBlockedElement(el: Element): boolean {
  return el === document.body || el === document.documentElement;
}

/** Euclidean distance between two points. */
function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

// ---------------------------------------------------------------------------
// DwellClickSystem
// ---------------------------------------------------------------------------

export class DwellClickSystem {
  // ---- Configuration ----
  private delayMs: number = DEFAULT_DWELL_DELAY_MS;

  // ---- Runtime state ----
  private active = false;

  /** The element currently being dwelled on. */
  private dwellTarget: Element | null = null;

  /** Cursor position at the moment the dwell began. */
  private dwellOriginX = 0;
  private dwellOriginY = 0;

  /** Timestamp returned by requestAnimationFrame (used for the progress ring). */
  private rafId: number | null = null;

  /** Timestamp when the dwell started (performance.now()). */
  private dwellStartTime = 0;

  // ---- DOM elements ----
  private indicatorEl: HTMLElement | null = null;
  private progressCircle: SVGCircleElement | null = null;

  // ---- Bound listener references (for clean removal) ----
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseLeave: (e: MouseEvent) => void;

  constructor() {
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onMouseLeave = this.handleMouseLeave.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the dwell-click system.
   * @param delay  Optional override for the dwell delay in milliseconds.
   */
  start(delay?: number): void {
    if (this.active) return;

    if (delay !== undefined) {
      this.delayMs = Math.max(100, delay);
    }

    this.active = true;
    this.injectKeyframes();
    this.createIndicator();

    document.addEventListener('mousemove', this.onMouseMove, { passive: true });
    document.addEventListener('mouseleave', this.onMouseLeave, { passive: true });
  }

  /** Stop the dwell-click system and clean up all DOM elements and listeners. */
  stop(): void {
    if (!this.active) return;

    this.active = false;
    this.cancelDwell();

    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseleave', this.onMouseLeave);

    this.removeIndicator();
    this.removeKeyframes();
  }

  /**
   * Update the dwell delay.  Takes effect for the next dwell cycle.
   * @param ms  Dwell delay in milliseconds (minimum 100 ms).
   */
  setDelay(ms: number): void {
    this.delayMs = Math.max(100, ms);
  }

  // ---------------------------------------------------------------------------
  // Mouse event handlers
  // ---------------------------------------------------------------------------

  private handleMouseMove(e: MouseEvent): void {
    const x = e.clientX;
    const y = e.clientY;

    // Move the indicator to follow the cursor regardless of dwell state.
    this.positionIndicator(x, y);
    this.showIndicator();

    // Identify the topmost element under the cursor (ignore the indicator itself).
    const target = this.getTargetAt(x, y);

    if (!target || isBlockedElement(target)) {
      this.cancelDwell();
      return;
    }

    // If the cursor has drifted too far from the dwell origin, reset.
    if (this.dwellTarget !== null) {
      const drift = distance(x, y, this.dwellOriginX, this.dwellOriginY);
      if (drift > MOVE_THRESHOLD_PX) {
        this.cancelDwell();
      }
    }

    // Begin a fresh dwell when hovering a new element or after a reset.
    if (this.dwellTarget === null) {
      this.beginDwell(target, x, y);
    }
  }

  private handleMouseLeave(): void {
    this.cancelDwell();
    this.hideIndicator();
  }

  // ---------------------------------------------------------------------------
  // Dwell lifecycle
  // ---------------------------------------------------------------------------

  private beginDwell(target: Element, x: number, y: number): void {
    this.dwellTarget = target;
    this.dwellOriginX = x;
    this.dwellOriginY = y;
    this.dwellStartTime = performance.now();

    // Highlight the target element.
    target.classList.add(CSS.TARGET);

    // Start the animation loop.
    this.scheduleTick();
  }

  private cancelDwell(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.dwellTarget !== null) {
      this.dwellTarget.classList.remove(CSS.TARGET);
      this.dwellTarget = null;
    }

    // Reset the progress ring to empty.
    this.setRingProgress(0);
  }

  private scheduleTick(): void {
    this.rafId = requestAnimationFrame((now) => this.tick(now));
  }

  private tick(now: DOMHighResTimeStamp): void {
    if (!this.active || this.dwellTarget === null) return;

    const elapsed = now - this.dwellStartTime;
    const progress = Math.min(elapsed / this.delayMs, 1);

    this.setRingProgress(progress);

    if (progress >= 1) {
      this.fireDwellClick();
      return;
    }

    // Continue animating.
    this.scheduleTick();
  }

  private fireDwellClick(): void {
    const target = this.dwellTarget;
    if (!target) return;

    // Remove the dwell highlight before clicking.
    target.classList.remove(CSS.TARGET);
    this.dwellTarget = null;

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // Reset the ring.
    this.setRingProgress(0);

    // Visual pulse feedback.
    this.playClickPulse(target);

    // Synthesise a left-click.
    (target as HTMLElement).dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Visual effects
  // ---------------------------------------------------------------------------

  /** Play the brief pulse animation on the clicked element. */
  private playClickPulse(target: Element): void {
    target.classList.add(CSS.PULSE);
    target.addEventListener(
      'animationend',
      () => target.classList.remove(CSS.PULSE),
      { once: true },
    );
  }

  /** Set the SVG ring progress (0 = empty, 1 = full). */
  private setRingProgress(progress: number): void {
    if (!this.progressCircle) return;
    const offset = RING_CIRCUMFERENCE * (1 - progress);
    this.progressCircle.style.strokeDashoffset = String(offset);
  }

  /** Move the indicator element to track the cursor. */
  private positionIndicator(x: number, y: number): void {
    if (!this.indicatorEl) return;
    // Offset so the centre of the ring sits over the cursor hotspot.
    const half = SVG_SIZE / 2;
    this.indicatorEl.style.left = `${x - half}px`;
    this.indicatorEl.style.top = `${y - half}px`;
  }

  private showIndicator(): void {
    if (this.indicatorEl) {
      this.indicatorEl.style.opacity = '1';
    }
  }

  private hideIndicator(): void {
    if (this.indicatorEl) {
      this.indicatorEl.style.opacity = '0';
    }
  }

  // ---------------------------------------------------------------------------
  // DOM management
  // ---------------------------------------------------------------------------

  /** Build and insert the SVG dwell-progress indicator. */
  private createIndicator(): void {
    if (document.getElementById('ab-dwell-indicator-el')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'ab-dwell-indicator-el';
    wrapper.className = CSS.INDICATOR;
    wrapper.setAttribute('aria-hidden', 'true');

    const cx = SVG_SIZE / 2;
    const cy = SVG_SIZE / 2;

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(SVG_SIZE));
    svg.setAttribute('height', String(SVG_SIZE));
    svg.setAttribute('viewBox', `0 0 ${SVG_SIZE} ${SVG_SIZE}`);

    // Background track ring.
    const trackCircle = document.createElementNS(svgNS, 'circle');
    trackCircle.setAttribute('cx', String(cx));
    trackCircle.setAttribute('cy', String(cy));
    trackCircle.setAttribute('r', String(RING_RADIUS));
    trackCircle.setAttribute('fill', 'none');
    trackCircle.setAttribute('stroke', 'rgba(255,255,255,0.25)');
    trackCircle.setAttribute('stroke-width', String(RING_STROKE));

    // Progress arc — starts at the 12-o'clock position.
    const progressCircle = document.createElementNS(svgNS, 'circle');
    progressCircle.setAttribute('cx', String(cx));
    progressCircle.setAttribute('cy', String(cy));
    progressCircle.setAttribute('r', String(RING_RADIUS));
    progressCircle.setAttribute('fill', 'none');
    progressCircle.setAttribute('stroke', '#7b68ee');
    progressCircle.setAttribute('stroke-width', String(RING_STROKE));
    progressCircle.setAttribute('stroke-linecap', 'round');
    progressCircle.setAttribute(
      'stroke-dasharray',
      `${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`,
    );
    progressCircle.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
    // Rotate so the arc begins at the top (SVG arcs start at 3 o'clock).
    progressCircle.setAttribute(
      'transform',
      `rotate(-90 ${cx} ${cy})`,
    );

    svg.appendChild(trackCircle);
    svg.appendChild(progressCircle);
    wrapper.appendChild(svg);

    document.body.appendChild(wrapper);

    this.indicatorEl = wrapper;
    this.progressCircle = progressCircle;
  }

  private removeIndicator(): void {
    this.indicatorEl?.remove();
    this.indicatorEl = null;
    this.progressCircle = null;
  }

  /** Inject the dwell-click keyframe animations into the document head. */
  private injectKeyframes(): void {
    if (document.getElementById(CSS.KEYFRAMES)) return;

    const style = document.createElement('style');
    style.id = CSS.KEYFRAMES;
    style.textContent = `
      @keyframes ab-dwell-click-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(123, 104, 238, 0.7); }
        50%  { box-shadow: 0 0 0 10px rgba(123, 104, 238, 0); }
        100% { box-shadow: 0 0 0 0 rgba(123, 104, 238, 0); }
      }
      @keyframes ab-dwell-target-in {
        from { outline-color: transparent; }
        to   { outline-color: rgba(123, 104, 238, 0.8); }
      }
    `;
    document.head.appendChild(style);
  }

  private removeKeyframes(): void {
    document.getElementById(CSS.KEYFRAMES)?.remove();
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Returns the topmost element at (x, y), skipping the indicator overlay
   * so it never intercepts its own events.
   */
  private getTargetAt(x: number, y: number): Element | null {
    if (this.indicatorEl) {
      // Temporarily hide the indicator so elementFromPoint ignores it.
      const prev = this.indicatorEl.style.pointerEvents;
      this.indicatorEl.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      this.indicatorEl.style.pointerEvents = prev;
      return el;
    }
    return document.elementFromPoint(x, y);
  }
}
