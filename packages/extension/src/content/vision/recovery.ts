import { DEFAULT_VISION_CONFIG, VisionRecoveryEngine } from '@accessbridge/core';
import type { ApiVisionClient, RecoveredLabel, UnlabeledElement } from '@accessbridge/core';

export interface VisionRecoveryOptions {
  enabled: boolean;
  autoScan: boolean;
  tier2Enabled: boolean;
  minConfidence: number;
  highlightRecovered: boolean;
}

const MAX_BATCH_SIZE = 50;
const DEBOUNCE_MS = 1000;

export class VisionRecoveryController {
  private readonly engine: VisionRecoveryEngine;
  private options: VisionRecoveryOptions;
  private mutationObserver: MutationObserver | null = null;
  private scanDebounceTimer: number | null = null;
  private lastScanResults: RecoveredLabel[] = [];
  private started = false;
  private elementMap = new Map<string, HTMLElement>();
  private onResultsCb: ((results: RecoveredLabel[]) => void) | null = null;

  constructor(options: Partial<VisionRecoveryOptions> = {}) {
    this.options = {
      enabled: options.enabled ?? false,
      autoScan: options.autoScan ?? true,
      tier2Enabled: options.tier2Enabled ?? false,
      minConfidence: options.minConfidence ?? 0.6,
      highlightRecovered: options.highlightRecovered ?? false,
    };

    const apiClient: ApiVisionClient | undefined = this.options.tier2Enabled
      ? { inferElementMeaning: (screenshot, domContext) => callBackgroundForVision(screenshot, domContext) }
      : undefined;

    this.engine = new VisionRecoveryEngine(
      {
        ...DEFAULT_VISION_CONFIG,
        minConfidence: this.options.minConfidence,
        tierEnabled: { 1: true, 2: this.options.tier2Enabled, 3: false },
      },
      apiClient,
    );
  }

  async start(): Promise<void> {
    if (this.started || !this.options.enabled) return;

    this.started = true;
    await this.scanPage();
    if (this.options.autoScan) this.attachMutationObserver();
  }

  stop(): void {
    this.started = false;

    if (this.mutationObserver !== null) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    if (this.scanDebounceTimer !== null) {
      window.clearTimeout(this.scanDebounceTimer);
      this.scanDebounceTimer = null;
    }

    this.clearDecorations();
  }

  async scanPage(): Promise<RecoveredLabel[]> {
    if (typeof document === 'undefined' || document.body === null) return [];

    const candidates = this.collectCandidates();
    const batch = candidates.slice(0, MAX_BATCH_SIZE);
    const results = await this.engine.recoverLabels(batch, detectAppVersion());

    this.applyLabels(results);
    this.lastScanResults = results;

    if (this.onResultsCb !== null) this.onResultsCb(results);
    return results;
  }

  setOptions(patch: Partial<VisionRecoveryOptions>): void {
    const previousOptions = this.options;
    this.options = { ...previousOptions, ...patch };

    if (
      patch.highlightRecovered !== undefined &&
      patch.highlightRecovered !== previousOptions.highlightRecovered
    ) {
      this.refreshDecorations();
    }
  }

  getLastResults(): RecoveredLabel[] {
    return [...this.lastScanResults];
  }

  getCacheStats(): { hits: number; entries: number; sizeBytes: number } {
    return this.engine.getCacheStats();
  }

  async clearCache(): Promise<void> {
    await this.engine.clearCache();
    this.lastScanResults = [];
    this.clearDecorations();
  }

  setOnResults(callback: (results: RecoveredLabel[]) => void): void {
    this.onResultsCb = callback;
  }

