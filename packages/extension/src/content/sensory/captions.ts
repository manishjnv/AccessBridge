// --- Priority 1: Captions + Actions ---
/**
 * CaptionsController — attaches a Web Speech API live-caption overlay
 * on top of visible <video> elements on the page.
 *
 * We define our own minimal interfaces rather than relying on the global
 * SpeechRecognition DOM types (which may not be in the tsconfig lib).
 */

// ── Local type stubs for Web Speech API ──────────────────────────────────────

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface AbSpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface AbSpeechRecognitionErrorEvent {
  error: string;
  message?: string;
}

interface AbSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
}

type AbSpeechRecognitionClass = new () => AbSpeechRecognition;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flag so we only show the "not supported" toast once per session. */
let toastShown = false;

function showUnsupportedToast(): void {
  if (toastShown) return;
  toastShown = true;
  const toast = document.createElement('div');
  toast.className = 'ab-captions-toast';
  toast.setAttribute('role', 'alert');
  toast.textContent = 'Live Captions: Speech Recognition API not available in this browser.';
  document.body.appendChild(toast);
  setTimeout(() => {
    try { document.body.removeChild(toast); } catch { /* already removed */ }
  }, 4000);
}

function getSpeechAPI(): AbSpeechRecognitionClass | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w['SpeechRecognition'] ?? w['webkitSpeechRecognition']) as AbSpeechRecognitionClass | undefined;
}

