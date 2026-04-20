import {
  recognize,
  GestureBindingStore,
  getActionById,
} from '@accessbridge/core/gestures';
import type {
  GestureStroke,
  PointerEvent2D,
  RecognizedGesture,
} from '@accessbridge/core/gestures';
import { GestureHintOverlay } from './gesture-hints.js';

export interface GestureControllerOptions {
  enabled: boolean;
  showHints: boolean;
  minSwipeDistance: number;
  longPressMs: number;
  mouseModeRequiresShift: boolean;
}

const DEFAULT_OPTIONS: GestureControllerOptions = {
  enabled: false,
  showHints: true,
  minSwipeDistance: 50,
  longPressMs: 600,
  mouseModeRequiresShift: true,
};

const IDLE_MS = 500;
const WHEEL_ACCUMULATOR_MS = 500;

interface ActiveStroke {
  points: PointerEvent2D[];
  startT: number;
  fingerCount: number;
  pointerType: string;
}

function isFormField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export class GestureController {
  private options: GestureControllerOptions;
  private attached = false;
  private activeStrokes = new Map<number, ActiveStroke>();
  private finishedStrokes: GestureStroke[] = [];
  private idleTimer: number | null = null;
  private hintOverlay: GestureHintOverlay | null = null;
  private bindings: GestureBindingStore;
  private wheelAccumDx = 0;
  private wheelAccumStart = 0;

  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(options: Partial<GestureControllerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.bindings = new GestureBindingStore();
    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);
    this.boundWheel = this.onWheel.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
  }

  start(): void {
    if (this.attached) return;
    if (!this.options.enabled) {
      // Enable implicitly; the explicit enabled flag is for ergonomic opt-in from consumers.
      this.options.enabled = true;
    }
    document.addEventListener('pointerdown', this.boundPointerDown, true);
    document.addEventListener('pointermove', this.boundPointerMove, true);
    document.addEventListener('pointerup', this.boundPointerUp, true);
    window.addEventListener('pointerup', this.boundPointerUp, true);
    document.addEventListener('wheel', this.boundWheel, { passive: true, capture: true });
    document.addEventListener('keydown', this.boundKeyDown, true);
    this.attached = true;
    if (!this.hintOverlay) this.hintOverlay = new GestureHintOverlay();
  }

  stop(): void {
    if (!this.attached) return;
    document.removeEventListener('pointerdown', this.boundPointerDown, true);
    document.removeEventListener('pointermove', this.boundPointerMove, true);
    document.removeEventListener('pointerup', this.boundPointerUp, true);
    window.removeEventListener('pointerup', this.boundPointerUp, true);
    document.removeEventListener('wheel', this.boundWheel, { capture: true } as EventListenerOptions);
    document.removeEventListener('keydown', this.boundKeyDown, true);
    this.attached = false;
    this.options.enabled = false;
    this.activeStrokes.clear();
    this.finishedStrokes = [];
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.hintOverlay?.destroy();
    this.hintOverlay = null;
  }

  setOptions(patch: Partial<GestureControllerOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      this.evaluate();
    }, IDLE_MS);
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.options.enabled) return;
    if (e.pointerType === 'mouse' && this.options.mouseModeRequiresShift && !e.shiftKey) {
      return;
    }
    this.activeStrokes.set(e.pointerId, {
      points: [{ x: e.clientX, y: e.clientY, t: e.timeStamp, pointerId: e.pointerId, pressure: e.pressure }],
      startT: e.timeStamp,
      fingerCount: this.activeStrokes.size + 1,
      pointerType: e.pointerType,
    });
    this.resetIdleTimer();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.options.enabled) return;
    const stroke = this.activeStrokes.get(e.pointerId);
    if (!stroke) return;
    stroke.points.push({
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
      pointerId: e.pointerId,
      pressure: e.pressure,
    });
    this.resetIdleTimer();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.options.enabled) return;
    const stroke = this.activeStrokes.get(e.pointerId);
    if (!stroke) return;
    // Push final point if it differs from last.
    const last = stroke.points[stroke.points.length - 1];
    if (!last || last.x !== e.clientX || last.y !== e.clientY || last.t !== e.timeStamp) {
      stroke.points.push({
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
        pointerId: e.pointerId,
        pressure: e.pressure,
      });
    }
    const packaged: GestureStroke = {
      points: stroke.points,
      durationMs: e.timeStamp - stroke.startT,
      fingerCount: stroke.fingerCount,
    };
    this.finishedStrokes.push(packaged);
    this.activeStrokes.delete(e.pointerId);
    if (this.activeStrokes.size === 0) {
      if (this.idleTimer !== null) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      this.evaluate();
    } else {
      this.resetIdleTimer();
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.options.enabled) return;

    // Pinch-zoom: Chrome synthesizes ctrlKey=true on trackpad pinch.
    if (e.ctrlKey) {
      const synthetic: GestureStroke = {
        points: [
          { x: 100, y: 100, t: e.timeStamp - 1, pointerId: -1 },
          { x: 100, y: 100, t: e.timeStamp, pointerId: -1 },
        ],
        durationMs: 1,
        fingerCount: 2,
      };
      const type = e.deltaY > 0 ? 'pinch-in' : 'pinch-out';
      const action = this.bindings.getBinding(type);
      if (action && action.enabled) {
        this.dispatch({ type, confidence: 0.95, stroke: synthetic });
      }
      return;
    }

    // Two-finger horizontal: accumulate horizontal deltas within 500 ms window.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && Math.abs(e.deltaX) > 5) {
      const now = e.timeStamp;
      if (now - this.wheelAccumStart > WHEEL_ACCUMULATOR_MS) {
        this.wheelAccumStart = now;
        this.wheelAccumDx = 0;
      }
      this.wheelAccumDx += e.deltaX;
      if (Math.abs(this.wheelAccumDx) >= 120) {
        const type =
          this.wheelAccumDx < 0 ? 'two-finger-swipe-left' : 'two-finger-swipe-right';
        const action = this.bindings.getBinding(type);
        if (action && action.enabled) {
          const synthetic: GestureStroke = {
            points: [
              { x: 0, y: 0, t: this.wheelAccumStart, pointerId: -2 },
              { x: this.wheelAccumDx, y: 0, t: now, pointerId: -2 },
            ],
            durationMs: now - this.wheelAccumStart,
            fingerCount: 2,
          };
          this.dispatch({ type, confidence: 0.85, stroke: synthetic });
        }
        this.wheelAccumDx = 0;
        this.wheelAccumStart = 0;
      }
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.options.enabled) return;
    if (e.key !== '?') return;
    if (isFormField(document.activeElement)) return;
    e.preventDefault();
    if (!this.hintOverlay) this.hintOverlay = new GestureHintOverlay();
    this.hintOverlay.showHelp(this.bindings.getBindings());
  }

  /**
   * Exposed for tests: finalize any pending strokes and dispatch.
   */
  evaluate(): void {
    if (this.finishedStrokes.length === 0 && this.activeStrokes.size === 0) return;
    // Also snapshot any in-flight strokes (the idle-timer path may fire before pointerup).
    if (this.activeStrokes.size > 0) {
      for (const [, s] of this.activeStrokes) {
        const last = s.points[s.points.length - 1];
        this.finishedStrokes.push({
          points: s.points.slice(),
          durationMs: last ? last.t - s.startT : 0,
          fingerCount: s.fingerCount,
        });
      }
      this.activeStrokes.clear();
    }
    const strokes = this.finishedStrokes;
    this.finishedStrokes = [];
    const recognized = recognize(strokes);
    if (!recognized) return;
    if (recognized.confidence < 0.7) return;
    const binding = this.bindings.getBinding(recognized.type);
    if (!binding || !binding.enabled) return;
    this.dispatch(recognized);
  }

  private dispatch(recognized: RecognizedGesture): void {
    const binding = this.bindings.getBinding(recognized.type);
    if (!binding) return;
    const action = getActionById(binding.actionId);
    if (!action) return;

    if (this.options.showHints) {
      this.hintOverlay?.show(recognized.type, action.name);
    }

    this.dispatchAction(binding.actionId);
  }

  private dispatchAction(actionId: string): void {
    try {
      switch (actionId) {
        case 'back':
          history.back();
          return;
        case 'forward':
          history.forward();
          return;
        case 'scroll-to-top':
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        case 'scroll-to-bottom':
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          return;
        case 'reload':
          location.reload();
          return;
        case 'next-tab':
        case 'previous-tab':
        case 'new-tab':
        case 'close-tab':
          chrome.runtime
            .sendMessage({ type: 'TAB_COMMAND', payload: { command: actionId } })
            .catch(() => {});
          return;
        case 'toggle-focus-mode':
        case 'toggle-reading-mode':
        case 'toggle-high-contrast':
        case 'toggle-voice-nav':
        case 'toggle-reading-guide':
        case 'toggle-fatigue-mode':
          chrome.runtime
            .sendMessage({ type: 'TOGGLE_FEATURE', payload: { feature: actionId.replace(/^toggle-/, '') } })
            .catch(() => {});
          return;
        case 'increase-font':
          chrome.runtime
            .sendMessage({ type: 'TOGGLE_FEATURE', payload: { feature: 'font-increase' } })
            .catch(() => {});
          return;
        case 'decrease-font':
          chrome.runtime
            .sendMessage({ type: 'TOGGLE_FEATURE', payload: { feature: 'font-decrease' } })
            .catch(() => {});
          return;
        case 'summarize-page':
          chrome.runtime.sendMessage({ type: 'SUMMARIZE_TEXT' }).catch(() => {});
          return;
        case 'summarize-selection':
          chrome.runtime
            .sendMessage({ type: 'SUMMARIZE_TEXT', payload: { selection: true } })
            .catch(() => {});
          return;
        case 'simplify-selection':
          chrome.runtime.sendMessage({ type: 'SIMPLIFY_TEXT' }).catch(() => {});
          return;
        case 'read-aloud-selection':
          chrome.runtime.sendMessage({ type: 'READ_ALOUD' }).catch(() => {});
          return;
        case 'translate-selection':
          chrome.runtime.sendMessage({ type: 'TRANSLATE_TEXT' }).catch(() => {});
          return;
        case 'click': {
          const el = document.activeElement as HTMLElement | null;
          el?.click();
          return;
        }
        case 'right-click': {
          const el = (document.activeElement as HTMLElement | null) ?? document.body;
          const rect = el.getBoundingClientRect();
          el.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
            }),
          );
          return;
        }
        case 'triple-click': {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return;
          for (let i = 0; i < 3; i++) el.click();
          return;
        }
        case 'select-word':
        case 'select-paragraph': {
          const sel = window.getSelection();
          const target = actionId === 'select-word' ? 'word' : 'paragraph';
          if (sel && typeof (sel as Selection & { modify?: (a: string, d: string, g: string) => void }).modify === 'function') {
            (sel as Selection & { modify: (a: string, d: string, g: string) => void }).modify(
              'extend',
              'forward',
              target,
            );
          }
          return;
        }
        case 'copy':
          document.execCommand('copy');
          return;
        case 'paste':
          document.execCommand('paste');
          return;
        case 'cancel': {
          const el = document.activeElement as HTMLElement | null;
          el?.blur();
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
          );
          return;
        }
      }
    } catch {
      // Swallow — dispatch is best-effort.
    }
  }
}

export function createGestureController(
  options: Partial<GestureControllerOptions> = {},
): GestureController {
  return new GestureController(options);
}
