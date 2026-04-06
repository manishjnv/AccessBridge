/**
 * VoiceCommandSystem – hands-free voice navigation for the AccessBridge
 * Chrome extension using the Web Speech API (webkitSpeechRecognition).
 *
 * Provides 20+ voice commands for navigation, clicking, typing, tab
 * management, page control, and accessibility features.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CommandHandler = (args: string) => void;

interface VoiceCommandOptions {
  /** Language / locale for speech recognition (BCP-47). */
  lang?: string;
  /** Called whenever a command is recognised. */
  onCommand?: (command: string, args: string) => void;
  /** Called when recognition status changes. */
  onStatusChange?: (listening: boolean) => void;
  /** Called on error. */
  onError?: (error: string) => void;
  /** Continuous listening (restart after each result). Default true. */
  continuous?: boolean;
}

interface HighlightState {
  originalOutline: string;
  element: HTMLElement;
  timeout: ReturnType<typeof setTimeout>;
}

// Chrome's SpeechRecognition is exposed under a vendor prefix.
interface WebkitSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionErrorEvent {
  error: string;
  message: string;
}

declare const webkitSpeechRecognition: {
  new (): WebkitSpeechRecognition;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDICATOR_ID = 'a11y-voice-indicator';
const HELP_OVERLAY_ID = 'a11y-voice-help';
const SCROLL_AMOUNT = 300;
const ZOOM_STEP = 10; // percentage points

const HELP_COMMANDS: ReadonlyArray<[string, string]> = [
  ['scroll up / down', 'Scroll the page'],
  ['go to top / bottom', 'Jump to page edges'],
  ['go back / forward', 'Browser history navigation'],
  ['click [text]', 'Click a link or button by its text'],
  ['type [text]', 'Type into the focused input'],
  ['next tab / previous tab', 'Switch browser tabs'],
  ['close tab', 'Close the current tab'],
  ['reload', 'Reload the page'],
  ['stop', 'Stop page loading'],
  ['find [text]', 'Find text on the page'],
  ['zoom in / zoom out', 'Adjust page zoom'],
  ['read page', 'Read page content aloud'],
  ['focus mode', 'Toggle focus-visible outlines'],
  ['reading mode', 'Toggle simplified reading layout'],
  ['help', 'Show this help overlay'],
  ['stop listening', 'Turn off voice commands'],
];

// ---------------------------------------------------------------------------
// VoiceCommandSystem
// ---------------------------------------------------------------------------

export class VoiceCommandSystem {
  private recognition: WebkitSpeechRecognition | null = null;
  private listening = false;
  private intentionalStop = false;
  private indicatorEl: HTMLElement | null = null;
  private helpOverlayEl: HTMLElement | null = null;
  private highlights: HighlightState[] = [];
  private currentZoom = 100;
  private speechSynth: SpeechSynthesis | null = null;
  private focusModeActive = false;
  private readingModeActive = false;

  private readonly opts: Required<VoiceCommandOptions>;
  private readonly commands: Map<string, CommandHandler> = new Map();
  private readonly paramCommands: Array<{
    prefix: string;
    handler: (args: string) => void;
  }> = [];

  constructor(options: VoiceCommandOptions = {}) {
    this.opts = {
      lang: options.lang ?? 'en-US',
      onCommand: options.onCommand ?? (() => {}),
      onStatusChange: options.onStatusChange ?? (() => {}),
      onError: options.onError ?? (() => {}),
      continuous: options.continuous ?? true,
    };

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      this.speechSynth = window.speechSynthesis;
    }

    this.registerDefaultCommands();
  }

  // ---------- Public API ----------

  /**
   * Start listening for voice commands. Throws if the Web Speech API
   * is not available in this browser.
   */
  start(): void {
    if (this.listening) return;

    if (typeof webkitSpeechRecognition === 'undefined') {
      const msg =
        'Web Speech API is not supported in this browser. Please use Google Chrome.';
      this.opts.onError(msg);
      throw new Error(msg);
    }

    this.recognition = new webkitSpeechRecognition();
    this.recognition.continuous = this.opts.continuous;
    this.recognition.interimResults = false;
    this.recognition.lang = this.opts.lang;
    this.recognition.maxAlternatives = 3;

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      this.handleResult(event);
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.handleError(event);
    };

    this.recognition.onend = () => {
      this.handleEnd();
    };

    this.recognition.onstart = () => {
      this.listening = true;
      this.intentionalStop = false;
      this.opts.onStatusChange(true);
      this.showIndicator();
    };

    try {
      this.recognition.start();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to start speech recognition';
      this.opts.onError(msg);
    }
  }

  /** Stop listening for voice commands. */
  stop(): void {
    this.intentionalStop = true;
    this.recognition?.stop();
    this.listening = false;
    this.opts.onStatusChange(false);
    this.hideIndicator();
    this.hideHelp();
  }

  /** Whether the system is currently listening. */
  isListening(): boolean {
    return this.listening;
  }

  /**
   * Register a custom command. For commands that take an argument
   * (e.g. "click [text]"), register with the prefix only ("click")
   * and set `hasArgs` to true.
   */
  registerCommand(
    phrase: string,
    handler: CommandHandler,
    hasArgs = false,
  ): void {
    const key = phrase.toLowerCase().trim();
    if (hasArgs) {
      this.paramCommands.push({ prefix: key, handler });
    } else {
      this.commands.set(key, handler);
    }
  }

  /** Remove a previously registered command. */
  unregisterCommand(phrase: string): void {
    const key = phrase.toLowerCase().trim();
    this.commands.delete(key);
    const idx = this.paramCommands.findIndex((c) => c.prefix === key);
    if (idx !== -1) this.paramCommands.splice(idx, 1);
  }

  // ---------- Recognition event handlers ----------

  private handleResult(event: SpeechRecognitionEvent): void {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;

      // Try each alternative for the best command match
      for (let j = 0; j < result.length; j++) {
        const transcript = result[j].transcript.trim().toLowerCase();
        if (this.dispatch(transcript)) break;
      }
    }
  }

  private handleError(event: SpeechRecognitionErrorEvent): void {
    const ignorable = ['no-speech', 'aborted'];
    if (ignorable.includes(event.error)) return;

    let message: string;
    switch (event.error) {
      case 'not-allowed':
        message =
          'Microphone access was denied. Please allow microphone permissions.';
        break;
      case 'network':
        message =
          'Network error during speech recognition. Check your connection.';
        break;
      case 'audio-capture':
        message =
          'No microphone was found. Please connect a microphone and try again.';
        break;
      case 'service-not-allowed':
        message =
          'Speech recognition service is not allowed. This may be a browser restriction.';
        break;
      default:
        message = `Speech recognition error: ${event.error}`;
    }

    this.opts.onError(message);
  }

  private handleEnd(): void {
    this.listening = false;
    this.opts.onStatusChange(false);

    // Auto-restart unless the user intentionally stopped
    if (!this.intentionalStop && this.opts.continuous) {
      try {
        this.recognition?.start();
      } catch {
        // Recognition may already be running; ignore
      }
    } else {
      this.hideIndicator();
    }
  }

  // ---------- Command dispatching ----------

  private dispatch(transcript: string): boolean {
    // 1. Try exact match
    const exactHandler = this.commands.get(transcript);
    if (exactHandler) {
      exactHandler('');
      this.opts.onCommand(transcript, '');
      return true;
    }

    // 2. Try parameterised commands (longest prefix wins)
    let bestMatch: { prefix: string; handler: CommandHandler; args: string } | null =
      null;
    for (const cmd of this.paramCommands) {
      if (
        transcript.startsWith(cmd.prefix + ' ') &&
        (!bestMatch || cmd.prefix.length > bestMatch.prefix.length)
      ) {
        const args = transcript.slice(cmd.prefix.length + 1).trim();
        bestMatch = { ...cmd, args };
      }
    }

    if (bestMatch) {
      bestMatch.handler(bestMatch.args);
      this.opts.onCommand(bestMatch.prefix, bestMatch.args);
      return true;
    }

    return false;
  }

  // ---------- Default command registration ----------

  private registerDefaultCommands(): void {
    // Navigation
    this.registerCommand('scroll up', () => {
      window.scrollBy({ top: -SCROLL_AMOUNT, behavior: 'smooth' });
    });
    this.registerCommand('scroll down', () => {
      window.scrollBy({ top: SCROLL_AMOUNT, behavior: 'smooth' });
    });
    this.registerCommand('go to top', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    this.registerCommand('go to bottom', () => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });
    this.registerCommand('go back', () => {
      window.history.back();
    });
    this.registerCommand('go forward', () => {
      window.history.forward();
    });

    // Click
    this.registerCommand(
      'click',
      (args: string) => {
        this.handleClick(args);
      },
      true,
    );

    // Input
    this.registerCommand(
      'type',
      (args: string) => {
        this.handleType(args);
      },
      true,
    );

    // Tab management (delegated to background script)
    this.registerCommand('next tab', () => {
      this.sendToBackground({ action: 'nextTab' });
    });
    this.registerCommand('previous tab', () => {
      this.sendToBackground({ action: 'previousTab' });
    });
    this.registerCommand('close tab', () => {
      this.sendToBackground({ action: 'closeTab' });
    });

    // Page actions
    this.registerCommand('reload', () => {
      location.reload();
    });
    this.registerCommand('stop', () => {
      window.stop();
    });
    this.registerCommand(
      'find',
      (args: string) => {
        this.handleFind(args);
      },
      true,
    );

    // Accessibility
    this.registerCommand('zoom in', () => {
      this.currentZoom = Math.min(200, this.currentZoom + ZOOM_STEP);
      document.body.style.zoom = `${this.currentZoom}%`;
    });
    this.registerCommand('zoom out', () => {
      this.currentZoom = Math.max(50, this.currentZoom - ZOOM_STEP);
      document.body.style.zoom = `${this.currentZoom}%`;
    });
    this.registerCommand('read page', () => {
      this.handleReadPage();
    });
    this.registerCommand('focus mode', () => {
      this.toggleFocusMode();
    });
    this.registerCommand('reading mode', () => {
      this.toggleReadingMode();
    });

    // General
    this.registerCommand('help', () => {
      this.toggleHelp();
    });
    this.registerCommand('stop listening', () => {
      this.stop();
    });
  }

  // ---------- Command implementations ----------

  /**
   * Find interactive elements whose visible text contains the given
   * query (case-insensitive) and click the best match.
   */
  private handleClick(query: string): void {
    if (!query) return;

    const selectors = 'a, button, [role="button"], input[type="submit"], input[type="button"]';
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selectors));

    type ScoredEl = { el: HTMLElement; score: number };

    const scored: ScoredEl[] = candidates
      .map((el) => {
        const text = (
          el.textContent ||
          el.getAttribute('aria-label') ||
          (el as HTMLInputElement).value ||
          ''
        ).toLowerCase();

        if (!text.includes(query)) return null;

        // Scoring: exact match > starts-with > contains.
        // Visible elements score higher than hidden ones.
        let score = 1;
        if (text === query) score += 10;
        else if (text.startsWith(query)) score += 5;

        if (this.isElementVisible(el)) score += 20;

        // Prefer elements closer to the viewport centre
        const rect = el.getBoundingClientRect();
        const distFromCentre = Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
        score += Math.max(0, 10 - distFromCentre / 100);

        return { el, score };
      })
      .filter((x): x is ScoredEl => x !== null)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const target = scored[0].el;
      this.flashHighlight(target);
      target.focus();
      target.click();
    } else {
      this.opts.onError(`No clickable element found matching "${query}"`);
    }
  }

  /** Type the given text into the currently focused input element. */
  private handleType(text: string): void {
    const active = document.activeElement as HTMLElement | null;

    if (
      !active ||
      !(
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active.isContentEditable
      )
    ) {
      this.opts.onError(
        'No text input is focused. Click on an input field first, or say "click" to focus one.',
      );
      return;
    }

    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
    ) {
      // Insert at cursor position
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? active.value.length;
      const before = active.value.slice(0, start);
      const after = active.value.slice(end);
      active.value = before + text + after;
      active.selectionStart = active.selectionEnd = start + text.length;

      // Fire input event so frameworks pick up the change
      active.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (active.isContentEditable) {
      document.execCommand('insertText', false, text);
    }
  }

  /** Find text on the page using window.find with a highlight fallback. */
  private handleFind(query: string): void {
    if (!query) return;

    // Clear previous highlights
    this.clearHighlights();

    // Try native window.find first (not available everywhere)
    if (typeof (window as any).find === 'function') {
      (window as any).find(query, false, false, true);
      return;
    }

    // Fallback: walk the DOM and highlight matches
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
    );

    const lowerQuery = query.toLowerCase();
    let node: Text | null;

    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent ?? '';
      if (text.toLowerCase().includes(lowerQuery)) {
        const parent = node.parentElement;
        if (parent && this.isElementVisible(parent)) {
          this.flashHighlight(parent, 5000);
          parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }
    }

    this.opts.onError(`Text "${query}" not found on the page.`);
  }

  /** Read the main content of the page aloud via SpeechSynthesis. */
  private handleReadPage(): void {
    if (!this.speechSynth) {
      this.opts.onError('Speech synthesis is not available in this browser.');
      return;
    }

    // Stop any ongoing speech
    if (this.speechSynth.speaking) {
      this.speechSynth.cancel();
      return;
    }

    const main =
      document.querySelector('main') ??
      document.querySelector('[role="main"]') ??
      document.querySelector('article') ??
      document.querySelector('#content') ??
      document.body;

    const text = (main.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) {
      this.opts.onError('No readable text found on the page.');
      return;
    }

    // SpeechSynthesis has a ~32 000 char limit in some browsers, so chunk
    const CHUNK_SIZE = 4000;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }

    const speakChunk = (index: number): void => {
      if (index >= chunks.length) return;
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = this.opts.lang;
      utterance.rate = 1.0;
      utterance.onend = () => speakChunk(index + 1);
      this.speechSynth!.speak(utterance);
    };

    speakChunk(0);
  }

  /** Toggle focus-visible outlines on all focusable elements. */
  private toggleFocusMode(): void {
    this.focusModeActive = !this.focusModeActive;
    if (this.focusModeActive) {
      document.body.classList.add('a11y-focus-visible');
    } else {
      document.body.classList.remove('a11y-focus-visible');
    }
  }

  /** Toggle a simplified reading layout. */
  private toggleReadingMode(): void {
    this.readingModeActive = !this.readingModeActive;
    const main =
      document.querySelector('main') ??
      document.querySelector('[role="main"]') ??
      document.querySelector('article') ??
      document.querySelector('#content') ??
      document.body;

    if (this.readingModeActive) {
      main.classList.add('a11y-reading-mode');
    } else {
      main.classList.remove('a11y-reading-mode');
    }
  }

  // ---------- Help overlay ----------

  private toggleHelp(): void {
    if (this.helpOverlayEl) {
      this.hideHelp();
    } else {
      this.showHelp();
    }
  }

  private showHelp(): void {
    if (document.getElementById(HELP_OVERLAY_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = HELP_OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Voice command help');
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      background: '#1a1a2e',
      color: '#e0e0e0',
      borderRadius: '12px',
      padding: '24px 32px',
      zIndex: '2147483647',
      maxHeight: '80vh',
      maxWidth: '480px',
      width: '90vw',
      overflowY: 'auto',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '14px',
      lineHeight: '1.6',
    } as Partial<CSSStyleDeclaration>);

    const title = document.createElement('h2');
    title.textContent = 'Voice Commands';
    Object.assign(title.style, {
      margin: '0 0 16px 0',
      fontSize: '18px',
      color: '#7b68ee',
      borderBottom: '1px solid #333',
      paddingBottom: '8px',
    } as Partial<CSSStyleDeclaration>);
    overlay.appendChild(title);

    const list = document.createElement('dl');
    Object.assign(list.style, {
      margin: '0',
      padding: '0',
    } as Partial<CSSStyleDeclaration>);

    for (const [cmd, desc] of HELP_COMMANDS) {
      const dt = document.createElement('dt');
      dt.textContent = `"${cmd}"`;
      Object.assign(dt.style, {
        fontWeight: '600',
        color: '#bb86fc',
        marginTop: '8px',
      } as Partial<CSSStyleDeclaration>);

      const dd = document.createElement('dd');
      dd.textContent = desc;
      Object.assign(dd.style, {
        margin: '0 0 4px 16px',
        color: '#aaa',
      } as Partial<CSSStyleDeclaration>);

      list.appendChild(dt);
      list.appendChild(dd);
    }

    overlay.appendChild(list);

    const hint = document.createElement('p');
    hint.textContent = 'Say "help" again or click anywhere outside to close.';
    Object.assign(hint.style, {
      marginTop: '16px',
      fontSize: '12px',
      color: '#666',
      textAlign: 'center',
    } as Partial<CSSStyleDeclaration>);
    overlay.appendChild(hint);

    // Close on outside click
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.4)',
      zIndex: '2147483646',
    } as Partial<CSSStyleDeclaration>);
    backdrop.addEventListener('click', () => this.hideHelp());

    document.body.appendChild(backdrop);
    document.body.appendChild(overlay);
    this.helpOverlayEl = overlay;
    (overlay as any)._backdrop = backdrop;
  }

  private hideHelp(): void {
    if (!this.helpOverlayEl) return;
    const backdrop = (this.helpOverlayEl as any)._backdrop as HTMLElement | undefined;
    backdrop?.remove();
    this.helpOverlayEl.remove();
    this.helpOverlayEl = null;
  }

  // ---------- Floating indicator ----------

  private showIndicator(): void {
    if (document.getElementById(INDICATOR_ID)) return;

    const el = document.createElement('div');
    el.id = INDICATOR_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-label', 'Voice commands active');
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      width: '48px',
      height: '48px',
      borderRadius: '50%',
      background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '2147483645',
      cursor: 'pointer',
      boxShadow: '0 4px 16px rgba(123, 104, 238, 0.4)',
      transition: 'transform 0.2s ease',
      animation: 'a11y-pulse 2s infinite',
    } as Partial<CSSStyleDeclaration>);

    // Microphone SVG icon
    el.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
           xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"
              fill="#fff"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="#fff" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="12" y1="19" x2="12" y2="23" stroke="#fff" stroke-width="2"
              stroke-linecap="round"/>
        <line x1="8" y1="23" x2="16" y2="23" stroke="#fff" stroke-width="2"
              stroke-linecap="round"/>
      </svg>`;

    el.title = 'Voice commands active – click to stop';
    el.addEventListener('click', () => this.stop());

    // Inject pulse animation if not yet present
    if (!document.getElementById('a11y-voice-keyframes')) {
      const style = document.createElement('style');
      style.id = 'a11y-voice-keyframes';
      style.textContent = `
        @keyframes a11y-pulse {
          0%, 100% { box-shadow: 0 4px 16px rgba(123, 104, 238, 0.4); }
          50% { box-shadow: 0 4px 24px rgba(123, 104, 238, 0.7); }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(el);
    this.indicatorEl = el;
  }

  private hideIndicator(): void {
    this.indicatorEl?.remove();
    this.indicatorEl = null;
  }

  // ---------- Utility helpers ----------

  /** Flash a highlight ring around an element. */
  private flashHighlight(el: HTMLElement, duration = 1500): void {
    const original = el.style.outline;
    el.style.outline = '3px solid #7b68ee';
    el.style.outlineOffset = '2px';

    const timeout = setTimeout(() => {
      el.style.outline = original;
      el.style.outlineOffset = '';
      this.highlights = this.highlights.filter((h) => h.element !== el);
    }, duration);

    this.highlights.push({ originalOutline: original, element: el, timeout });
  }

  /** Clear all active highlights. */
  private clearHighlights(): void {
    for (const h of this.highlights) {
      clearTimeout(h.timeout);
      h.element.style.outline = h.originalOutline;
      h.element.style.outlineOffset = '';
    }
    this.highlights = [];
  }

  /** Check whether an element is visible in the viewport. */
  private isElementVisible(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;

    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight
    );
  }

  /** Send a message to the Chrome extension background script. */
  private sendToBackground(message: Record<string, string>): void {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(message);
      } else {
        this.opts.onError(
          'Chrome extension API not available. Tab commands require the extension context.',
        );
      }
    } catch (err) {
      this.opts.onError(
        `Failed to send message to background: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
