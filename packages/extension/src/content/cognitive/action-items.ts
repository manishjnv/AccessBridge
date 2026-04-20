// --- Priority 1: Captions + Actions ---
/**
 * ActionItemsExtractor — scans page text for actionable items
 * (imperative verbs, task markers, deadlines) and reports them.
 */

export interface ActionItem {
  id: string;
  text: string;
  source: string;
  priority: 'high' | 'medium' | 'low';
  dueDate: string | null;
  sourceUrl: string;
  timestamp: number;
  /** Optional: extracted assignee mention (e.g. "@jane", "Bob"). Set by extract() when an @-mention or "Name to X" pattern is detected. */
  assignee?: string;
  /** Optional: 0-1 confidence score. Higher = stronger signal. Populated by extract() and AI second pass. */
  confidence?: number;
  /** Optional: detected context of the source page. */
  context?: 'email' | 'meeting' | 'doc' | 'generic';
}

// ── Constants ─────────────────────────────────────────────────────────────────

const IMPERATIVE_VERBS = [
  'Send', 'Review', 'Complete', 'Submit', 'Schedule', 'Call', 'Email',
  'Prepare', 'Update', 'Check', 'Confirm', 'Reply', 'Follow up', 'Please',
  'Draft', 'Approve', 'Sign', 'Finalize', 'Investigate', 'Fix',
];

const MARKERS = [
  '[ ]', '[]', 'TODO', 'FIXME', 'Action:', 'AI:', 'Action Item:',
  '@me', 'assigned to you', '#action',
];

const URGENT_KEYWORDS = ['urgent', 'asap', 'high priority', 'today', 'immediately'];

const DEADLINE_PATTERNS: RegExp[] = [
  /\bby\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun|today|tomorrow|EOD|EOW|end of day|end of week|\d{1,2}(?:st|nd|rd|th)?\s+\w+|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i,
  /\bbefore\s+\d{1,2}(?::\d{2})?\s?(?:am|pm)?\b/i,
  /\bnext\s+(?:week|month|Monday|Tuesday|Wednesday|Thursday|Friday)\b/i,
];

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NAV', 'NOSCRIPT', 'TEMPLATE', 'META']);
const SKIP_CLASSES = ['ab-action-items-panel', 'ab-action-fab', 'ab-captions-overlay', 'ab-domain-tooltip'];
const BLOCK_TAGS = new Set(['P', 'LI', 'TD', 'DIV', 'ARTICLE', 'SECTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);
const WATCHABLE_TAGS = new Set(['DIV', 'P', 'LI', 'TD', 'ARTICLE', 'SECTION']);

// ── Context detection ─────────────────────────────────────────────────────────

export type ActionContext = 'email' | 'meeting' | 'doc' | 'generic';

const EMAIL_HOSTS = [/mail\.google\.com/, /outlook\./, /mail\.yahoo/, /protonmail/];
const DOC_HOSTS = [/docs\.google\.com/, /office\.com/, /onedrive/, /notion\.so/, /confluence/, /coda\.io/];
const MEETING_HOSTS = [/teams\.microsoft/, /zoom\.us/, /meet\.google/, /slack\.com/, /discord/];

export function detectContext(href?: string): ActionContext {
  const url = href ?? (typeof location !== 'undefined' ? location.href : '');
  if (EMAIL_HOSTS.some((r) => r.test(url))) return 'email';
  if (DOC_HOSTS.some((r) => r.test(url))) return 'doc';
  if (MEETING_HOSTS.some((r) => r.test(url))) return 'meeting';
  return 'generic';
}

// ── Assignee extraction ──────────────────────────────────────────────────────

const VERBS_RE = IMPERATIVE_VERBS
  .map((v) => v.replace(/\s+/g, '\\s+'))
  .join('|');
const NAME_TO_VERB_RE = new RegExp(`^([A-Z][a-z]{1,20})\\s+to\\s+(?:${VERBS_RE})\\b`, 'i');

function extractAssignee(text: string): string | undefined {
  const atMatch = text.match(/@([A-Za-z][A-Za-z0-9._-]{1,30})/);
  if (atMatch) return '@' + atMatch[1];
  const ntv = text.match(NAME_TO_VERB_RE);
  if (ntv) return ntv[1];
  return undefined;
}

// ── Confidence scoring ───────────────────────────────────────────────────────

function computeConfidence(opts: {
  hasMarker: boolean;
  hasImperative: boolean;
  hasDeadline: boolean;
  hasUrgency: boolean;
  hasAssignee: boolean;
}): number {
  let score = 0.25;
  if (opts.hasMarker) score += 0.45;
  if (opts.hasImperative) score += 0.3;
  if (opts.hasDeadline) score += 0.15;
  if (opts.hasUrgency) score += 0.1;
  if (opts.hasAssignee) score += 0.1;
  return Math.min(score, 1);
}

// ── Sentence split for standalone extract() ──────────────────────────────────

function splitIntoCandidates(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── djb2 hash (no crypto) ─────────────────────────────────────────────────────

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep as 32-bit unsigned
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8);
}

// ── Normalize text for deduplication ─────────────────────────────────────────

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:'"]+$/g, '').trim();
}

