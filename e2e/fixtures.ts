import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'path';
import { installAiMocks } from './utils/mock-ai.js';

const EXTENSION_PATH = resolve(__dirname, '..', 'packages/extension/dist');

export type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  /** Whether to intercept AI provider fetches with canned responses (default true).
   *  Set AB_E2E_REAL_AI=1 to hit real providers (never in CI). */
  useAiMocks: boolean;
};

export const test = base.extend<ExtensionFixtures>({
  useAiMocks: [process.env.AB_E2E_REAL_AI !== '1', { option: true }],

  context: async ({ useAiMocks }, use) => {
    const userDataDir = resolve(
      __dirname,
      '..',
      'test-results',
      `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      viewport: { width: 1280, height: 800 },
    });

    if (useAiMocks) await installAiMocks(ctx);

    await use(ctx);
    await ctx.close();
  },

  extensionId: async ({ context }, use) => {
    // MV3 extensions expose a service worker; its URL carries the extension ID.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });

    const id = new URL((sw as Worker).url()).host;
    await use(id);
  },
});

export { expect } from '@playwright/test';
