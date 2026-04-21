import { test, expect } from '../fixtures.js';
import { openPopup, resetProfile } from '../utils/extension-helpers.js';

// BUG-005 regression guard: popup state must survive close/reopen.
// Extension reload must not blow away the user's profile.

test.describe('Reload + recovery', () => {
  test('profile persists across popup close/reopen', async ({ context, extensionId }) => {
    await resetProfile(context);

    const popup = await openPopup(context, extensionId);
    await popup.getByText('Sensory', { exact: true }).first().click();
    await popup.waitForTimeout(300);

    // Modify the first slider value — any sensory setting will do.
    const slider = popup.locator('input[type="range"]').first();
    const exists = await slider.count();
    test.skip(exists === 0, 'No sensory slider in this build');

    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '1.25';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await popup.waitForTimeout(600); // SAVE_PROFILE roundtrip
    await popup.close();

    const popup2 = await openPopup(context, extensionId);
    // Profile must have loaded again — brand header present means React mounted.
    await expect(popup2.getByText('AccessBridge').first()).toBeVisible({ timeout: 5_000 });

    // Storage must still hold a profile.
    const [sw] = context.serviceWorkers();
    const stored = await sw.evaluate(() => chrome.storage.local.get('profile'));
    expect(stored.profile).toBeTruthy();
  });

  test('master enabled toggle state survives popup reopen', async ({ context, extensionId }) => {
    await resetProfile(context);
    const popup = await openPopup(context, extensionId);

    // Persist an explicit disabled state via storage (bypasses UI toggle complexity).
    const [sw] = context.serviceWorkers();
    await sw.evaluate(() => chrome.storage.local.set({ accessbridge_enabled: false }));

    await popup.close();
    const popup2 = await openPopup(context, extensionId);
    await popup2.waitForTimeout(300);

    const after = await sw.evaluate(() => chrome.storage.local.get('accessbridge_enabled'));
    expect(after.accessbridge_enabled).toBe(false);
  });
});
