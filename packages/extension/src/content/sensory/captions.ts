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

// ── Controller ────────────────────────────────────────────────────────────────

export class CaptionsController {
  private recognition: AbSpeechRecognition | null = null;
  private overlay: HTMLDivElement | null = null;
  private observer: MutationObserver | null = null;
  private active = false;
  private finalLines: string[] = [];

  // Bound listener refs for cleanup
  private boundOnResult: ((e: Event) => void) | null = null;
  private boundOnEnd: (() => void) | null = null;
  private boundOnError: ((e: Event) => void) | null = null;

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
    this.recognition.lang = document.documentElement.lang || 'en-US';

    this.boundOnResult = (e: Event) => {
      const evt = e as unknown as AbSpeechRecognitionEvent;
      let interim = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const result = evt.results[i];
        if (result.isFinal) {
          this.finalLines.push(result[0].transcript.trim());
        } else {
          interim = result[0].transcript.trim();
        }
      }
      // Show last 2 lines of final + current interim
      const displayLines = [...this.finalLines, interim].filter(Boolean);
      const display = displayLines.slice(-2).join('\n');
      if (this.overlay) this.overlay.textContent = display;
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
      document.body.appendChild(div);
      this.overlay = div;
    }

    return this.overlay;
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
