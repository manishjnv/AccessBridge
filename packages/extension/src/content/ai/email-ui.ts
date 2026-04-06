/**
 * Email Summarization UI Overlay
 * Provides summarize/simplify buttons and a slide-in summary panel
 * for Gmail, Outlook, and generic webmail.
 */

import type { AIBridge } from './bridge.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailSummary {
  text: string;
  bulletPoints: string[];
  readingTimeSeconds: number;
  complexityScore: number;
}

type EmailProvider = 'gmail' | 'outlook' | 'generic';

// ---------------------------------------------------------------------------
// EmailSummarizationUI
// ---------------------------------------------------------------------------

export class EmailSummarizationUI {
  private aiBridge: AIBridge | null = null;
  private observer: MutationObserver | null = null;
  private panel: HTMLElement | null = null;
  private fab: HTMLElement | null = null;
  private injectedButtons: HTMLElement[] = [];
  private autoSummarize = false;
  private autoSummarizeTimer: ReturnType<typeof setTimeout> | null = null;
  private provider: EmailProvider = 'generic';
  private lastEmailHash = '';

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(aiBridge: AIBridge): void {
    this.aiBridge = aiBridge;
    this.provider = this.detectProvider();

    // Load auto-summarize preference
    this.loadAutoSummarizePreference();

    // Initial injection attempt
    this.onEmailChange();

    // Watch for SPA navigation / email open events
    this.observer = new MutationObserver(() => this.onEmailChange());
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.hidePanel();
    this.removeFAB();
    this.removeInjectedButtons();
    this.clearAutoTimer();
    this.aiBridge = null;
    this.lastEmailHash = '';
  }

  // -----------------------------------------------------------------------
  // Provider detection
  // -----------------------------------------------------------------------

  private detectProvider(): EmailProvider {
    const { hostname } = window.location;
    if (hostname.includes('mail.google.com')) return 'gmail';
    if (hostname.includes('outlook.live.com') || hostname.includes('outlook.office.com'))
      return 'outlook';
    return 'generic';
  }

  // -----------------------------------------------------------------------
  // Email change detection (debounced via hash)
  // -----------------------------------------------------------------------

  private onEmailChange(): void {
    const content = this.getEmailContent();
    if (!content) {
      // No email open — clean up
      this.removeInjectedButtons();
      this.removeFAB();
      return;
    }

    // Simple hash to avoid re-injecting for the same email
    const hash = this.simpleHash(content.slice(0, 500));
    if (hash === this.lastEmailHash) return;
    this.lastEmailHash = hash;

    // Clean previous injection
    this.removeInjectedButtons();
    this.removeFAB();
    this.hidePanel();

    // Inject per provider
    switch (this.provider) {
      case 'gmail':
        this.injectGmailButtons();
        break;
      case 'outlook':
        this.injectOutlookButtons();
        break;
      default:
        if (this.looksLikeEmail(content)) {
          this.showFAB();
        }
        break;
    }

    // Auto-summarize
    if (this.autoSummarize) {
      this.clearAutoTimer();
      this.autoSummarizeTimer = setTimeout(() => {
        this.handleSummarize();
      }, 2000);
    }
  }

  // -----------------------------------------------------------------------
  // Gmail injection
  // -----------------------------------------------------------------------

  private injectGmailButtons(): void {
    // Gmail toolbar area: .ade (action bar above email) or .G-atb (toolbar)
    const toolbar =
      document.querySelector('.ade') ||
      document.querySelector('.G-atb') ||
      document.querySelector('[gh="tm"]');

    if (!toolbar) return;

    const container = document.createElement('div');
    container.className = 'ab-email-btn-group';

    const summarizeBtn = this.createButton('Summarize', () => this.handleSummarize());
    const simplifyBtn = this.createButton('Simplify', () => this.handleSimplify());

    container.appendChild(summarizeBtn);
    container.appendChild(simplifyBtn);
    toolbar.appendChild(container);
    this.injectedButtons.push(container);
  }

  // -----------------------------------------------------------------------
  // Outlook injection
  // -----------------------------------------------------------------------

