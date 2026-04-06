/**
 * PredictiveInputSystem – word prediction and auto-completion for motor-impaired
 * users who have difficulty typing.
 *
 * Monitors input/textarea/contenteditable elements and shows a floating
 * suggestion panel with 3-5 word predictions. Users accept suggestions via
 * Alt+1..Alt+5 or Tab (first suggestion).
 *
 * Features:
 * - Frequency-based word prediction with ~500 common English words
 * - Session learning: words the user types are added to the dictionary
 * - Common phrase completion ("thank you", "please find", etc.)
 * - Form field intelligence: detects email/phone/address/name fields
 * - Works on contenteditable elements (Gmail compose, etc.)
 */

// ---------------------------------------------------------------------------
// Common English words dictionary (~500 words)
// ---------------------------------------------------------------------------

const COMMON_WORDS: string[] = [
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
  'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
  'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
  'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',
  'great', 'between', 'need', 'large', 'let', 'here', 'right', 'still', 'own', 'point',
  'provide', 'through', 'high', 'each', 'follow', 'act', 'why', 'ask', 'men', 'change',
  'went', 'light', 'kind', 'off', 'always', 'next', 'place', 'where', 'after', 'back',
  'little', 'only', 'round', 'man', 'year', 'came', 'show', 'every', 'name', 'just',
  'form', 'sentence', 'set', 'three', 'state', 'move', 'help', 'home', 'hand', 'keep',
  'school', 'never', 'begin', 'while', 'last', 'very', 'read', 'long', 'make', 'thing',
  'number', 'already', 'been', 'call', 'find', 'water', 'more', 'write', 'word', 'may',
  'down', 'side', 'such', 'turn', 'start', 'might', 'story', 'far', 'head', 'play',
  'spell', 'add', 'food', 'try', 'much', 'before', 'line', 'right', 'too', 'mean',
  'old', 'world', 'same', 'tell', 'does', 'thought', 'end', 'girl', 'city', 'close',
  'open', 'small', 'life', 'must', 'under', 'near', 'along', 'left', 'few', 'while',
  'company', 'service', 'group', 'problem', 'since', 'important', 'country', 'family', 'program', 'question',
  'during', 'another', 'part', 'system', 'government', 'information', 'community', 'available', 'possible', 'national',
  'different', 'support', 'development', 'business', 'research', 'market', 'within', 'local', 'second', 'public',
  'experience', 'general', 'report', 'member', 'including', 'further', 'political', 'management', 'meeting', 'area',
  'project', 'education', 'office', 'process', 'number', 'level', 'example', 'social', 'result', 'interest',
  'order', 'power', 'again', 'data', 'money', 'until', 'both', 'children', 'health', 'real',
  'using', 'working', 'today', 'looking', 'something', 'nothing', 'morning', 'evening', 'afternoon', 'please',
  'thank', 'sorry', 'hello', 'goodbye', 'welcome', 'thanks', 'yes', 'maybe', 'really', 'actually',
  'however', 'although', 'therefore', 'because', 'especially', 'probably', 'usually', 'recently', 'finally', 'certainly',
  'absolutely', 'immediately', 'unfortunately', 'sincerely', 'regards', 'appreciate', 'forward', 'attached', 'regarding', 'meeting',
  'schedule', 'review', 'update', 'confirm', 'submit', 'request', 'response', 'complete', 'address', 'email',
  'phone', 'message', 'document', 'following', 'additional', 'current', 'previous', 'available', 'required', 'please',
  'would', 'could', 'should', 'might', 'shall', 'cannot', 'does', 'did', 'has', 'had',
  'been', 'being', 'having', 'doing', 'going', 'coming', 'taking', 'making', 'getting', 'seeing',
  'knowing', 'thinking', 'wanting', 'looking', 'giving', 'using', 'finding', 'telling', 'asking', 'working',
  'trying', 'needing', 'feeling', 'leaving', 'putting', 'keeping', 'beginning', 'showing', 'hearing', 'playing',
  'running', 'moving', 'living', 'believing', 'bringing', 'happening', 'writing', 'sitting', 'standing', 'learning',
  'understanding', 'following', 'creating', 'speaking', 'reading', 'allowing', 'adding', 'spending', 'growing', 'opening',
  'walking', 'winning', 'offering', 'remembering', 'considering', 'appearing', 'buying', 'waiting', 'serving', 'sending',
  'building', 'staying', 'falling', 'cutting', 'reaching', 'killing', 'remaining', 'suggesting', 'raising', 'passing',
  'selling', 'meeting', 'continuing', 'setting', 'paying', 'receiving', 'including', 'turning', 'watching', 'holding',
  'pointing', 'developing', 'changing', 'returning', 'starting', 'planning', 'talking', 'calling', 'pulling', 'leading',
  'enjoying', 'closing', 'becoming', 'driving', 'preparing', 'expecting', 'picking', 'carrying', 'producing', 'breaking',
  'tomorrow', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
];

