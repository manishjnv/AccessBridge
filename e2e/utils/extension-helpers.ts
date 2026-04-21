import type { BrowserContext, Page } from '@playwright/test';

/** Open the extension popup in a new tab and return the page.
 *  Popups are chrome-extension://<id>/src/popup/index.html — we render them as
 *  full tabs because Playwright can't drive the real chrome:// popup surface. */
export async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** Same for the side panel — rendered as a tab for testing. */
export async function openSidePanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** Clear chrome.storage.local by reloading the extension SW + nuking storage.
 *  Use between tests when you want a pristine profile. */
export async function resetProfile(context: BrowserContext): Promise<void> {
  const [sw] = context.serviceWorkers();
  if (!sw) return;
  await sw.evaluate(async () => {
    await chrome.storage.local.clear();
  });
}

/** Get the active struggle score from the background SW. */
export async function getStruggleScore(context: BrowserContext): Promise<number> {
  const [sw] = context.serviceWorkers();
  if (!sw) throw new Error('No service worker — extension failed to load');
  const result = await sw.evaluate(async () => {
    return new Promise<unknown>((r) =>
      chrome.runtime.sendMessage({ type: 'GET_STRUGGLE_SCORE' }, r),
    );
  });
  return (result as { score?: number } | null)?.score ?? 0;
}

/** Wait for the active adaptations list to contain a given type. */
export async function waitForAdaptation(
  context: BrowserContext,
  adaptationType: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const [sw] = context.serviceWorkers();
  if (!sw) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await sw.evaluate(
      async () =>
        new Promise<unknown>((r) =>
          chrome.runtime.sendMessage({ type: 'GET_ACTIVE_ADAPTATIONS' }, r),
        ),
    );
    if (Array.isArray(list) && list.some((a: { type?: string }) => a.type === adaptationType)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Simulate the rapid-click pattern used to raise the struggle score. */
export async function simulateRapidClicks(page: Page, selector: string, count = 10): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.click(selector, { force: true, delay: 20 }).catch(() => {});
  }
}