  private injectOutlookButtons(): void {
    // Outlook toolbar: command bar above reading pane
    const toolbar =
      document.querySelector('[data-app-section="ConversationContainer"] [role="toolbar"]') ||
      document.querySelector('[role="main"] [role="toolbar"]') ||
      document.querySelector('.ms-CommandBar');

    if (!toolbar) return;

    const container = document.createElement('div');
    container.className = 'ab-email-btn-group';

    const summarizeBtn = this.createButton('Summarize', () => this.handleSummarize());
    const simplifyBtn = this.createButton('Simplify', () => this.handleSimplify());

    container.appendChild(summarizeBtn);
    container.appendChild(simplifyBtn);
    toolbar.appendChild(container);
    this.injectedButtons.push(container);
  }

  // -----------------------------------------------------------------------
  // Generic FAB (floating action button)
  // -----------------------------------------------------------------------

  private showFAB(): void {
    if (this.fab) return;

    const fab = document.createElement('button');
    fab.className = 'ab-email-fab';
    fab.setAttribute('aria-label', 'Summarize email');
    fab.title = 'Summarize email';
    fab.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="4" y1="6" x2="20" y2="6"/>
        <line x1="4" y1="12" x2="14" y2="12"/>
        <line x1="4" y1="18" x2="10" y2="18"/>
      </svg>
    `;
    fab.addEventListener('click', () => this.handleSummarize());
    document.body.appendChild(fab);
    this.fab = fab;
  }

  private removeFAB(): void {
    this.fab?.remove();
    this.fab = null;
  }

  // -----------------------------------------------------------------------
  // Button factory
  // -----------------------------------------------------------------------

  private createButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'ab-email-btn';
    btn.textContent = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // -----------------------------------------------------------------------
  // Action handlers
  // -----------------------------------------------------------------------

  private async handleSummarize(): Promise<void> {
    if (!this.aiBridge) return;

    this.showPanel({ loading: true });

    try {
      const result = await this.aiBridge.summarizeEmail();
      const content = this.getEmailContent() || '';
      const wordCount = content.split(/\s+/).length;
      const readingTimeSeconds = Math.round((wordCount / 200) * 60); // 200 wpm average

      // Parse bullet points from result
      const bulletPoints = result.text
        .split('\n')
        .filter((line: string) => line.startsWith('- ') || line.startsWith('* '))
        .map((line: string) => line.replace(/^[-*]\s*/, '').trim());

      // Estimate complexity (0-100): longer sentences + rarer words = higher
      const sentences = content.split(/[.!?]+/).filter(Boolean);
      const avgSentenceLen =
        sentences.length > 0
          ? sentences.reduce((s, sent) => s + sent.split(/\s+/).length, 0) / sentences.length
          : 15;
      const complexityScore = Math.min(100, Math.round(avgSentenceLen * 4));

      const summary: EmailSummary = {
        text: result.text,
        bulletPoints: bulletPoints.length > 0 ? bulletPoints : [result.text],
        readingTimeSeconds,
        complexityScore,
      };

      this.showPanel({ summary });
    } catch {
      this.showPanel({ error: 'Failed to summarize email. Please try again.' });
    }
  }

  private async handleSimplify(): Promise<void> {
    if (!this.aiBridge) return;

    this.showPanel({ loading: true, loadingLabel: 'Simplifying...' });

    try {
      const content = this.getEmailContent() || '';
      const result = await this.aiBridge.simplifyContent('mild', content);

      const summary: EmailSummary = {
        text: result.text,
        bulletPoints: [result.text],
        readingTimeSeconds: Math.round((result.text.split(/\s+/).length / 200) * 60),
        complexityScore: 20, // simplified = low complexity
      };

      this.showPanel({ summary, title: 'Simplified Email' });
    } catch {
      this.showPanel({ error: 'Failed to simplify email. Please try again.' });
    }
  }

  // -----------------------------------------------------------------------
  // Summary panel
  // -----------------------------------------------------------------------

  private showPanel(opts: {
    loading?: boolean;
    loadingLabel?: string;
    summary?: EmailSummary;
    error?: string;
    title?: string;
  }): void {
    this.hidePanel();

    const panel = document.createElement('div');
    panel.className = 'ab-email-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', opts.title || 'Email Summary');

    // Header
    const header = document.createElement('div');
    header.className = 'ab-email-panel-header';

    const title = document.createElement('span');
    title.className = 'ab-email-panel-title';
    title.textContent = opts.title || 'Email Summary';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ab-email-panel-close';
    closeBtn.setAttribute('aria-label', 'Close summary panel');
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => this.hidePanel());
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'ab-email-panel-body';

    if (opts.loading) {
      body.innerHTML = `<div class="ab-email-loading">${this.escapeHtml(opts.loadingLabel || 'Summarizing...')}</div>`;
    } else if (opts.error) {
      body.innerHTML = `<div class="ab-email-error">${this.escapeHtml(opts.error)}</div>`;
    } else if (opts.summary) {
      const { summary } = opts;

      // Meta row
      const meta = document.createElement('div');
      meta.className = 'ab-email-meta';
      meta.innerHTML = `
        <span title="Estimated reading time">Reading: ${this.formatTime(summary.readingTimeSeconds)}</span>
        <span title="Content complexity score">Complexity: ${summary.complexityScore}/100</span>
      `;
      body.appendChild(meta);

      // Bullet points
      const list = document.createElement('ul');
      list.className = 'ab-email-bullets';
      for (const bp of summary.bulletPoints) {
        const li = document.createElement('li');
        li.textContent = bp;
        list.appendChild(li);
      }
      body.appendChild(list);
    }

    panel.appendChild(body);

    // Actions (only when we have a summary)
    if (opts.summary) {
      const actions = document.createElement('div');
      actions.className = 'ab-email-panel-actions';

      const readBtn = this.createButton('Read Aloud', () => {
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(opts.summary!.text);
        utterance.rate = 0.9;
        speechSynthesis.speak(utterance);
      });

      const copyBtn = this.createButton('Copy', () => {
        navigator.clipboard.writeText(opts.summary!.text).catch(() => {});
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
      });

      actions.appendChild(readBtn);
      actions.appendChild(copyBtn);
      panel.appendChild(actions);
    }

    document.body.appendChild(panel);
    this.panel = panel;

    // Animate in
    requestAnimationFrame(() => {
      panel.classList.add('ab-email-panel--open');
    });
  }

  private hidePanel(): void {
    if (!this.panel) return;
    speechSynthesis.cancel();
    this.panel.classList.remove('ab-email-panel--open');
    // Remove after transition
    const p = this.panel;
    setTimeout(() => p.remove(), 300);
    this.panel = null;
  }

  // -----------------------------------------------------------------------
  // Content extraction
  // -----------------------------------------------------------------------

  private getEmailContent(): string | null {
    switch (this.provider) {
      case 'gmail': {
        const el =
          document.querySelector('.a3s.aiL') || document.querySelector('.ii.gt');
        return el?.textContent?.trim() || null;
      }
      case 'outlook': {
        const el =
          document.querySelector('[role="document"]') ||
          document.querySelector('.allowTextSelection');
        return el?.textContent?.trim() || null;
      }
      default: {
        // For generic pages, scan for large text blocks
        const main =
          document.querySelector('main') ||
          document.querySelector('[role="main"]') ||
          document.querySelector('article');
        return main?.textContent?.trim() || null;
      }
    }
  }

  /** Heuristic: does this text look like an email? */
  private looksLikeEmail(text: string): boolean {
    if (text.length < 200) return false;
    const lower = text.toLowerCase();
    const greetings = ['dear ', 'hi ', 'hello ', 'good morning', 'good afternoon', 'good evening'];
    const signatures = ['regards', 'sincerely', 'best wishes', 'thanks', 'thank you', 'cheers'];
    const hasGreeting = greetings.some((g) => lower.includes(g));
    const hasSignature = signatures.some((s) => lower.includes(s));
    return hasGreeting && hasSignature;
  }

  // -----------------------------------------------------------------------
  // Cleanup helpers
  // -----------------------------------------------------------------------

  private removeInjectedButtons(): void {
    for (const el of this.injectedButtons) {
      el.remove();
    }
    this.injectedButtons = [];
  }

  private clearAutoTimer(): void {
    if (this.autoSummarizeTimer) {
      clearTimeout(this.autoSummarizeTimer);
      this.autoSummarizeTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Preferences
  // -----------------------------------------------------------------------

  private loadAutoSummarizePreference(): void {
    chrome.runtime
      .sendMessage({ type: 'GET_PROFILE' })
      .then((profile) => {
        if (profile && typeof profile === 'object') {
          const p = profile as { cognitive?: { autoSummarize?: boolean } };
          this.autoSummarize = !!p.cognitive?.autoSummarize;
        }
      })
      .catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  private formatTime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
