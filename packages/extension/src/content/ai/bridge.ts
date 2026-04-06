/**
 * AI Bridge — content-script-side interface to the AI engine
 * running in the background service worker.
 *
 * Provides page summarization, text simplification, and
 * accessibility-aware content transformation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AIBridgeResult {
  text: string;
  cached: boolean;
  tier: string;
  latencyMs: number;
}

interface SummarizeResult extends AIBridgeResult {
  bulletPoints: string[];
}

// ---------------------------------------------------------------------------
// AIBridge
// ---------------------------------------------------------------------------

export class AIBridge {
  private summaryPanel: HTMLElement | null = null;
  private simplifiedOverlay: HTMLElement | null = null;

  /**
   * Summarize the current page's main content.
   * Returns the summary text and optionally displays it in a floating panel.
   */
  async summarizePage(showPanel = true): Promise<SummarizeResult> {
    const mainContent = this.extractMainContent();
    const result = await this.sendAIRequest('SUMMARIZE_TEXT', {
      text: mainContent,
      maxBullets: 5,
    });

    const bulletPoints = result.text
      .split('\n')
      .filter((line: string) => line.startsWith('- '))
      .map((line: string) => line.slice(2).trim());

    const summaryResult: SummarizeResult = {
      ...result,
      bulletPoints: bulletPoints.length > 0 ? bulletPoints : [result.text],
    };

    if (showPanel) {
      this.showSummaryPanel(summaryResult);
    }

    return summaryResult;
  }

  /**
   * Simplify the selected text or the entire page content.
   */
  async simplifyContent(
    level: 'mild' | 'strong' = 'mild',
    selection?: string,
  ): Promise<AIBridgeResult> {
    const text = selection || this.getSelectedText() || this.extractMainContent();
    const result = await this.sendAIRequest('SIMPLIFY_TEXT', { text, level });

    if (!selection && !this.getSelectedText()) {
      // Full page simplification — show as overlay
      this.showSimplifiedOverlay(result.text);
    }

    return result;
  }

  /**
   * Summarize an email (detects Gmail/Outlook context).
   */
  async summarizeEmail(): Promise<AIBridgeResult> {
    const emailContent = this.extractEmailContent();
    if (!emailContent) {
      return {
        text: 'No email content detected on this page.',
        cached: false,
        tier: 'local',
        latencyMs: 0,
      };
    }
    return this.sendAIRequest('SUMMARIZE_EMAIL', { html: emailContent });
  }

  /**
   * Get readability score for the current page.
   */
  async getReadabilityScore(): Promise<{ score: number; grade: string }> {
    const text = this.extractMainContent();
    const response = await chrome.runtime.sendMessage({
      type: 'AI_READABILITY',
      payload: { text },
    });
    return response as { score: number; grade: string };
  }

  /**
   * Dismiss any visible AI panels/overlays.
   */
  dismiss(): void {
    this.hideSummaryPanel();
    this.hideSimplifiedOverlay();
  }

  // -----------------------------------------------------------------------
  // Content extraction
  // -----------------------------------------------------------------------

  private extractMainContent(): string {
    // Try semantic selectors first
    const selectors = [
      'main',
      '[role="main"]',
      'article',
      '#content',
      '.content',
      '.post-content',
      '.article-body',
      '.entry-content',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length > 100) {
        return this.cleanText(el.textContent);
      }
    }

    // Fallback: body text minus nav/footer/aside
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('nav, footer, aside, header, script, style, [role="navigation"], [role="banner"]')
      .forEach(el => el.remove());

    return this.cleanText(clone.textContent || '');
  }

  private extractEmailContent(): string | null {
    const { hostname } = window.location;

    if (hostname.includes('mail.google.com')) {
      // Gmail: email body is in .a3s.aiL or .ii.gt
      const emailBody = document.querySelector('.a3s.aiL') || document.querySelector('.ii.gt');
      if (emailBody) return emailBody.innerHTML;
    }

    if (hostname.includes('outlook')) {
      // Outlook: email body in [role="document"] or .allowTextSelection
      const emailBody = document.querySelector('[role="document"]') || document.querySelector('.allowTextSelection');
      if (emailBody) return emailBody.innerHTML;
    }

    return null;
  }

  private getSelectedText(): string {
    const selection = window.getSelection();
    return selection ? selection.toString().trim() : '';
  }

  private cleanText(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 10000); // Cap at 10k chars for AI processing
  }

  // -----------------------------------------------------------------------
  // Background communication
  // -----------------------------------------------------------------------

  private async sendAIRequest(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<AIBridgeResult> {
    try {
      const response = await chrome.runtime.sendMessage({ type, payload });

      if (response && typeof response === 'object' && 'error' in response) {
        throw new Error(response.error as string);
      }

      return response as AIBridgeResult;
    } catch (err) {
      console.error('[AccessBridge AI Bridge]', err);
      return {
        text: 'AI processing unavailable. Using local fallback.',
        cached: false,
        tier: 'local',
        latencyMs: 0,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Summary panel UI
  // -----------------------------------------------------------------------

  private showSummaryPanel(result: SummarizeResult): void {
    this.hideSummaryPanel();

    const panel = document.createElement('div');
    panel.className = 'ab-summary-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Page Summary');

    panel.innerHTML = `
      <div class="ab-summary-header">
        <span class="ab-summary-title">Page Summary</span>
        <span class="ab-summary-meta">${result.tier} · ${result.latencyMs}ms${result.cached ? ' · cached' : ''}</span>
        <button class="ab-summary-close" aria-label="Close summary">&times;</button>
      </div>
      <div class="ab-summary-content">
        <ul>
          ${result.bulletPoints.map(bp => `<li>${this.escapeHtml(bp)}</li>`).join('')}
        </ul>
      </div>
      <div class="ab-summary-actions">
        <button class="ab-summary-btn" data-action="simplify">Simplify</button>
        <button class="ab-summary-btn" data-action="read">Read Aloud</button>
        <button class="ab-summary-btn" data-action="copy">Copy</button>
      </div>
    `;

    // Event handlers
    panel.querySelector('.ab-summary-close')?.addEventListener('click', () => this.hideSummaryPanel());
    panel.querySelector('[data-action="simplify"]')?.addEventListener('click', () => {
      this.simplifyContent('mild', result.text);
    });
    panel.querySelector('[data-action="read"]')?.addEventListener('click', () => {
      const utterance = new SpeechSynthesisUtterance(result.text);
      utterance.rate = 0.9;
      speechSynthesis.speak(utterance);
    });
    panel.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
      navigator.clipboard.writeText(result.text).catch(() => {});
    });

    document.body.appendChild(panel);
    this.summaryPanel = panel;
  }

  private hideSummaryPanel(): void {
    this.summaryPanel?.remove();
    this.summaryPanel = null;
  }

  // -----------------------------------------------------------------------
  // Simplified content overlay
  // -----------------------------------------------------------------------

  private showSimplifiedOverlay(text: string): void {
    this.hideSimplifiedOverlay();

    const overlay = document.createElement('div');
    overlay.className = 'ab-simplified-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Simplified Content');

    overlay.innerHTML = `
      <div class="ab-simplified-header">
        <span>Simplified View</span>
        <button class="ab-simplified-close" aria-label="Close">&times;</button>
      </div>
      <div class="ab-simplified-content">${this.escapeHtml(text)}</div>
    `;

    overlay.querySelector('.ab-simplified-close')?.addEventListener('click', () => {
      this.hideSimplifiedOverlay();
    });

    document.body.appendChild(overlay);
    this.simplifiedOverlay = overlay;
  }

  private hideSimplifiedOverlay(): void {
    this.simplifiedOverlay?.remove();
    this.simplifiedOverlay = null;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
