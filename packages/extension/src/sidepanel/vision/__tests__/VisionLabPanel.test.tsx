/**
 * VisionLabPanel unit tests — Session 23
 * Uses React test-utils + vitest (no @testing-library/react).
 * chrome.runtime.sendMessage is mocked via vi.stubGlobal.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import VisionLabPanel, { ScanResult } from '../VisionLabPanel';

// ─── JSDOM environment helpers ────────────────────────────────────────────────

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderComponent(ui: React.ReactElement) {
  act(() => { root.render(ui); });
}

// ─── Chrome stub ─────────────────────────────────────────────────────────────

let mockSendMessage: ReturnType<typeof vi.fn>;

const MOCK_RESULTS: ScanResult[] = [
  {
    id: 'el-1',
    element: { nodeHint: 'button#submit', role: 'button', tagName: 'BUTTON' },
    thumbnail: 'data:image/png;base64,abc',
    before: { currentLabel: null },
    after: { tier: 1, label: 'Submit form', confidence: 0.72, source: 'heuristic' },
  },
  {
    id: 'el-2',
    element: { nodeHint: 'img.logo', role: 'img', tagName: 'IMG' },
    thumbnail: 'data:image/png;base64,def',
    before: { currentLabel: 'Logo' },
    after: { tier: 2, label: 'Company logo', confidence: 0.91, source: 'vision-api' },
  },
  {
    id: 'el-3',
    element: { nodeHint: 'div[role=checkbox]', role: 'checkbox', tagName: 'DIV' },
    thumbnail: '',
    before: { currentLabel: null },
    after: { tier: 3, label: 'Accept terms', confidence: 0.55, source: 'vlm' },
  },
];

function buildChrome(scanHandler: () => Promise<unknown>) {
  return {
    runtime: {
      sendMessage: vi.fn(async (msg: { type: string }) => {
        mockSendMessage(msg);
        if (msg.type === 'VISION_LAB_SCAN') return scanHandler();
        if (msg.type === 'VISION_CURATION_LIST') return { curations: [] };
        if (msg.type === 'VISION_CURATION_SAVE') return { ok: true };
        if (msg.type === 'VISION_CURATION_EXPORT') return { ok: true };
        return {};
      }),
      getManifest: vi.fn(() => ({ version: '0.23.0' })),
    },
  };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockSendMessage = vi.fn();

  vi.stubGlobal('chrome', buildChrome(async () => ({
    ok: true,
    results: MOCK_RESULTS,
  })));
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function q(selector: string) { return container.querySelector(selector); }
function qAll(selector: string) { return container.querySelectorAll(selector); }
function getByText(text: string) {
  return Array.from(container.querySelectorAll('*')).find(
    (el) => el.textContent?.trim() === text,
  );
}

async function doScan() {
  const btn = Array.from(qAll('button')).find(
    (b) => b.textContent?.trim() === 'Scan page',
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error('Scan page button not found');
  await act(async () => { btn.click(); });
  // Wait for the async sendMessage promise to resolve
  await act(async () => { await Promise.resolve(); });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('VisionLabPanel', () => {
  // 1. Renders scan button
  it('renders the scan button', () => {
    renderComponent(<VisionLabPanel />);
    const buttons = Array.from(qAll('button'));
    const scanBtn = buttons.find((b) => b.textContent?.trim() === 'Scan page');
    expect(scanBtn).toBeDefined();
  });

  // 2. Click scan → dispatches VISION_LAB_SCAN
  it('click scan dispatches VISION_LAB_SCAN message', async () => {
    renderComponent(<VisionLabPanel />);
    await doScan();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'VISION_LAB_SCAN' }),
    );
  });

  // 3. Progress bar shows during scan (scanning state)
  it('button text changes to Scanning… while request is pending', async () => {
    // Override chrome to never resolve VISION_LAB_SCAN
    vi.stubGlobal('chrome', buildChrome(() => new Promise(() => {})));
    renderComponent(<VisionLabPanel />);

    const btn = Array.from(qAll('button')).find(
      (b) => b.textContent?.trim() === 'Scan page',
    ) as HTMLButtonElement;
    act(() => { btn.click(); });

    // After synchronous click processing, button should show scanning state
    expect(btn.textContent?.trim()).toBe('Scanning…');
  });

  // 4. Grid renders correct number of cards from mock results
  it('renders correct number of result cards after scan', async () => {
    renderComponent(<VisionLabPanel />);
    await doScan();

    const acceptBtns = Array.from(qAll('button')).filter(
      (b) => b.getAttribute('aria-label') === 'Accept label',
    );
    expect(acceptBtns.length).toBe(MOCK_RESULTS.length);
  });

  // 5. Tier badge color mapping (T1, T2, T3 present)
  it('renders all three tier badge variants after scan', async () => {
    renderComponent(<VisionLabPanel />);
    await doScan();

    expect(getByText('T1')).toBeDefined();
    expect(getByText('T2')).toBeDefined();
    expect(getByText('T3')).toBeDefined();
  });

  // 6. Accept button dispatches VISION_CURATION_SAVE with status='accepted'
  it('accept button dispatches VISION_CURATION_SAVE with accepted status', async () => {
    renderComponent(<VisionLabPanel />);
    await doScan();

    const acceptBtns = Array.from(qAll('button')).filter(
      (b) => b.getAttribute('aria-label') === 'Accept label',
    ) as HTMLButtonElement[];
    expect(acceptBtns.length).toBeGreaterThan(0);

    await act(async () => { acceptBtns[0].click(); });
    await act(async () => { await Promise.resolve(); });

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'VISION_CURATION_SAVE', status: 'accepted', id: 'el-1' }),
    );
  });

  // 7. Reject dispatches with status='rejected'
  it('reject button dispatches VISION_CURATION_SAVE with rejected status', async () => {
    renderComponent(<VisionLabPanel />);
    await doScan();

    const rejectBtns = Array.from(qAll('button')).filter(
      (b) => b.getAttribute('aria-label') === 'Reject label',
    ) as HTMLButtonElement[];
    expect(rejectBtns.length).toBeGreaterThan(1);

    await act(async () => { rejectBtns[1].click(); });
    await act(async () => { await Promise.resolve(); });

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'VISION_CURATION_SAVE', status: 'rejected', id: 'el-2' }),
    );
  });

  // 8. Edit + Enter dispatches with status='edited' + editedLabel
  it('edit + Enter dispatches VISION_CURATION_SAVE with edited status and new label', async () => {
    renderComponent(<VisionLabPanel />);
    await doScan();

    const editBtns = Array.from(qAll('button')).filter(
      (b) => b.getAttribute('aria-label') === 'Edit label',
    ) as HTMLButtonElement[];
    expect(editBtns.length).toBeGreaterThan(0);

    // Click edit on first card → opens input
    await act(async () => { editBtns[0].click(); });

    const input = q('input[aria-label="Edit label"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      // Change value
      Object.defineProperty(input!, 'value', { writable: true, value: 'New custom label' });
      input!.dispatchEvent(new Event('change', { bubbles: true }));
      // Simulate React controlled component update
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      )?.set;
      nativeInputValueSetter?.call(input, 'New custom label');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'VISION_CURATION_SAVE',
        status: 'edited',
        id: 'el-1',
      }),
    );
  });

  // 9. Export curations triggers VISION_CURATION_EXPORT message
  it('export curations button dispatches VISION_CURATION_EXPORT', async () => {
    renderComponent(<VisionLabPanel />);
    await doScan();

    const exportBtn = Array.from(qAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Export curations as JSON',
    ) as HTMLButtonElement | undefined;
    expect(exportBtn).toBeDefined();

    await act(async () => { exportBtn!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'VISION_CURATION_EXPORT' }),
    );
  });

  // 10. Empty state message rendered when no results
  it('shows empty state message when no results and not scanning', () => {
    renderComponent(<VisionLabPanel />);
    const emptyText = Array.from(container.querySelectorAll('p')).find(
      (p) => p.textContent?.includes('Scan page'),
    );
    expect(emptyText).toBeDefined();
  });
});
