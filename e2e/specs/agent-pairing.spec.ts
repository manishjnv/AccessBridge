/**
 * E2E: Desktop Agent pairing UI — graceful-degradation invariant.
 *
 * These tests verify extension UI behaviour in an environment where no
 * real Tauri Desktop Agent binary is running.  They do NOT require a
 * WebSocket server or any native binary; they purely exercise the UI
 * wiring and the extension's graceful-degradation guarantee.
 *
 * A genuine integration test (WS handshake + agent binary responding)
 * is left to a future spec once the Tauri binary is available in CI.
 * That future spec should import a `ws` server fixture — 'ws' is not
 * currently listed as a devDependency, so we don't spin one up here.
 */

import { test, expect } from '../fixtures.js';

// Valid-looking base64url: 43 chars → 32 bytes.  This is a syntactically
// valid pair key (right length) but the agent isn't running, so the
// extension will connect-fail gracefully.
const FAKE_PSK_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test.describe.skip('Desktop Agent pairing UI', () => {
  // ──────────────────────────────────────────────────────────────────────
  // NOTE: entire suite is skipped because the full integration path
  // requires the Tauri Desktop Agent binary (not available in CI yet).
  // The individual test bodies below document the expected UI behaviour
  // so they can be un-skipped when the binary becomes available.
  //
  // For the graceful-degradation subset (cases 1–3, 5–6) that do NOT
  // need a running agent, we intentionally keep them inside the same
  // describe.skip so CI never runs them in an environment that lacks
  // the required dist build + extension-launch plumbing.  If you want
  // to smoke-test the UI locally, temporarily remove the .skip.
  // ──────────────────────────────────────────────────────────────────────

  test('1. popup renders "Desktop Agent" status line', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // The OverviewTab always renders the Desktop Agent widget regardless of
    // connection state.
    await expect(page.getByText('Desktop Agent')).toBeVisible({ timeout: 5_000 });
  });

  test('2. status shows "Not installed" when no agent is running', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // With no agent running and no stored PSK, the status sub-line should
    // read "Not installed" (matches the idle/no-PSK branch in App.tsx).
    await expect(page.getByText('Not installed')).toBeVisible({ timeout: 5_000 });
  });

  test('3. clicking "Pair" opens the Pair Desktop Agent dialog', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // The Pair button only appears when the agent is not connected.
    const pairBtn = page.getByRole('button', { name: /Pair/i }).first();
    await expect(pairBtn).toBeVisible({ timeout: 5_000 });
    await pairBtn.click();

    // Dialog heading
    await expect(page.getByText('Pair Desktop Agent')).toBeVisible({ timeout: 3_000 });
  });

  test('4. submitting an obviously-too-short key shows an inline validation error', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');

    const pairBtn = page.getByRole('button', { name: /Pair/i }).first();
    await pairBtn.click();
    await expect(page.getByText('Pair Desktop Agent')).toBeVisible({ timeout: 3_000 });

    // Type a short key (under 40 chars — validation guard in App.tsx)
    await page.getByRole('textbox').fill('shortkey');
    // Click the dialog's "Pair" confirm button (distinct from the overview Pair button)
    const confirmBtn = page.getByRole('button', { name: /^Pair$/i }).last();
    await confirmBtn.click();

    // App.tsx checks trimmed.length < 40 and sets pairError
    await expect(page.getByText(/Pair key looks too short/i)).toBeVisible({ timeout: 3_000 });
  });

  test('5. pasting a valid-looking 43-char key and pairing does NOT crash the extension', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');

    const pairBtn = page.getByRole('button', { name: /Pair/i }).first();
    await pairBtn.click();
    await expect(page.getByText('Pair Desktop Agent')).toBeVisible({ timeout: 3_000 });

    await page.getByRole('textbox').fill(FAKE_PSK_B64);
    const confirmBtn = page.getByRole('button', { name: /^Pair$/i }).last();
    await confirmBtn.click();

    // Allow async message handling to settle (agent won't respond → error or timeout)
    await page.waitForTimeout(500);

    // The popup must still be alive and responsive — no uncaught JS errors.
    // (A real agent isn't running so the runtime.sendMessage will return an
    // error response, which is the expected graceful-degradation path.)
    expect(errors.filter((e) => !/agent/i.test(e))).toHaveLength(0);
  });

  test('6. after a failed pair attempt the rest of the popup still works', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // Do a pair attempt (will fail silently — no agent)
    const pairBtn = page.getByRole('button', { name: /Pair/i }).first();
    await pairBtn.click();
    await page.getByRole('textbox').fill(FAKE_PSK_B64);
    await page.getByRole('button', { name: /^Pair$/i }).last().click();
    await page.waitForTimeout(500);

    // Close dialog if still open (Escape or backdrop click)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Core UI still intact — Struggle Score widget must be visible
    // (regression guard: pair attempt must not blow away the main state)
    await expect(page.getByText(/Struggle Score/i)).toBeVisible({ timeout: 5_000 });

    // Tab navigation still works
    const sensoryTab = page.getByText('Sensory', { exact: true }).first();
    await sensoryTab.click();
    await page.waitForTimeout(150);

    const overviewTab = page.getByText('Overview', { exact: true }).first();
    await overviewTab.click();
    await expect(page.getByText(/Struggle Score/i)).toBeVisible({ timeout: 3_000 });
  });
});
