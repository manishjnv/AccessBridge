/**
 * TransliterationController — DOM-facing wrapper around the pure
 * transliteration engine in @accessbridge/core/i18n.
 *
 * Behavior:
 *   - Alt+T toggles transliteration mode on/off.
 *   - While active and a text-editable field is focused, intercept
 *     `beforeinput` events and rewrite the field's value as the user
 *     types Latin characters — emitting Devanagari / Tamil / Telugu /
 *     Kannada script.
 *   - A floating pill in the bottom-left shows the target script.
 */

import {
  transliterate,
  getRulesForScript,
  type TransliterationScript,
} from '@accessbridge/core/i18n/transliteration-rules.js';

const INDICATOR_ID = 'a11y-translit-indicator';
const ALLOWED_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', ''] as const;

const SCRIPT_LABELS: Record<TransliterationScript, string> = {
  devanagari: 'देवनागरी',
  tamil: 'தமிழ்',
  telugu: 'తెలుగు',
  kannada: 'ಕನ್ನಡ',
};

interface InputEventWithType extends Event {
  readonly inputType: string;
  readonly data: string | null;
}

type EditableTarget = HTMLInputElement | HTMLTextAreaElement;

export class TransliterationController {
  private active = false;
  private script: TransliterationScript;
  private indicatorEl: HTMLElement | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private beforeInputHandler: ((e: Event) => void) | null = null;
  private readonly buffers: WeakMap<Element, string> = new WeakMap();

  constructor(script: TransliterationScript = 'devanagari') {
    this.script = script;
  }

  start(): void {
    if (this.keydownHandler) return;

    this.keydownHandler = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() !== 't') return;
      e.preventDefault();
      this.toggle();
    };

    this.beforeInputHandler = (e: Event) => {
      if (!this.active) return;
      this.handleBeforeInput(e as InputEventWithType);
    };

    document.addEventListener('keydown', this.keydownHandler, true);
    document.addEventListener('beforeinput', this.beforeInputHandler, true);
  }

  stop(): void {
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler, true);
      this.keydownHandler = null;
    }
    if (this.beforeInputHandler) {
      document.removeEventListener('beforeinput', this.beforeInputHandler, true);
      this.beforeInputHandler = null;
    }
    this.active = false;
    this.hideIndicator();
  }

  isActive(): boolean {
    return this.active;
  }

  setScript(script: TransliterationScript): void {
    this.script = script;
    if (this.active) this.showIndicator();
  }

  // ---------------- Internals ----------------

  private toggle(): void {
    this.active = !this.active;
    if (this.active) this.showIndicator();
    else this.hideIndicator();
  }

  private handleBeforeInput(e: InputEventWithType): void {
    const target = e.target;
    if (!this.isEditable(target)) return;

    const buf = this.buffers.get(target) ?? '';
    const inputType = e.inputType;
    const data = e.data ?? '';

    let next: string | null = null;
    if (inputType === 'insertText') {
      next = buf + data;
    } else if (inputType === 'insertFromPaste') {
      next = buf + data;
    } else if (inputType === 'deleteContentBackward') {
      next = buf.slice(0, -1);
    } else if (inputType === 'deleteContentForward') {
      // No buffer model for mid-string deletes — clear to avoid drift
      next = '';
    }

    if (next === null) return;

    e.preventDefault();
    this.buffers.set(target, next);

    const rules = getRulesForScript(this.script);
    const rendered = transliterate(next, rules);

    this.setEditableValue(target, rendered);
  }

  private isEditable(node: EventTarget | null): node is EditableTarget {
    if (node instanceof HTMLInputElement) {
      const t = node.type ?? '';
      return (ALLOWED_INPUT_TYPES as readonly string[]).includes(t);
    }
    return node instanceof HTMLTextAreaElement;
  }

  private setEditableValue(target: EditableTarget, value: string): void {
    target.value = value;
    const end = value.length;
    try {
      target.setSelectionRange(end, end);
    } catch {
      // Some input types (email, url) throw on setSelectionRange — ignore.
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private showIndicator(): void {
    this.hideIndicator();
    const el = document.createElement('div');
    el.id = INDICATOR_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-label', `Transliteration active: ${SCRIPT_LABELS[this.script]}`);
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '20px',
      left: '20px',
      padding: '8px 14px',
      borderRadius: '999px',
      background: 'linear-gradient(135deg, #7b68ee, #bb86fc)',
      color: 'white',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px',
      fontWeight: '600',
      boxShadow: '0 4px 16px rgba(123, 104, 238, 0.4)',
      zIndex: '2147483644',
      pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>);
    el.textContent = `TL: ${SCRIPT_LABELS[this.script]}`;
    document.body.appendChild(el);
    this.indicatorEl = el;
  }

  private hideIndicator(): void {
    this.indicatorEl?.remove();
    this.indicatorEl = null;
  }
}
