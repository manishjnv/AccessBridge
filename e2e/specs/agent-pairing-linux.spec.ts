/**
 * E2E: Desktop Agent pairing UI — Linux-specific behaviour (Session 22).
 *
 * These tests verify extension UI behaviour specific to a Linux agent
 * connection.  They require:
 *   1. The Tauri binary compiled for Linux (`.deb` / `AppImage`)
 *   2. A running X11 or Wayland display server (or Xvfb in CI)
 *   3. The extension loaded from `packages/extension/dist`
 *
 * Because the Linux Tauri binary is not yet available in CI the entire
 * suite is wrapped in `test.describe.skip`.  To run locally:
 *   1. Build the Linux agent: `pnpm tauri:build` on a Linux host or WSL2
 *   2. Launch the agent binary
 *   3. Remove the `.skip` temporarily (do NOT commit the removal)
 *   4. Run: `npx playwright test e2e/specs/agent-pairing-linux.spec.ts`
 */

import { test, expect } from '../fixtures.js';

// Valid-looking 43-char base64url → 32 bytes. Syntactically correct but the
// agent isn't running in CI, so the extension will fail gracefully.
const FAKE_PSK_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// The badge text the popup shows after a successful Linux agent connection.
// Composed from AgentInfo.platform + AgentInfo.distroHint + AgentInfo.version.
const LINUX_BADGE_TEXT = 'Connected (Ubuntu 24.04, v0.21.0)';

// The .deb download button "recommended" CSS class name.
// Check UI_GUIDELINES.md if the token name changes.
const RECOMMENDED_CLASS = 'recommended';

test.describe.skip('Desktop Agent pairing — Linux agent', () => {
  // ──────────────────────────────────────────────────────────────────────
  // NOTE: entire suite skipped — Linux Tauri binary not available in CI.
  //
  // Individual tests document expected UI behaviour so they can be
  // un-skipped when the binary becomes available (remove the .skip from
  // `test.describe.skip` above — do NOT commit without it).
  //
  // For local execution, set AGENT_BUILD_DONE=1 in your shell and ensure
  // the desktop agent binary is running before launching Playwright.
  // ──────────────────────────────────────────────────────────────────────

  test('1. Linux agent pair dialog shows the correct PSK path hint', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // Navigate to Settings → Pair with Desktop Agent
    const settingsTab = page.getByText('Settings', { exact: true }).first();
    await settingsTab.click();
    await page.waitForTimeout(150);

    // Open the Pair dialog
    const pairBtn = page.getByRole('button', { name: /Pair/i }).first();
    await expect(pairBtn).toBeVisible({ timeout: 5_000 });
    await pairBtn.click();

    // Dialog heading should be present
    await expect(page.getByText('Pair Desktop Agent')).toBeVisible({ timeout: 3_000 });

    // The dialog must contain a hint text referencing the Linux PSK file path.
    // This text is rendered from the comment block in agent-bridge.ts and should
    // appear in the pair dialog's helper text / tooltip.
    await expect(
      page.getByText(/\$XDG_RUNTIME_DIR\/accessbridge\/pair\.key/i),
    ).toBeVisible({ timeout: 3_000 });
  });

  test('2. Popup badge shows "Connected (Ubuntu 24.04, v0.21.0)" after a Linux agent pairs', async ({ context, extensionId }) => {
    const page = await context.newPage();

    // Inject a mocked agentLastKnownInfo into chrome.storage so the popup
    // reads it on load (simulates a previously-connected Linux agent).
    await page.addInitScript(() => {
      // Override chrome.storage.local.get to return our mock Linux agent info.
      const origGet = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = (key: string) => {
        if (key === 'agentLastKnownInfo') {
          return Promise.resolve({
            agentLastKnownInfo: {
              version: '0.21.0',
              platform: 'linux',
              capabilities: ['ipc', 'font-scale', 'cursor-size'],
              distroHint: 'ubuntu-24.04',
            },
          });
        }
        if (key === 'agentLastStatus') {
          return Promise.resolve({
            agentLastStatus: {
              connected: true,
              state: 'connected',
              agentInfo: {
                version: '0.21.0',
                platform: 'linux',
                capabilities: ['ipc', 'font-scale', 'cursor-size'],
                distroHint: 'ubuntu-24.04',
              },
              server: null,
              lastError: null,
              updatedAt: Date.now(),
            },
          });
        }
        return origGet(key);
      };
    });

    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // The popup overview tab should show the connected badge with distro info.
    await expect(page.getByText(LINUX_BADGE_TEXT)).toBeVisible({ timeout: 5_000 });
  });

  test('3. Landing page Linux tab auto-selects .deb for Ubuntu UA', async ({ context }) => {
    const page = await context.newPage();

    // Override the user-agent to an Ubuntu-identifying string before navigation.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        value:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36 Ubuntu',
        configurable: true,
      });
    });

    // Navigate to the landing page (nginx proxy on port 8300 per RCA BUG-002).
    // In local E2E runs the landing page is served from deploy/index.html.
    await page.goto('https://accessbridge.space/');
    await page.waitForLoadState('domcontentloaded');

    // The page should auto-select the Linux tab / section.
    // We look for a download button that targets .deb packages.
    const debButton = page.getByRole('link', { name: /\.deb/i }).first();
    await expect(debButton).toBeVisible({ timeout: 10_000 });

    // For Ubuntu UA the .deb button should carry the "recommended" class.
    await expect(debButton).toHaveClass(new RegExp(RECOMMENDED_CLASS), { timeout: 3_000 });
  });
});