// ---------------------------------------------------------------------------
// Common phrases for auto-completion
// ---------------------------------------------------------------------------

const COMMON_PHRASES: [string, string][] = [
  ['thank y', 'thank you'],
  ['thank you v', 'thank you very much'],
  ['thank you for', 'thank you for your'],
  ['thank you for your h', 'thank you for your help'],
  ['thank you for your t', 'thank you for your time'],
  ['please f', 'please find'],
  ['please find a', 'please find attached'],
  ['please let', 'please let me know'],
  ['please let me k', 'please let me know'],
  ['i would l', 'i would like'],
  ['i would like t', 'i would like to'],
  ['i am w', 'i am writing'],
  ['i am writing t', 'i am writing to'],
  ['looking f', 'looking forward'],
  ['looking forward t', 'looking forward to'],
  ['looking forward to h', 'looking forward to hearing'],
  ['looking forward to hearing f', 'looking forward to hearing from you'],
  ['as per', 'as per our'],
  ['as per our c', 'as per our conversation'],
  ['as per our d', 'as per our discussion'],
  ['best r', 'best regards'],
  ['kind r', 'kind regards'],
  ['with r', 'with regards'],
  ['with regards t', 'with regards to'],
  ['in r', 'in regards'],
  ['in regards t', 'in regards to'],
  ['for your r', 'for your reference'],
  ['for your i', 'for your information'],
  ['at your e', 'at your earliest convenience'],
  ['at your earliest c', 'at your earliest convenience'],
  ['could you p', 'could you please'],
  ['would you p', 'would you please'],
  ['i hope t', 'i hope this'],
  ['i hope this f', 'i hope this finds'],
  ['i hope this finds you w', 'i hope this finds you well'],
  ['i hope this e', 'i hope this email finds you well'],
  ['good m', 'good morning'],
  ['good a', 'good afternoon'],
  ['good e', 'good evening'],
  ['have a g', 'have a great'],
  ['have a great d', 'have a great day'],
  ['nice to m', 'nice to meet you'],
  ['how are y', 'how are you'],
  ['see you s', 'see you soon'],
  ['on behalf o', 'on behalf of'],
  ['in addition t', 'in addition to'],
  ['with respect t', 'with respect to'],
  ['as soon as p', 'as soon as possible'],
];

// ---------------------------------------------------------------------------
// Form field suggestions
// ---------------------------------------------------------------------------

interface FieldSuggestions {
  type: string;
  suggestions: string[];
}