  private collectCandidates(): UnlabeledElement[] {
    const selector = [
      'button',
      'a[href]',
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"])',
      '[role="button"]',
      '[role="link"]',
      '[tabindex="0"]',
    ].join(',');
    const nodes = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    const candidates: UnlabeledElement[] = [];

    this.elementMap.clear();

    let candidateIndex = 0;
    for (const element of nodes) {
      if (element.hasAttribute('data-a11y-recovered')) continue;
      if (this.hasAccessibleName(element)) continue;

      const rect = element.getBoundingClientRect();
      const className = getClassSignature(element);
      const computedStyle = window.getComputedStyle(element);
      const backgroundImage = computedStyle.backgroundImage;
      const backgroundImageUrl =
        backgroundImage !== '' && backgroundImage !== 'none' ? extractUrl(backgroundImage) : null;
      const tagName = element.tagName.toLowerCase();
      const firstClassName = className.split(/\s+/).find((classPart) => classPart.length > 0) ?? '';
      const nodeHint = tagName + (firstClassName === '' ? '' : `.${firstClassName}`);
      const textContent = (element.textContent ?? '').trim();
      const siblingContext = this.getSiblingContext(element);

      const candidate: UnlabeledElement = {
        nodeHint,
        bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        computedRole: element.getAttribute('role'),
        currentAriaLabel: element.getAttribute('aria-label'),
        textContent,
        siblingContext,
        classSignature: className,
        backgroundImageUrl,
      };
      const mapKey = this.candidateKey(candidate, candidateIndex);

      this.elementMap.set(mapKey, element);
      candidates.push(candidate);
      candidateIndex++;
    }

    return candidates;
  }

  private candidateKey(candidate: UnlabeledElement, candidateIndex: number): string {
    return `${candidateIndex}::${candidate.nodeHint}::${candidate.textContent.slice(0, 20)}`;
  }

  private hasAccessibleName(element: HTMLElement): boolean {
    if ((element.getAttribute('aria-label') ?? '').trim().length > 0) return true;

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const referencedElement = document.getElementById(labelledBy);
      if (referencedElement !== null && (referencedElement.textContent ?? '').trim().length > 0) {
        return true;
      }
    }

    if ((element.getAttribute('title') ?? '').trim().length > 0) return true;
    if ((element.getAttribute('alt') ?? '').trim().length > 0) return true;

    const text = (element.textContent ?? '').trim();
    if (text.length > 0 && !this.isIconOnly(text)) return true;

    if (element.tagName === 'INPUT') {
      const id = element.getAttribute('id');
      if (id !== null) {
        const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
        if (label !== null && (label.textContent ?? '').trim().length > 0) return true;
      }
    }

