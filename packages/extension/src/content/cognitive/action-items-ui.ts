import { ActionItemsExtractor, detectContext } from './action-items.js';
import type { ActionContext, ActionItem } from './action-items.js';

const STORAGE_DISMISSED_KEY = 'actionItemsDismissed';
const POLL_INTERVAL_MS = 4000;

type ChromeStorageResult = Record<string, unknown>;

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && chrome.storage?.local !== undefined;
}

function hasChromeTabs(): boolean {
  return typeof chrome !== 'undefined' && chrome.tabs !== undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function formatConfidence(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

function csvEscape(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export class ActionItemsUI {
  private readonly extractor: ActionItemsExtractor;
  private fab: HTMLButtonElement | null = null;
  private badge: HTMLSpanElement | null = null;
  private panel: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private mounted = false;
  private open = false;
  private items: ActionItem[] = [];
  private dismissedIds = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private context: ActionContext = 'generic';

  private readonly onFabClick = (): void => this.togglePanel();
  private readonly onCloseClick = (): void => this.closePanel();

  constructor(extractor: ActionItemsExtractor) {
    this.extractor = extractor;
  }

  mount(): void {
    if (this.mounted) return;
    if (typeof document === 'undefined' || !document.body) return;

    this.mounted = true;
    this.context = detectContext();

    this.createFab();
    this.createPanel();
    this.refresh();
    void this.loadDismissedIds().then(() => this.refresh());
  }

  unmount(): void {
    this.stopPolling();

    this.fab?.removeEventListener('click', this.onFabClick);
    this.panel?.querySelector('.ab-action-close')?.removeEventListener('click', this.onCloseClick);

    this.fab?.remove();
    this.panel?.remove();

    this.fab = null;
    this.badge = null;
    this.panel = null;
    this.list = null;
    this.items = [];
    this.open = false;
    this.mounted = false;
  }

  refresh(): void {
    if (!this.mounted) return;

    this.context = detectContext();
    const scanned = this.extractor.scan({ context: this.context });
    this.items = scanned.filter((item) => !this.dismissedIds.has(item.id));

    this.updateFab();
    this.renderList();
  }

  private createFab(): void {
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'ab-action-fab';
    fab.setAttribute('role', 'button');
    fab.setAttribute('aria-pressed', 'false');
    fab.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="7" width="18" height="13" rx="2"/>
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        <path d="M3 12h18"/>
        <path d="M12 12v2"/>
      </svg>
    `;

    const badge = document.createElement('span');
    badge.className = 'ab-action-fab-badge';
    badge.hidden = true;
    fab.appendChild(badge);

    fab.addEventListener('click', this.onFabClick);
    document.body.appendChild(fab);

    this.fab = fab;
    this.badge = badge;
    this.updateFab();
  }

  private createPanel(): void {
    const panel = document.createElement('aside');
    panel.className = 'ab-action-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Action Items');
    panel.setAttribute('aria-modal', 'false');

    const header = document.createElement('div');
    header.className = 'ab-action-header';

    const title = document.createElement('h2');
    title.className = 'ab-action-title';
    title.textContent = 'Action Items';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ab-action-close';
    close.setAttribute('aria-label', 'Close action items');
    close.textContent = '×';
    close.addEventListener('click', this.onCloseClick);

    header.appendChild(title);
    header.appendChild(close);

    const toolbar = document.createElement('div');
    toolbar.className = 'ab-action-toolbar';
    toolbar.appendChild(this.createToolbarButton('Copy all', () => this.copyAll()));
    toolbar.appendChild(this.createToolbarButton('Export CSV', () => this.exportCsv()));
    toolbar.appendChild(this.createToolbarButton('Send to Google', () => this.sendToGoogle()));

    const list = document.createElement('div');
    list.className = 'ab-action-list';
    list.setAttribute('role', 'list');

    panel.appendChild(header);
    panel.appendChild(toolbar);
    panel.appendChild(list);
    document.body.appendChild(panel);

    this.panel = panel;
    this.list = list;
  }

  private createToolbarButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ab-action-btn';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private togglePanel(): void {
    if (this.open) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  }

  private openPanel(): void {
    if (!this.panel) return;

    this.open = true;
    this.panel.classList.add('ab-action-panel--open');
    this.fab?.setAttribute('aria-pressed', 'true');
    this.refresh();
    this.startPolling();
  }

  private closePanel(): void {
    if (!this.panel) return;

    this.open = false;
    this.panel.classList.remove('ab-action-panel--open');
    this.fab?.setAttribute('aria-pressed', 'false');
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private updateFab(): void {
    if (!this.fab || !this.badge) return;

    const count = this.items.length;
    this.fab.setAttribute('aria-label', `Action Items (${count})`);
    this.fab.setAttribute('aria-pressed', String(this.open));

    this.badge.textContent = String(count);
    this.badge.hidden = count === 0;
  }

  private renderList(): void {
    if (!this.list) return;

    this.list.replaceChildren();

    if (this.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ab-action-empty';
      empty.textContent = 'No action items found.';
      this.list.appendChild(empty);
      return;
    }

    for (const item of this.items) {
      this.list.appendChild(this.createRow(item));
    }
  }

  private createRow(item: ActionItem): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ab-action-row';
    row.setAttribute('role', 'listitem');

    const dot = document.createElement('span');
    dot.className = 'ab-action-priority-dot';
    dot.dataset.priority = item.priority;
    dot.title = `${item.priority} priority`;

    const text = document.createElement('span');
    text.className = 'ab-action-text';
    text.textContent = item.text;
    text.title = item.text;

    row.appendChild(dot);
    row.appendChild(text);

    if (item.dueDate) {
      const due = document.createElement('span');
      due.className = 'ab-action-due';
      due.textContent = item.dueDate;
      due.title = `Due ${item.dueDate}`;
      row.appendChild(due);
    }

    if (item.assignee) {
      const assignee = document.createElement('span');
      assignee.className = 'ab-action-assignee';
      assignee.textContent = item.assignee;
      assignee.title = `Assignee ${item.assignee}`;
      row.appendChild(assignee);
    }

    if (typeof item.confidence === 'number') {
      const confidence = document.createElement('span');
      confidence.className = 'ab-action-confidence';
      confidence.textContent = formatConfidence(item.confidence);
      confidence.title = 'Confidence';
      row.appendChild(confidence);
    }

    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'ab-action-done';
    done.textContent = 'Done';
    done.addEventListener('click', () => {
      void this.dismissItem(item.id);
    });
    row.appendChild(done);

    return row;
  }

  private toTabSeparated(items: ActionItem[]): string {
    const rows = items.map((item) => [
      item.text,
      item.dueDate ?? '',
      item.priority,
    ].join('\t'));
    return ['Task\tDeadline\tPriority', ...rows].join('\n');
  }

  private toCsv(items: ActionItem[]): string {
    const header = ['Task', 'Deadline', 'Priority', 'Assignee', 'Source URL'];
    const rows = items.map((item) => [
      item.text,
      item.dueDate ?? '',
      item.priority,
      item.assignee ?? '',
      item.sourceUrl,
    ].map(csvEscape).join(','));
    return [header.join(','), ...rows].join('\n');
  }

  private copyAll(): void {
    void this.writeClipboard(this.toTabSeparated(this.items));
  }

  private exportCsv(): void {
    const blob = new Blob([this.toCsv(this.items)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'items.csv';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  private sendToGoogle(): void {
    void this.writeClipboard(this.toTabSeparated(this.items));

    const url = 'https://tasks.google.com/';
    if (hasChromeTabs() && chrome.tabs.create) {
      void chrome.tabs.create({ url }).catch(() => {
        window.open(url, '_blank', 'noopener,noreferrer');
      });
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  private async writeClipboard(text: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // Clipboard access is best-effort in content scripts.
    }
  }

  private async dismissItem(id: string): Promise<void> {
    this.dismissedIds.add(id);
    this.items = this.items.filter((item) => item.id !== id);
    this.updateFab();
    this.renderList();
    await this.saveDismissedIds();
  }

  private async loadDismissedIds(): Promise<void> {
    if (!hasChromeStorage()) return;

    try {
      const result = await chrome.storage.local.get(STORAGE_DISMISSED_KEY) as ChromeStorageResult;
      const stored = result[STORAGE_DISMISSED_KEY];
      if (isStringArray(stored)) {
        this.dismissedIds = new Set(stored);
      }
    } catch {
      // Storage is unavailable in tests and some non-extension contexts.
    }
  }

  private async saveDismissedIds(): Promise<void> {
    if (!hasChromeStorage()) return;

    try {
      await chrome.storage.local.set({
        [STORAGE_DISMISSED_KEY]: Array.from(this.dismissedIds),
      });
    } catch {
      // Storage persistence is best-effort.
    }
  }
}
