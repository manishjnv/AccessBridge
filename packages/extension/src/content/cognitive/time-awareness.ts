/**
 * AccessBridge — Time-Awareness Nudges (Priority 5)
 *
 * Detects hyperfocus windows and queues gentle break reminders. The detector
 * is intentionally low-touch:
 *   - every activity heartbeat (scroll, key, click, mousemove at ≥ 1s spacing)
 *     re-arms a timeout;
 *   - if the user is continuously active past `hyperfocusThresholdMs`, a
 *     single non-modal toast appears bottom-right.
 *
 * The toast self-dismisses after `toastDurationMs` or on any click. There is
 * a cooldown (`breakCooldownMs`) before another nudge can fire, so dismissing
 * one doesn't immediately trigger another.
 *
 * Also exposes a light "flow-state" signal (sustained typing with low
 * backspace rate) — consumed by DistractionShield for notification queueing.
 */

export interface TimeAwarenessOptions {
  /** Ms of continuous activity before a nudge fires. Default: 45 min. */
  hyperfocusThresholdMs: number;
  /** Ms the nudge stays on screen. Default: 12 s. */
  toastDurationMs: number;
  /** Ms before the same user can be nudged again. Default: 10 min. */
  breakCooldownMs: number;
  /** Window (ms) in which 1000 ms of idle counts as "broken focus". Default: 1 min. */
  idleWindowMs: number;
}

export const DEFAULT_OPTIONS: TimeAwarenessOptions = {
  hyperfocusThresholdMs: 45 * 60 * 1000,
  toastDurationMs: 12 * 1000,
  breakCooldownMs: 10 * 60 * 1000,
  idleWindowMs: 60 * 1000,
};

export type FlowState = 'idle' | 'active' | 'flow';

export interface FlowSnapshot {
  state: FlowState;
  activityStartedAt: number;
  lastActivityAt: number;
  typingCount: number;
  backspaceCount: number;
  /** backspace / typing ratio over the last sliding window. */
  errorRate: number;
}

interface InternalState {
  activityStartedAt: number;
  lastActivityAt: number;
  lastNudgeAt: number;
  typingCount: number;
  backspaceCount: number;
  toastEl: HTMLElement | null;
  toastTimer: ReturnType<typeof setTimeout> | null;
  listeners: Array<{ target: EventTarget; type: string; fn: EventListener }>;
  monitorInterval: ReturnType<typeof setInterval> | null;
}

/**
 * TimeAwarenessController — attach / detach lifecycle matches the other
 * content-script singletons (CaptionsController, GestureController, etc.).
 */
export class TimeAwarenessController {
  private readonly options: TimeAwarenessOptions;
  private active = false;
  private state: InternalState = this.freshState();

  constructor(options: Partial<TimeAwarenessOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.active) return;
    if (typeof document === 'undefined') return;
    this.active = true;
    this.state = this.freshState();

    const now = Date.now();
    this.state.activityStartedAt = now;
    this.state.lastActivityAt = now;

    const heartbeatHandler: EventListener = () => this.recordActivity();
    const keyHandler: EventListener = (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Backspace' || ke.key === 'Delete') this.state.backspaceCount++;
      else if (ke.key.length === 1) this.state.typingCount++;
      this.recordActivity();
    };

    this.attach(document, 'keydown', keyHandler);
    this.attach(document, 'click', heartbeatHandler);
    this.attach(document, 'scroll', heartbeatHandler);
    this.attach(document, 'mousemove', heartbeatHandler);
    this.attach(document, 'pointerdown', heartbeatHandler);

