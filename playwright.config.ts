import { defineConfig, devices } from '@playwright/test';

// Playwright config for AccessBridge extension E2E.
// Tests launch a persistent Chromium context with the built extension loaded
// via --load-extension (MV3 extensions cannot run in the default headless mode,
// so we force headful + xvfb in CI).

export default defineConfig({
  testDir: './e2e/specs',
  // Extensions share BrowserContext state per Chromium instance. Running serially
  // avoids port-in-use + extension-ID collisions; parallelism comes from CI sharding.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    // Extensions need real browser APIs; MV3 in new headless works but is still rough.
    // We default to headless: false; CI runs under xvfb-run.
    headless: false,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium-extension',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  globalSetup: './e2e/globalSetup.ts',
});