function isVideoVisible(video: HTMLVideoElement): boolean {
  if (video.offsetWidth <= 100 || video.offsetHeight <= 100) return false;
  const style = window.getComputedStyle(video);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface CaptionsOptions {
  /** BCP-47 tag passed to SpeechRecognition.lang. Empty falls back to documentElement.lang then 'en-US'. */
  language: string;
  /** When non-null and ≠ language, live-translate finals through the AI engine before rendering. */
  targetLanguage: string | null;
  /** Overlay vertical position. */
  position: 'top' | 'bottom';
  /** Overlay font size in px (12-32 sensible range, not clamped here). */
  fontSize: number;
  /** Optional translator (text, from, to) → Promise<text>. Injected by content/index.ts via AI bridge. */
  translate?: (text: string, from: string, to: string) => Promise<string>;
}

const DEFAULT_OPTIONS: CaptionsOptions = {
  language: '',
  targetLanguage: null,
  position: 'bottom',
  fontSize: 18,
};

// ── Controller ────────────────────────────────────────────────────────────────

export class CaptionsController {
  private recognition: AbSpeechRecognition | null = null;
  private overlay: HTMLDivElement | null = null;
  private observer: MutationObserver | null = null;
  private active = false;
  private finalLines: string[] = [];
  private options: CaptionsOptions;

  // Bound listener refs for cleanup
  private boundOnResult: ((e: Event) => void) | null = null;
  private boundOnEnd: (() => void) | null = null;
  private boundOnError: ((e: Event) => void) | null = null;

  constructor(options: Partial<CaptionsOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Update options live. Applies font/position to the current overlay and language to the running recognizer. */
  configure(patch: Partial<CaptionsOptions>): void {
    this.options = { ...this.options, ...patch };
    if (this.overlay) this.applyOverlayStyle();
    if (this.recognition && patch.language !== undefined) {
      this.recognition.lang = this.resolveLanguage();
      // SpeechRecognition won't re-read lang mid-session — bounce to apply
      try { this.recognition.stop(); } catch { /* ignore */ }
      // onend handler restarts when this.active
    }
  }

  private resolveLanguage(): string {
    return this.options.language || document.documentElement.lang || 'en-US';
  }

  private applyOverlayStyle(): void {
    if (!this.overlay) return;
    this.overlay.style.fontSize = `${this.options.fontSize}px`;
    if (this.options.position === 'top') {
      this.overlay.style.top = '10%';
      this.overlay.style.bottom = 'auto';
    } else {
      this.overlay.style.top = 'auto';
      this.overlay.style.bottom = '15%';
    }
  }

  start(): void {
    if (this.active) return; // guard double-start

    const SpeechAPI = getSpeechAPI();

    if (!SpeechAPI) {
      showUnsupportedToast();
      return;
    }

    this.active = true;

    // Find visible videos and create overlay
    this.getOrCreateOverlay();

    // Start speech recognition
    this.recognition = new SpeechAPI();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.resolveLanguage();

    this.boundOnResult = (e: Event) => {
      const evt = e as unknown as AbSpeechRecognitionEvent;
      let interim = '';
      let newFinal: string | null = null;
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const result = evt.results[i];
        if (result.isFinal) {
          newFinal = result[0].transcript.trim();
          this.finalLines.push(newFinal);
        } else {
          interim = result[0].transcript.trim();
        }
      }
      this.renderCurrent(interim);

      // Fire-and-forget translation of finals — replaces the last rendered line on resolve
      const { targetLanguage, translate } = this.options;
      const sourceLang = this.resolveLanguage();
      if (newFinal && translate && targetLanguage && targetLanguage !== sourceLang) {
        const originalIdx = this.finalLines.length - 1;
        translate(newFinal, sourceLang, targetLanguage)
          .then((translated) => {
            if (this.finalLines[originalIdx] === newFinal) {
              this.finalLines[originalIdx] = translated;
              this.renderCurrent('');
            }
          })
          .catch(() => { /* swallow — keep original */ });
      }
    };

    this.boundOnEnd = () => {
      // Auto-restart if still active (recognition can stop on silence)
      if (this.active && this.recognition) {
        try {
          this.recognition.start();
        } catch {
          // Ignore "already started" errors
        }
      }
    };

    this.boundOnError = (e: Event) => {
      const evt = e as unknown as AbSpeechRecognitionErrorEvent;
      if (evt.error === 'not-allowed' || evt.error === 'service-not-allowed') {
        showUnsupportedToast();
        this.stop();
      }
      // Other errors (network, aborted) are transient — let onend restart us
    };

    this.recognition.addEventListener('result', this.boundOnResult);
    this.recognition.addEventListener('end', this.boundOnEnd);
    this.recognition.addEventListener('error', this.boundOnError);

    try {
      this.recognition.start();
    } catch {
      // May throw if called twice — swallow
    }

    this.startMutationObserver();
  }

  stop(): void {
    this.active = false;

    if (this.recognition) {
      if (this.boundOnResult) this.recognition.removeEventListener('result', this.boundOnResult);
      if (this.boundOnEnd) this.recognition.removeEventListener('end', this.boundOnEnd);
      if (this.boundOnError) this.recognition.removeEventListener('error', this.boundOnError);
      try {
        this.recognition.stop();
      } catch {
        // Ignore
      }
      this.recognition = null;
    }

    this.boundOnResult = null;
    this.boundOnEnd = null;
    this.boundOnError = null;

    if (this.overlay) {
      try { this.overlay.parentNode?.removeChild(this.overlay); } catch { /* already removed */ }
      this.overlay = null;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    this.finalLines = [];
  }

  isActive(): boolean {
    return this.recognition !== null && this.active;
  }

  /** @internal exposed for tests */
  getOrCreateOverlay(): HTMLDivElement | null {
    // Find first visible video
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const visible = videos.find(isVideoVisible);
    if (!visible) return null;

    if (!this.overlay) {
      const div = document.createElement('div');
      div.className = 'ab-captions-overlay';
      div.setAttribute('aria-live', 'polite');
      div.setAttribute('role', 'status');

      const textEl = document.createElement('span');
      textEl.className = 'ab-captions-text';
      div.appendChild(textEl);

      const close = document.createElement('button');
      close.className = 'ab-captions-close';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Close captions');
      close.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        this.stop();
      });
      div.appendChild(close);

      this.attachDragHandlers(div);

      document.body.appendChild(div);
      this.overlay = div;
      this.applyOverlayStyle();
    }

    return this.overlay;
  }

  private attachDragHandlers(el: HTMLDivElement): void {
    let drag: { startX: number; startY: number; origLeft: number; origTop: number; id: number } | null = null;

    el.addEventListener('pointerdown', (ev: Event) => {
      const e = ev as PointerEvent;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.ab-captions-close')) return;
      const rect = el.getBoundingClientRect();
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left,
        origTop: rect.top,
        id: e.pointerId,
      };
      try { el.setPointerCapture?.(e.pointerId); } catch { /* no-op in tests */ }
      e.preventDefault();
    });

    el.addEventListener('pointermove', (ev: Event) => {
      const e = ev as PointerEvent;
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      el.style.left = `${drag.origLeft + dx}px`;
      el.style.top = `${drag.origTop + dy}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.transform = 'none';
    });

    const end = (ev: Event) => {
      const e = ev as PointerEvent;
      if (drag && e.pointerId === drag.id) {
        try { el.releasePointerCapture?.(e.pointerId); } catch { /* no-op */ }
        drag = null;
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  private renderCurrent(interim: string): void {
    if (!this.overlay) return;
    const textEl =
      (this.overlay.querySelector('.ab-captions-text') as HTMLElement | null) ?? this.overlay;
    const displayLines = [...this.finalLines, interim].filter(Boolean);
    textEl.textContent = displayLines.slice(-2).join('\n');
  }

  private startMutationObserver(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((_mutations) => {
      if (!this.active) return;
      // If we don't have an overlay yet, check if videos appeared
      if (!this.overlay) {
        const created = this.getOrCreateOverlay();
        if (created && this.recognition) {
          try { this.recognition.start(); } catch { /* already running */ }
        }
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }
}