    this.state.monitorInterval = setInterval(() => this.tick(), 60 * 1000);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const { target, type, fn } of this.state.listeners) {
      target.removeEventListener(type, fn);
    }
    if (this.state.monitorInterval) clearInterval(this.state.monitorInterval);
    if (this.state.toastTimer) clearTimeout(this.state.toastTimer);
    this.state.toastEl?.remove();
    this.state = this.freshState();
  }

  isActive(): boolean {
    return this.active;
  }

  getFlowSnapshot(): FlowSnapshot {
    const now = Date.now();
    const idle = now - this.state.lastActivityAt;
    const duration = now - this.state.activityStartedAt;
    const errorRate =
      this.state.typingCount === 0
        ? 0
        : this.state.backspaceCount / Math.max(this.state.typingCount, 1);

    let flowState: FlowState;
    if (idle > this.options.idleWindowMs) flowState = 'idle';
    else if (
      duration > 5 * 60 * 1000 &&
      this.state.typingCount > 80 &&
      errorRate < 0.15
    ) {
      flowState = 'flow';
    } else {
      flowState = 'active';
    }

    return {
      state: flowState,
      activityStartedAt: this.state.activityStartedAt,
      lastActivityAt: this.state.lastActivityAt,
      typingCount: this.state.typingCount,
      backspaceCount: this.state.backspaceCount,
      errorRate,
    };
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private freshState(): InternalState {
    return {
      activityStartedAt: 0,
      lastActivityAt: 0,
      lastNudgeAt: 0,
      typingCount: 0,
      backspaceCount: 0,
      toastEl: null,
      toastTimer: null,
      listeners: [],
      monitorInterval: null,
    };
  }

  private attach(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn, { passive: true });
    this.state.listeners.push({ target, type, fn });
  }

  private recordActivity(): void {
    const now = Date.now();
    if (now - this.state.lastActivityAt > this.options.idleWindowMs) {
      // re-started after a break — reset the continuous-activity clock
      this.state.activityStartedAt = now;
      this.state.typingCount = 0;
      this.state.backspaceCount = 0;
    }
    this.state.lastActivityAt = now;
  }

  private tick(): void {
    if (!this.active) return;
    const now = Date.now();
    const continuous = now - this.state.activityStartedAt;
    const sinceLastNudge = now - this.state.lastNudgeAt;
    if (
      continuous >= this.options.hyperfocusThresholdMs &&
      sinceLastNudge >= this.options.breakCooldownMs
    ) {
      this.showNudge(continuous);
    }
  }

  private showNudge(continuousMs: number): void {
    this.state.lastNudgeAt = Date.now();
    const minutes = Math.round(continuousMs / 60_000);
    const toast = document.createElement('div');
    toast.className = 'ab-time-awareness-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <div class="ab-ta-toast-icon" aria-hidden="true">⏳</div>
      <div class="ab-ta-toast-body">
        <div class="ab-ta-toast-title">You've been focused for ${minutes} min</div>
        <div class="ab-ta-toast-subtitle">Consider a 2-minute break — stretch, blink, breathe.</div>
      </div>
      <button class="ab-ta-toast-close" aria-label="Dismiss">×</button>
    `;
    document.body.appendChild(toast);

    const remove = () => {
      toast.classList.add('ab-ta-toast-leaving');
      setTimeout(() => toast.remove(), 200);
    };
    toast.querySelector('.ab-ta-toast-close')?.addEventListener('click', remove);
    toast.addEventListener('click', remove);

    this.state.toastEl = toast;
    this.state.toastTimer = setTimeout(remove, this.options.toastDurationMs);
  }
}

// ---------------------------------------------------------------------------
// One-time style injection (parallels deepenings.ensureDeepeningStyles)
// ---------------------------------------------------------------------------

const TA_STYLE_ID = 'ab-time-awareness-style';

const TA_CSS = `
  .ab-time-awareness-toast {
    position: fixed; bottom: 24px; right: 24px;
    display: flex; align-items: flex-start; gap: 12px;
    max-width: 320px; padding: 14px 16px;
    background: rgba(26,26,46,0.96); color: #fff;
    border: 1px solid rgba(123,104,238,0.5);
    border-left: 4px solid #7b68ee;
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px; line-height: 1.5;
    z-index: 2147483100;
    cursor: pointer; opacity: 1;
    transition: opacity 200ms ease, transform 200ms ease;
  }
  .ab-time-awareness-toast.ab-ta-toast-leaving { opacity: 0; transform: translateY(8px); }
  .ab-ta-toast-icon { font-size: 20px; line-height: 1; }
  .ab-ta-toast-title { font-weight: 600; margin-bottom: 2px; }
  .ab-ta-toast-subtitle { opacity: 0.8; font-size: 12px; }
  .ab-ta-toast-close {
    background: transparent; border: 0; color: #94a3b8;
    font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1;
  }
  .ab-ta-toast-close:hover { color: #fff; }
`;

export function ensureTimeAwarenessStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(TA_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TA_STYLE_ID;
  style.textContent = TA_CSS;
  (document.head || document.documentElement).appendChild(style);
}