    return false;
  }

  private isIconOnly(text: string): boolean {
    if (text.length === 0 || text.length > 2) return false;
    return !/[\w\u0900-\u097F]/u.test(text);
  }

  private getSiblingContext(element: HTMLElement): string {
    const parts: string[] = [];
    const previousElement = element.previousElementSibling;
    const nextElement = element.nextElementSibling;

    if (previousElement !== null) parts.push((previousElement.textContent ?? '').trim().slice(0, 100));
    if (nextElement !== null) parts.push((nextElement.textContent ?? '').trim().slice(0, 100));

    const parentElement = element.parentElement;
    if (parentElement !== null) {
      const parentLabel = parentElement.getAttribute('aria-label');
      if (parentLabel !== null) parts.push(parentLabel);
    }

    return parts.filter((part) => part.length > 0).join(' | ').slice(0, 200);
  }

  private applyLabels(results: RecoveredLabel[]): void {
    let resultIndex = 0;
    for (const result of results) {
      const mapKey = this.candidateKey(result.element, resultIndex);
      const element = this.elementMap.get(mapKey);
      resultIndex++;

      if (element === undefined) continue;

      element.setAttribute('aria-label', result.inferredLabel);
      element.setAttribute('data-a11y-recovered', `tier:${result.tier}`);

      const descriptionId = `a11y-recovered-desc-${resultIndex}`;
      let description = document.getElementById(descriptionId);
      if (description === null) {
        description = document.createElement('span');
        description.id = descriptionId;
        description.className = 'a11y-sr-only';
        description.textContent = 'Inferred by AccessBridge';
        description.style.position = 'absolute';
        description.style.width = '1px';
        description.style.height = '1px';
        description.style.overflow = 'hidden';
        description.style.clip = 'rect(0,0,0,0)';
        document.body.appendChild(description);
      }

      element.setAttribute('aria-describedby', descriptionId);

      if (this.options.highlightRecovered) {
        element.classList.add('a11y-recovered-element');
      }
    }
  }

  private clearDecorations(): void {
    const recoveredNodes = document.querySelectorAll('[data-a11y-recovered]');
    recoveredNodes.forEach((node) => {
      node.removeAttribute('data-a11y-recovered');
      node.removeAttribute('aria-label');
      node.removeAttribute('aria-describedby');
      node.classList.remove('a11y-recovered-element');
    });

    document.querySelectorAll('[id^="a11y-recovered-desc-"]').forEach((node) => node.remove());
  }

  private refreshDecorations(): void {
    const recoveredNodes = document.querySelectorAll('[data-a11y-recovered]');
    recoveredNodes.forEach((node) => {
      if (this.options.highlightRecovered) {
        node.classList.add('a11y-recovered-element');
      } else {
        node.classList.remove('a11y-recovered-element');
      }
    });
  }

  private attachMutationObserver(): void {
    if (this.mutationObserver !== null || document.body === null) return;

    this.mutationObserver = new MutationObserver((mutations) => {
      let hasSignificantChange = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 3) {
          hasSignificantChange = true;
          break;
        }
      }

      if (!hasSignificantChange) return;

      if (this.scanDebounceTimer !== null) window.clearTimeout(this.scanDebounceTimer);
      this.scanDebounceTimer = window.setTimeout(() => {
        this.scanDebounceTimer = null;
        this.scanPage().catch(() => {
          // Recovery scans are best-effort for dynamic DOM updates.
        });
      }, DEBOUNCE_MS);
    });

    this.mutationObserver.observe(document.body, { childList: true, subtree: true });
  }
}

function getClassSignature(element: HTMLElement): string {
  if (typeof element.className === 'string') return element.className;
  return String(element.className);
}

function extractUrl(backgroundImage: string): string | null {
  const match = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
  return match !== null ? match[1] : null;
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function detectAppVersion(): string {
  try {
    return chrome.runtime.getManifest().version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function callBackgroundForVision(
  screenshot: string,
  domContext: string,
): Promise<{ role: string; label: string; description: string; confidence: number }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'VISION_RECOVER_VIA_API', payload: { screenshot, domContext } },
      (response: unknown) => {
        if (chrome.runtime.lastError !== undefined && chrome.runtime.lastError !== null) {
          reject(new Error(chrome.runtime.lastError.message ?? 'runtime error'));
          return;
        }

        const visionResponse = response as
          | { role?: string; label?: string; description?: string; confidence?: number }
          | undefined;

        resolve({
          role: visionResponse?.role ?? 'button',
          label: visionResponse?.label ?? 'Unlabeled',
          description: visionResponse?.description ?? '',
          confidence: visionResponse?.confidence ?? 0,
        });
      },
    );
  });
}

export function registerVisionRecoveryHandlers(getController: () => VisionRecoveryController): void {
  chrome.runtime.onMessage.addListener((message: { type: string; payload?: unknown }, _sender, sendResponse) => {
    switch (message.type) {
      case 'VISION_SCAN_NOW':
        getController()
          .scanPage()
          .then((results) => sendResponse({ count: results.length, results }))
          .catch(() => sendResponse({ count: 0, results: [] }));
        return true;
      case 'VISION_GET_STATS':
        sendResponse(getController().getCacheStats());
        return false;
      case 'VISION_CLEAR_CACHE':
        getController()
          .clearCache()
          .then(() => sendResponse({ cleared: true }))
          .catch(() => sendResponse({ cleared: false }));
        return true;
      default:
        return false;
    }
  });
}