const FIELD_TYPE_SUGGESTIONS: FieldSuggestions[] = [
  {
    type: 'email',
    suggestions: ['@gmail.com', '@outlook.com', '@yahoo.com', '@hotmail.com', '@company.com'],
  },
  {
    type: 'phone',
    suggestions: ['+1', '+91', '+44', '+61', '+86'],
  },
  {
    type: 'name',
    suggestions: [],
  },
  {
    type: 'address',
    suggestions: ['Street', 'Avenue', 'Boulevard', 'Drive', 'Road', 'Lane', 'Court', 'Place'],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect field type from input attributes and labels. */
function detectFieldType(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase();

  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = input.type?.toLowerCase() ?? '';
    const name = (input.name ?? '').toLowerCase();
    const placeholder = (input.placeholder ?? '').toLowerCase();
    const autocomplete = (input.autocomplete ?? '').toLowerCase();

    if (type === 'email' || name.includes('email') || placeholder.includes('email') || autocomplete.includes('email')) return 'email';
    if (type === 'tel' || name.includes('phone') || name.includes('tel') || placeholder.includes('phone') || autocomplete.includes('tel')) return 'phone';
    if (name.includes('name') || placeholder.includes('name') || autocomplete.includes('name')) return 'name';
    if (name.includes('address') || name.includes('street') || name.includes('city') || placeholder.includes('address') || autocomplete.includes('address')) return 'address';
  }

  // Check associated label
  const id = el.id;
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) {
      const labelText = (label.textContent ?? '').toLowerCase();
      if (labelText.includes('email')) return 'email';
      if (labelText.includes('phone') || labelText.includes('tel')) return 'phone';
      if (labelText.includes('name')) return 'name';
      if (labelText.includes('address') || labelText.includes('street')) return 'address';
    }
  }

  // Check aria-label
  const ariaLabel = (el.getAttribute('aria-label') ?? '').toLowerCase();
  if (ariaLabel.includes('email')) return 'email';
  if (ariaLabel.includes('phone')) return 'phone';
  if (ariaLabel.includes('name')) return 'name';
  if (ariaLabel.includes('address')) return 'address';

  return null;
}

/** Get the current word being typed (partial word before cursor). */
function getCurrentWord(text: string): string {
  const trimmed = text.trimEnd();
  // If the text ends with a space, no partial word
  if (text.length > 0 && text[text.length - 1] === ' ') return '';
  const lastSpace = trimmed.lastIndexOf(' ');
  return lastSpace === -1 ? trimmed : trimmed.slice(lastSpace + 1);
}

/** Get the text before cursor in a contenteditable element. */
function getContentEditableText(el: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString();
}

/** Insert text into a contenteditable element, replacing partial word. */
function insertIntoContentEditable(el: HTMLElement, word: string, partialLen: number): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);

  // Delete the partial word
  if (partialLen > 0) {
    const deleteRange = range.cloneRange();
    deleteRange.setStart(range.startContainer, Math.max(0, range.startOffset - partialLen));
    deleteRange.setEnd(range.startContainer, range.startOffset);
    deleteRange.deleteContents();
  }

  // Insert the completion + space
  const textNode = document.createTextNode(word + ' ');
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);

  // Trigger input event
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// CSS class names
// ---------------------------------------------------------------------------

const CSS = {
  PANEL: 'ab-predict-panel',
  ITEM: 'ab-predict-item',
  ITEM_ACTIVE: 'ab-predict-item-active',
  KEY: 'ab-predict-key',
  LABEL: 'ab-predict-label',
  PHRASE: 'ab-predict-phrase',
} as const;

// ---------------------------------------------------------------------------
// PredictiveInputSystem
// ---------------------------------------------------------------------------

export class PredictiveInputSystem {
  private active = false;

  /** Session-learned words with frequency counts. */
  private sessionWords: Map<string, number> = new Map();

  /** Base dictionary frequency map. */
  private dictFrequency: Map<string, number> = new Map();

  /** The floating suggestion panel element. */
  private panelEl: HTMLElement | null = null;

  /** The currently focused input element. */
  private currentTarget: HTMLElement | null = null;

  /** Currently displayed suggestions. */
  private suggestions: string[] = [];

  // Bound listeners for clean removal
  private readonly onFocusIn: (e: FocusEvent) => void;
  private readonly onFocusOut: (e: FocusEvent) => void;
  private readonly onInput: (e: Event) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onScroll: () => void;

  /** Debounce timer for input processing. */
  private inputTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.onFocusIn = this.handleFocusIn.bind(this);
    this.onFocusOut = this.handleFocusOut.bind(this);
    this.onInput = this.handleInput.bind(this);
    this.onKeyDown = this.handleKeyDown.bind(this);
    this.onScroll = this.handleScroll.bind(this);

