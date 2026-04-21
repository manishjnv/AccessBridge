import type { RecoveredLabel } from '@accessbridge/core';

export type VisionUIAction = 'accept' | 'reject' | 'edit';

export class VisionRecoveryUI {
  private badge: HTMLButtonElement | null = null;
  private panel: HTMLElement | null = null;
  private mounted = false;
  private currentResults: RecoveredLabel[] = [];
  private onAcceptRejectCb: ((label: RecoveredLabel, action: VisionUIAction) => void) | null = null;
  private stats: { hits: number; entries: number; sizeBytes: number } = {
    hits: 0,
    entries: 0,
    sizeBytes: 0,
  };

  mount(): void {
    if (this.mounted) return;
    if (typeof document === 'undefined' || document.body === null) return;

    this.mounted = true;

    this.badge = document.createElement('button');
    this.badge.className = 'a11y-vision-badge';
    this.badge.type = 'button';
    this.badge.textContent = '0 labels recovered';
    this.badge.setAttribute('aria-label', 'Show recovered labels panel');
    this.badge.addEventListener('click', () => this.togglePanel());
    document.body.appendChild(this.badge);

    this.panel = document.createElement('aside');
    this.panel.className = 'a11y-vision-panel';
    this.panel.setAttribute('role', 'complementary');
    this.panel.setAttribute('aria-label', 'Vision recovery panel');
    document.body.appendChild(this.panel);

    this.renderPanel();
  }

  unmount(): void {
    if (!this.mounted) return;

    this.mounted = false;
    this.badge?.remove();
    this.panel?.remove();
    this.badge = null;
    this.panel = null;
  }

  updateCount(count: number): void {
    if (this.badge !== null) {
      this.badge.textContent = `${count} label${count === 1 ? '' : 's'} recovered`;
    }
  }

  setResults(results: RecoveredLabel[]): void {
    this.currentResults = results;
    this.updateCount(results.length);
    this.renderPanel();
  }

  setStats(stats: { hits: number; entries: number; sizeBytes: number }): void {
    this.stats = stats;
    this.renderPanel();
  }

  setOnAcceptReject(callback: (label: RecoveredLabel, action: VisionUIAction) => void): void {
    this.onAcceptRejectCb = callback;
  }

  private togglePanel(): void {
    if (this.panel === null) return;
    this.panel.classList.toggle('open');
  }

  private renderPanel(): void {
    if (this.panel === null) return;

    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.renderHeader());
    fragment.appendChild(this.renderStats());

    for (const result of this.currentResults) {
      fragment.appendChild(this.renderItem(result));
    }

    if (this.currentResults.length > 0) {
      fragment.appendChild(this.renderExportButton());
    }

    this.panel.replaceChildren(fragment);
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '16px';

    const title = document.createElement('h3');
    title.textContent = 'Recovered Labels';
    title.style.margin = '0';
    title.style.color = '#bb86fc';

    const closeButton = document.createElement('button');
    closeButton.textContent = '×';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close panel');
    closeButton.style.background = 'transparent';
    closeButton.style.border = 'none';
    closeButton.style.color = '#e2e8f0';
    closeButton.style.fontSize = '20px';
    closeButton.style.cursor = 'pointer';
    closeButton.addEventListener('click', () => this.togglePanel());

    header.appendChild(title);
    header.appendChild(closeButton);
    return header;
  }

  private renderStats(): HTMLElement {
    const statsElement = document.createElement('p');
    statsElement.style.fontSize = '11px';
    statsElement.style.color = '#94a3b8';
    statsElement.style.margin = '0 0 12px 0';
    statsElement.textContent =
      `${this.currentResults.length} recovered · ${this.stats.hits} cache hits · ` +
      `${Math.round(this.stats.sizeBytes / 1024)} KB`;
    return statsElement;
  }

  private renderExportButton(): HTMLButtonElement {
    const exportButton = document.createElement('button');
    exportButton.textContent = 'Export CSV';
    exportButton.type = 'button';
    exportButton.style.marginTop = '16px';
    exportButton.style.padding = '8px 14px';
    exportButton.style.background = 'linear-gradient(135deg, #7b68ee, #bb86fc)';
    exportButton.style.color = '#fff';
    exportButton.style.border = 'none';
    exportButton.style.borderRadius = '10px';
    exportButton.style.cursor = 'pointer';
    exportButton.style.fontWeight = '600';
    exportButton.addEventListener('click', () => this.exportCsv());
    return exportButton;
  }

  private renderItem(result: RecoveredLabel): HTMLElement {
    const item = document.createElement('div');
    item.className = 'a11y-vision-item';

    const hint = document.createElement('div');
    hint.style.fontSize = '10px';
    hint.style.color = '#94a3b8';
    hint.style.marginBottom = '2px';
    hint.textContent =
      `${result.element.nodeHint} · Tier ${result.tier}` +
      (result.source === 'cached' ? ' (cached)' : '');
    item.appendChild(hint);

    const label = document.createElement('div');
    label.style.fontWeight = '600';
    label.style.color = '#e2e8f0';
    label.textContent = result.inferredLabel;
    item.appendChild(label);

    if (result.inferredDescription.length > 0) {
      const description = document.createElement('div');
      description.style.fontSize = '11px';
      description.style.color = '#94a3b8';
      description.style.marginTop = '2px';
      description.textContent = result.inferredDescription;
      item.appendChild(description);
    }

    const confidenceBar = document.createElement('div');
    confidenceBar.className = 'a11y-vision-confidence-bar';

    const confidenceFill = document.createElement('div');
    confidenceFill.className = 'a11y-vision-confidence-fill';
    confidenceFill.style.width = `${Math.round(result.confidence * 100)}%`;
    confidenceBar.appendChild(confidenceFill);
    item.appendChild(confidenceBar);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.marginTop = '8px';
    actions.appendChild(this.renderActionButton('Accept', 'accept', result));
    actions.appendChild(this.renderActionButton('Edit', 'edit', result));
    actions.appendChild(this.renderActionButton('Reject', 'reject', result));
    item.appendChild(actions);

    return item;
  }

  private renderActionButton(
    text: string,
    action: VisionUIAction,
    label: RecoveredLabel,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.textContent = text;
    button.type = 'button';
    button.style.padding = '4px 10px';
    button.style.fontSize = '11px';
    button.style.background = 'rgba(123, 104, 238, 0.15)';
    button.style.color = '#bb86fc';
    button.style.border = '1px solid rgba(123, 104, 238, 0.3)';
    button.style.borderRadius = '6px';
    button.style.cursor = 'pointer';
    button.addEventListener('click', () => {
      if (this.onAcceptRejectCb !== null) this.onAcceptRejectCb(label, action);
    });
    return button;
  }

  private exportCsv(): void {
    const header = 'NodeHint,Role,Label,Description,Confidence,Tier,Source\n';
    const rows = this.currentResults.map((result) => [
      csvEscape(result.element.nodeHint),
      csvEscape(result.inferredRole),
      csvEscape(result.inferredLabel),
      csvEscape(result.inferredDescription),
      result.confidence.toFixed(2),
      String(result.tier),
      result.source,
    ].join(','));
    const csv = header + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = 'accessbridge-recovered-labels.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}
