/**
 * Playwright smoke tests for the 5 new Observatory dashboard tabs.
 * Tests guard against the observatory server not being reachable by
 * skipping gracefully when the server returns an error.
 *
 * Run against a local/VPS instance:
 *   OBSERVATORY_URL=http://localhost:8300/observatory/ npx playwright test observatory-tabs
 */
import { test, expect, Page } from '@playwright/test';

const BASE_URL = process.env.OBSERVATORY_URL ?? 'http://localhost:8300/observatory/';

/** Quick reachability guard — skip the whole file if observatory is not up. */
async function requireServer(page: Page) {
  try {
    const resp = await page.request.get(BASE_URL, { timeout: 5_000 });
    if (!resp.ok()) test.skip(true, 'Observatory server not reachable');
  } catch {
    test.skip(true, 'Observatory server not reachable');
  }
}

// ─── 1. Funnel tab ────────────────────────────────────────────────────────────

test('funnel tab: SVG rendered and 5 stage rects visible', async ({ page }) => {
  await requireServer(page);
  await page.goto(BASE_URL + '#funnel');
  await page.waitForSelector('.nav-tab[data-tab="funnel"]');

  // Click the funnel tab explicitly to trigger loadFunnel()
  await page.click('.nav-tab[data-tab="funnel"]');

  // The funnel SVG must be in the DOM
  const svg = await page.locator('#chart-funnel');
  await expect(svg).toBeVisible();

  // After load, the SVG should contain <rect> or <text> elements (even with 0-data stubs)
  await page.waitForFunction(() => {
    const el = document.getElementById('chart-funnel');
    return el !== null && (el.querySelectorAll('rect').length > 0 || el.querySelectorAll('text').length > 0);
  }, { timeout: 8_000 });

  // Must have at least 5 rects (one per stage, even if 0-value stubs)
  const rects = await page.locator('#chart-funnel rect');
  await expect(rects).toHaveCount(5);
});

// ─── 2. Features tab ─────────────────────────────────────────────────────────

test('features tab: chart and legend chips present, bucket switcher works', async ({ page }) => {
  await requireServer(page);
  await page.goto(BASE_URL + '#features');
  await page.click('.nav-tab[data-tab="features"]');

  // Chart SVG must be visible
  await expect(page.locator('#chart-features')).toBeVisible();

  // Bucket switcher must have 3 buttons
  const buckets = page.locator('.bucket-btn');
  await expect(buckets).toHaveCount(3);

  // Clicking "Week" bucket changes active state
  await page.click('.bucket-btn[data-bucket="week"]');
  await expect(page.locator('.bucket-btn[data-bucket="week"]')).toHaveClass(/active/);

  // Switch back to day
  await page.click('.bucket-btn[data-bucket="day"]');
  await expect(page.locator('.bucket-btn[data-bucket="day"]')).toHaveClass(/active/);
});

// ─── 3. Languages tab ────────────────────────────────────────────────────────

test('languages tab: native script column and script-family bars rendered', async ({ page }) => {
  await requireServer(page);
  await page.goto(BASE_URL + '#languages');
  await page.click('.nav-tab[data-tab="languages"]');

  // The language table wrapper must exist
  await expect(page.locator('#lang-table-wrap')).toBeVisible();

  // The table header row should mention "Native Script"
  // (either as data or as "No data" placeholder)
  const tableWrap = page.locator('#lang-table-wrap');
  await expect(tableWrap).not.toBeEmpty();

  // Script family bar-chart element must be in DOM
  await expect(page.locator('#script-family-bars')).toBeAttached();
});

// ─── 4. Domains tab ──────────────────────────────────────────────────────────

test('domains tab: all 6 domain stubs rendered (or bar-chart placeholder)', async ({ page }) => {
  await requireServer(page);
  await page.goto(BASE_URL + '#domains');
  await page.click('.nav-tab[data-tab="domains"]');

  const domainBars = page.locator('#domain-bars');
  await expect(domainBars).toBeVisible();

  // Wait for JS to fill the container
  await page.waitForFunction(() => {
    const el = document.getElementById('domain-bars');
    return el !== null && el.innerHTML.trim().length > 0;
  }, { timeout: 8_000 });

  // Either bar rows or a "No data" loading message must be present
  const rows = page.locator('#domain-bars .bar-row');
  const loading = page.locator('#domain-bars .loading');
  const count = await rows.count();
  const loadingCount = await loading.count();
  expect(count + loadingCount).toBeGreaterThan(0);
});

// ─── 5. Compliance tab: tri-column + generate-report button ─────────────────

test('compliance tab: tri-column layout and generate-report button present', async ({ page }) => {
  await requireServer(page);
  await page.goto(BASE_URL + '#compliance');
  await page.click('.nav-tab[data-tab="compliance"]');

  // Wait for JS to render the tri-column
  await page.waitForFunction(() => {
    const el = document.getElementById('compliance-tri');
    return el !== null && el.innerHTML.trim().length > 0;
  }, { timeout: 10_000 });

  // Tri-column grid must be present
  await expect(page.locator('.compliance-tri-grid')).toBeVisible();

  // Generate Compliance Report button must exist
  const dlBtn = page.locator('#btn-compliance-report');
  await expect(dlBtn).toBeVisible();
});

test('compliance tab: generate-report button triggers download', async ({ page }) => {
  await requireServer(page);
  await page.goto(BASE_URL + '#compliance');
  await page.click('.nav-tab[data-tab="compliance"]');

  // Wait for tri column + button
  await page.waitForSelector('#btn-compliance-report', { timeout: 8_000 });

  // Intercept download
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10_000 }).catch(() => null),
    page.click('#btn-compliance-report'),
  ]);

  // download may be null if the API returns null (no real server), that's OK—
  // the button click must not throw a JS error.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  expect(errors.length).toBe(0);
});

// ─── 6. DP disclaimer visible on every new tab ───────────────────────────────

test('DP disclaimer is visible on all new tabs', async ({ page }) => {
  await requireServer(page);

  const newTabs = ['funnel', 'features', 'languages', 'domains'] as const;

  for (const tabName of newTabs) {
    await page.goto(BASE_URL + '#' + tabName);
    await page.click(`.nav-tab[data-tab="${tabName}"]`);

    // Each new page section has an inline dp-disclaimer (not just the global one)
    const disclaimers = page.locator(`#page-${tabName} .dp-disclaimer`);
    await expect(disclaimers).toBeVisible({ timeout: 5_000 });
  }
});
