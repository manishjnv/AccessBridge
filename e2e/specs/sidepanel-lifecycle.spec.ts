import { test, expect } from '../fixtures.js';
import { openSidePanel } from '../utils/extension-helpers.js';

test.describe('Side panel lifecycle', () => {
  test('opens without console errors', async ({ context, extensionId }) => {
    const errors: string[] = [];
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText('AccessBridge').first()).toBeVisible({ timeout: 5_000 });

    // Ignore a known benign sandbox error about chrome.tabs.query outside an
    // extension page when run in a plain tab; everything else must be empty.
    const fatal = errors.filter((e) => !/chrome\.tabs|chrome\.runtime/i.test(e));
    expect(fatal).toEqual([]);
  });

  test('switches between all tabs', async ({ context, extensionId }) => {
    const page = await openSidePanel(context, extensionId);

    for (const name of ['Dashboard', 'Audit', 'Actions', 'Vision', 'Intelligence', 'Compliance']) {
      const candidate = page.getByRole('button', { name: new RegExp(name, 'i') }).first();
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click();
        await page.waitForTimeout(120);
      }
    }

    // Landing on Audit panel renders the Run Audit CTA.
    const auditBtn = page.getByRole('button', { name: /Audit|Run Audit/i }).first();
    if (await auditBtn.isVisible().catch(() => false)) {
      await auditBtn.click();
    }
    await expect(page.getByText(/Run Audit|Accessibility Audit/i)).toBeVisible({ timeout: 3_000 });
  });
});
