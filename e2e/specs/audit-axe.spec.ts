import { test, expect } from '../fixtures.js';
import { openSidePanel } from '../utils/extension-helpers.js';

// Session 18 headline: axe-core integration produces merged findings with
// source badges + a valid PDF export.

const TEST_PAGE = 'https://en.wikipedia.org/wiki/Accessibility';

test.describe('Accessibility audit + axe-core + PDF', () => {
  test('running audit on Wikipedia produces merged findings with source badges', async ({ context, extensionId }) => {
    // Open the test page first so there's an active tab for the audit to target.
    const target = await context.newPage();
    await target.goto(TEST_PAGE, { waitUntil: 'domcontentloaded' });

    const panel = await openSidePanel(context, extensionId);

    // Navigate to the Audit tab if the sidepanel opens on Dashboard.
    const auditTab = panel.getByRole('button', { name: /^Audit$/i }).first();
    if (await auditTab.isVisible().catch(() => false)) await auditTab.click();

    await panel.getByRole('button', { name: /Run Audit/i }).click();

    // Allow up to 30 s for the scan + axe to complete.
    await expect(panel.getByText(/findings/i)).toBeVisible({ timeout: 45_000 });

    // At least one source chip must appear (custom, axe, or both).
    const sourceChips = panel.locator('.ab-source-chip');
    const chipCount = await sourceChips.count();
    expect(chipCount).toBeGreaterThanOrEqual(1);

    // At least one finding badge in {custom, axe, both}.
    const anyBadge = panel.locator('.ab-finding-source').first();
    await expect(anyBadge).toBeVisible({ timeout: 5_000 });
  });

  test('PDF export produces a valid file', async ({ context, extensionId }) => {
    const target = await context.newPage();
    await target.goto(TEST_PAGE, { waitUntil: 'domcontentloaded' });

    const panel = await openSidePanel(context, extensionId);
    const auditTab = panel.getByRole('button', { name: /^Audit$/i }).first();
    if (await auditTab.isVisible().catch(() => false)) await auditTab.click();

    await panel.getByRole('button', { name: /Run Audit/i }).click();
    await expect(panel.getByText(/findings/i)).toBeVisible({ timeout: 45_000 });

    const downloadPromise = panel.waitForEvent('download', { timeout: 15_000 });
    await panel.getByRole('button', { name: /Export PDF/i }).click();
    const download = await downloadPromise;

    const suggested = download.suggestedFilename();
    expect(suggested).toMatch(/\.pdf$/i);

    // Read first 5 bytes + last 6 — a valid PDF starts with "%PDF-" and ends with "%%EOF".
    const path = await download.path();
    expect(path).toBeTruthy();
    const fs = await import('fs/promises');
    const buf = await fs.readFile(path!);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.subarray(-6).toString('ascii').trim()).toContain('%%EOF');
  });
});