    // Build frequency map from the common words list
    for (let i = 0; i < COMMON_WORDS.length; i++) {
      const word = COMMON_WORDS[i].toLowerCase();
      // Higher frequency for words appearing earlier in the list
      const freq = COMMON_WORDS.length - i;
      const existing = this.dictFrequency.get(word) ?? 0;
      if (freq > existing) {
        this.dictFrequency.set(word, freq);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.active) return;
    this.active = true;

    document.addEventListener('focusin', this.onFocusIn, true);
    document.addEventListener('focusout', this.onFocusOut, true);
    document.addEventListener('input', this.onInput, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;

    document.removeEventListener('focusin', this.onFocusIn, true);
    document.removeEventListener('focusout', this.onFocusOut, true);
    document.removeEventListener('input', this.onInput, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('scroll', this.onScroll, true);

    this.hidePanel();
    this.currentTarget = null;

    if (this.inputTimer !== null) {
      clearTimeout(this.inputTimer);
      this.inputTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private handleFocusIn(e: FocusEvent): void {
    const target = e.target as HTMLElement;
    if (this.isTextInput(target)) {
      this.currentTarget = target;
    }
  }

  private handleFocusOut(_e: FocusEvent): void {
    // Delay hide to allow click on suggestion panel
    setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && this.panelEl?.contains(active)) return;
      this.hidePanel();
      this.currentTarget = null;
    }, 150);
  }

  private handleInput(e: Event): void {
    const target = e.target as HTMLElement;
    if (!this.isTextInput(target)) return;

    this.currentTarget = target;

    // Debounce input processing
    if (this.inputTimer !== null) {
      clearTimeout(this.inputTimer);
    }
    this.inputTimer = setTimeout(() => {
      this.processInput(target);
    }, 80);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.panelEl || this.suggestions.length === 0) return;

    // Tab accepts the first suggestion
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.acceptSuggestion(0);
      return;
    }