// ── Priority detection ────────────────────────────────────────────────────────

function detectPriority(text: string, hasDeadline: boolean): ActionItem['priority'] {
  const lower = text.toLowerCase();
  if (URGENT_KEYWORDS.some((kw) => lower.includes(kw))) return 'high';
  if (hasDeadline) return 'medium';
  return 'low';
}

// ── Deadline extraction ───────────────────────────────────────────────────────

function extractDeadline(text: string): string | null {
  for (const pattern of DEADLINE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

// ── Skip check ────────────────────────────────────────────────────────────────

function shouldSkipElement(el: Element): boolean {
  // Check tag
  if (SKIP_TAGS.has(el.tagName)) return true;
  // Check class
  for (const cls of SKIP_CLASSES) {
    if (el.classList.contains(cls)) return true;
  }
  // Check ancestors
  let node: Element | null = el.parentElement;
  while (node) {
    if (SKIP_TAGS.has(node.tagName)) return true;
    for (const cls of SKIP_CLASSES) {
      if (node.classList.contains(cls)) return true;
    }
    node = node.parentElement;
  }
  return false;
}

// ── Match detection ───────────────────────────────────────────────────────────

function matchesActionItem(text: string): boolean {
  if (!text || text.length < 10 || text.length > 300) {
    // Markers don't need length constraint
    if (MARKERS.some((m) => text.includes(m))) return true;
    return false;
  }

  // Check imperative verb at start
  const firstWord = text.split(/\s+/)[0] ?? '';
  if (IMPERATIVE_VERBS.some((v) => {
    // Multi-word verbs like "Follow up"
    if (v.includes(' ')) return text.startsWith(v);
    return firstWord.toLowerCase() === v.toLowerCase();
  })) return true;

  // Check markers
  if (MARKERS.some((m) => text.includes(m))) return true;

  // Check deadline patterns
  if (DEADLINE_PATTERNS.some((p) => p.test(text))) return true;

  return false;
}

// ── Core scan ─────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Filter out items whose confidence is below this threshold (0-1). Default 0 = keep all. */
  minConfidence?: number;
  /** Override context detection. */
  context?: ActionContext;
}

export class ActionItemsExtractor {
  private observer: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private options: ScanOptions = {};

  /** Update scan options live. Next MutationObserver-triggered scan picks them up. */
  configure(patch: ScanOptions): void {
    this.options = { ...this.options, ...patch };
  }

  /**
   * Build a single ActionItem from a raw candidate string, or null if not a match.
   * Shared by scan() (live DOM walk) and extract() (arbitrary text).
   */
  private buildItem(
    rawText: string,
    context: ActionContext,
    sourceUrl: string,
    source: string,
    now: number,
  ): ActionItem | null {
    const text = rawText.replace(/\s+/g, ' ').trim();
    if (!matchesActionItem(text)) return null;

    const lower = text.toLowerCase();
    const firstWord = text.split(/\s+/)[0] ?? '';
    const hasMarker = MARKERS.some((m) => text.includes(m));
    const hasImperative = IMPERATIVE_VERBS.some((v) =>
      v.includes(' ') ? text.startsWith(v) : firstWord.toLowerCase() === v.toLowerCase(),
    );
    const deadline = extractDeadline(text);
    const hasDeadline = deadline !== null;
    const hasUrgency = URGENT_KEYWORDS.some((kw) => lower.includes(kw));
    const assignee = extractAssignee(text);

    const priority = detectPriority(text, hasDeadline);
    const confidence = computeConfidence({
      hasMarker,
      hasImperative,
      hasDeadline,
      hasUrgency,
      hasAssignee: assignee !== undefined,
    });
    const displayText = text.length > 250 ? text.slice(0, 247) + '…' : text;
    const id = djb2(normalizeText(text));

    return {
      id,
      text: displayText,
      source,
      priority,
      dueDate: deadline,
      sourceUrl,
      timestamp: now,
      context,
      ...(assignee !== undefined ? { assignee } : {}),
      confidence,
    };
  }

  /**
   * Standalone extraction from an arbitrary text blob (e.g. pasted meeting
   * transcript, email body). No DOM traversal, no message broadcast.
   */
  extract(text: string, context: ActionContext = 'generic'): ActionItem[] {
    const now = Date.now();
    const seen = new Set<string>();
    const items: ActionItem[] = [];
    const sourceUrl = typeof location !== 'undefined' ? location.href : '';
    const source = typeof document !== 'undefined' ? document.title : '';

    for (const candidate of splitIntoCandidates(text)) {
      const key = normalizeText(candidate);
      if (seen.has(key)) continue;
      const item = this.buildItem(candidate, context, sourceUrl, source, now);
      if (!item) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= 50) break;
    }
    return items.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  }

  scan(options: ScanOptions = {}): ActionItem[] {
    const seen = new Set<string>();
    const items: ActionItem[] = [];

    // Use a TreeWalker over text nodes
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
          const text = (node.nodeValue ?? '').trim();
          if (!text) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    // Collect block-level containers, avoiding repeats
    const containerTexts = new Map<Element, string>();

    let node = walker.nextNode();
    while (node) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      if (parent) {
        // Find closest block-level ancestor
        let container: Element | null = parent;
        while (container && !BLOCK_TAGS.has(container.tagName)) {
          container = container.parentElement;
        }
        if (container && !shouldSkipElement(container)) {
          if (!containerTexts.has(container)) {
            const text = (container.textContent ?? '').trim();
            if (text) containerTexts.set(container, text);
          }
        }
      }
      node = walker.nextNode();
    }

    const merged: ScanOptions = { ...this.options, ...options };
    const minConfidence = merged.minConfidence ?? 0;
    const context = merged.context ?? detectContext();
    const source = document.title;
    const sourceUrl = location.href;
    const now = Date.now();

    for (const [, rawText] of containerTexts) {
      const normalized = normalizeText(rawText);
      if (seen.has(normalized)) continue;
      const item = this.buildItem(rawText, context, sourceUrl, source, now);
      if (!item) continue;
      if ((item.confidence ?? 0) < minConfidence) continue;
      seen.add(normalized);
      items.push(item);
      if (items.length >= 50) break;
    }

    // Report to background (defensive — may not be in extension context)
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'ACTION_ITEMS_UPDATE', payload: { items } }).catch(() => {});
      }
    } catch {
      // Swallow — no chrome runtime
    }

    return items;
  }

  watch(options: ScanOptions = {}): void {
    this.options = { ...this.options, ...options };

    // Immediate scan on watch call
    this.scan();

    if (this.observer) return; // already watching

    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            if (WATCHABLE_TAGS.has(el.tagName)) {
              const text = (el.textContent ?? '').trim();
              if (text.length > 0) {
                shouldScan = true;
                break;
              }
            }
          }
        }
        if (shouldScan) break;
      }

      if (!shouldScan) return;

      // Debounce
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.scan();
      }, 1000);
    });

    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  stop(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