    // Alt+1 through Alt+5 accept specific suggestions
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 5 && num <= this.suggestions.length) {
        e.preventDefault();
        e.stopPropagation();
        this.acceptSuggestion(num - 1);
        return;
      }
    }

    // Escape hides the panel
    if (e.key === 'Escape') {
      this.hidePanel();
    }
  }

  private handleScroll(): void {
    if (this.panelEl && this.currentTarget) {
      this.positionPanel(this.currentTarget);
    }
  }

  // ---------------------------------------------------------------------------
  // Input processing and prediction
  // ---------------------------------------------------------------------------

  private processInput(target: HTMLElement): void {
    const text = this.getTextBeforeCursor(target);
    if (!text) {
      this.hidePanel();
      return;
    }

    // Learn completed words from session
    this.learnFromText(text);

    const suggestions = this.generateSuggestions(text, target);
    if (suggestions.length === 0) {
      this.hidePanel();
      return;
    }

    this.suggestions = suggestions;
    this.showPanel(target, suggestions);
  }

  private generateSuggestions(text: string, target: HTMLElement): string[] {
    const results: string[] = [];

    // 1. Check for phrase completions first
    const lowerText = text.toLowerCase();
    const lastChunk = this.getRecentText(lowerText, 60);
    for (const [prefix, completion] of COMMON_PHRASES) {
      if (lastChunk.endsWith(prefix)) {
        // The completion replaces the prefix portion
        results.push(completion);
        if (results.length >= 2) break;
      }
    }

    // 2. Form field type suggestions
    const fieldType = detectFieldType(target);
    if (fieldType) {
      const fieldConfig = FIELD_TYPE_SUGGESTIONS.find(f => f.type === fieldType);
      if (fieldConfig) {
        const partial = getCurrentWord(text).toLowerCase();
        for (const suggestion of fieldConfig.suggestions) {
          if (suggestion.toLowerCase().startsWith(partial) && suggestion.toLowerCase() !== partial) {
            // For email domain suggestions, check if we have an @ sign
            if (fieldType === 'email') {
              if (text.includes('@')) {
                const afterAt = text.slice(text.lastIndexOf('@'));
                if (suggestion.startsWith(afterAt) || afterAt.length <= 1) {
                  results.push(suggestion);
                }
              }
            } else {
              results.push(suggestion);
            }
          }
          if (results.length >= 5) break;
        }
      }
    }

    // 3. Word predictions based on partial input
    const currentWord = getCurrentWord(text).toLowerCase();
    if (currentWord.length >= 1) {
      const wordScores: { word: string; score: number }[] = [];

      // Check session words first (higher priority)
      for (const [word, freq] of this.sessionWords) {
        if (word.startsWith(currentWord) && word !== currentWord) {
          wordScores.push({ word, score: freq * 10 }); // boost session words
        }
      }

      // Check dictionary
      for (const [word, freq] of this.dictFrequency) {
        if (word.startsWith(currentWord) && word !== currentWord) {
          // Skip if already from session
          if (!wordScores.find(s => s.word === word)) {
            wordScores.push({ word, score: freq });
          }
        }
      }

      // Sort by score descending
      wordScores.sort((a, b) => b.score - a.score);

      // Add top predictions, avoiding duplicates with phrase results
      for (const { word } of wordScores) {
        if (!results.includes(word) && results.length < 5) {
          results.push(word);
        }
      }
    }

    return results.slice(0, 5);
  }

  private learnFromText(text: string): void {
    // Extract completed words (not the current partial word)
    const words = text.trim().split(/\s+/);
    // Only learn words that appear to be complete (not the last one being typed)
    for (let i = 0; i < words.length - 1; i++) {
      const word = words[i].toLowerCase().replace(/[^a-z'-]/g, '');
      if (word.length >= 2) {
        const current = this.sessionWords.get(word) ?? 0;
        this.sessionWords.set(word, current + 1);
      }
    }
  }

  private getRecentText(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(-maxLen) : text;
  }

  // ---------------------------------------------------------------------------
  // Suggestion acceptance
  // ---------------------------------------------------------------------------

  private acceptSuggestion(index: number): void {
    if (index >= this.suggestions.length || !this.currentTarget) return;

    const suggestion = this.suggestions[index];
    const target = this.currentTarget;
    const text = this.getTextBeforeCursor(target);
    const currentWord = getCurrentWord(text);

    // Check if this is a phrase completion
    const lowerText = text.toLowerCase();
    const lastChunk = this.getRecentText(lowerText, 60);
    let phraseMatch: [string, string] | null = null;
    for (const [prefix, completion] of COMMON_PHRASES) {
      if (lastChunk.endsWith(prefix) && completion === suggestion) {
        phraseMatch = [prefix, completion];
        break;
      }
    }

    if (phraseMatch) {
      this.insertPhrase(target, phraseMatch[0], phraseMatch[1]);
    } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      this.insertIntoStandardInput(target, suggestion, currentWord.length);
    } else if (target.getAttribute('contenteditable') !== null) {
      insertIntoContentEditable(target, suggestion, currentWord.length);
    }

    // Learn the accepted word
    const word = suggestion.toLowerCase().replace(/[^a-z'-]/g, '');
    if (word.length >= 2) {
      const current = this.sessionWords.get(word) ?? 0;
      this.sessionWords.set(word, current + 3); // boost accepted words
    }

    this.hidePanel();
  }

  private insertIntoStandardInput(
    el: HTMLInputElement | HTMLTextAreaElement,
    word: string,
    partialLen: number,
  ): void {
    const start = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, start - partialLen);
    const after = el.value.slice(start);
    el.value = before + word + ' ' + after;
    const newPos = before.length + word.length + 1;
    el.setSelectionRange(newPos, newPos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private insertPhrase(target: HTMLElement, prefix: string, completion: string): void {
    // Replace the prefix portion with the full phrase
    const prefixLen = prefix.length;
    const suffixToAdd = completion.slice(prefixLen);

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length;
      const before = target.value.slice(0, start);
      const after = target.value.slice(start);
      target.value = before + suffixToAdd + ' ' + after;
      const newPos = start + suffixToAdd.length + 1;
      target.setSelectionRange(newPos, newPos);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (target.getAttribute('contenteditable') !== null) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const textNode = document.createTextNode(suffixToAdd + ' ');
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ---------------------------------------------------------------------------
  // Text extraction helpers
  // ---------------------------------------------------------------------------

  private getTextBeforeCursor(el: HTMLElement): string {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const pos = el.selectionStart ?? el.value.length;
      return el.value.slice(0, pos);
    }
    if (el.getAttribute('contenteditable') !== null) {
      return getContentEditableText(el);
    }
    return '';
  }

  private isTextInput(el: HTMLElement): boolean {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
      const type = (el.type ?? 'text').toLowerCase();
      return ['text', 'search', 'url', 'email', 'tel'].includes(type);
    }
    if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Panel UI
  // ---------------------------------------------------------------------------

  private showPanel(target: HTMLElement, suggestions: string[]): void {
    if (!this.panelEl) {
      this.createPanel();
    }
    const panel = this.panelEl!;

    // Populate suggestions
    panel.innerHTML = '';
    const text = this.getTextBeforeCursor(target);
    const lowerText = text.toLowerCase();
    const lastChunk = this.getRecentText(lowerText, 60);

    suggestions.forEach((suggestion, i) => {
      const item = document.createElement('div');
      item.className = CSS.ITEM;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');

      const key = document.createElement('span');
      key.className = CSS.KEY;
      key.textContent = i === 0 ? 'Tab' : `Alt+${i + 1}`;

      const label = document.createElement('span');
      label.className = CSS.LABEL;

      // Check if this is a phrase completion
      let isPhrase = false;
      for (const [prefix, completion] of COMMON_PHRASES) {
        if (lastChunk.endsWith(prefix) && completion === suggestion) {
          isPhrase = true;
          break;
        }
      }

      if (isPhrase) {
        label.textContent = suggestion;
        const badge = document.createElement('span');
        badge.className = CSS.PHRASE;
        badge.textContent = 'phrase';
        label.appendChild(badge);
      } else {
        label.textContent = suggestion;
      }

      item.appendChild(key);
      item.appendChild(label);

      // Click to accept
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.acceptSuggestion(i);
      });

      panel.appendChild(item);
    });

    this.positionPanel(target);
    panel.style.display = 'block';
    panel.setAttribute('aria-expanded', 'true');
  }

  private hidePanel(): void {
    if (this.panelEl) {
      this.panelEl.style.display = 'none';
      this.panelEl.setAttribute('aria-expanded', 'false');
    }
    this.suggestions = [];
  }

  private createPanel(): void {
    const panel = document.createElement('div');
    panel.id = 'ab-predict-panel';
    panel.className = CSS.PANEL;
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', 'Word predictions');
    panel.setAttribute('aria-expanded', 'false');
    panel.style.display = 'none';
    document.body.appendChild(panel);
    this.panelEl = panel;
  }

  private positionPanel(target: HTMLElement): void {
    if (!this.panelEl) return;

    const rect = target.getBoundingClientRect();
    const panelHeight = this.panelEl.offsetHeight || 180;
    const viewportHeight = window.innerHeight;

    let top: number;
    let left: number;

    // Position below the input by default; above if not enough space
    if (rect.bottom + panelHeight + 8 > viewportHeight) {
      top = rect.top - panelHeight - 4;
    } else {
      top = rect.bottom + 4;
    }

    left = rect.left;

    // Clamp to viewport
    const panelWidth = 280;
    if (left + panelWidth > window.innerWidth) {
      left = window.innerWidth - panelWidth - 8;
    }
    if (left < 4) left = 4;
    if (top < 4) top = 4;

    this.panelEl.style.top = `${top}px`;
    this.panelEl.style.left = `${left}px`;
  }

  private removePanel(): void {
    this.panelEl?.remove();
    this.panelEl = null;
  }
}
