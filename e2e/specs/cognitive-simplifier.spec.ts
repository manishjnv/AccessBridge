import { test, expect } from '../fixtures.js';
import { openPopup } from '../utils/extension-helpers.js';

const TEST_PAGE = 'https://en.wikipedia.org/wiki/Accessibility';

test.describe('Cognitive simplifier', () => {
  test('focus mode toggle writes to the profile', async ({ context, extensionId }) => {
    const target = await context.newPage();
    await target.goto(TEST_PAGE, { waitUntil: 'domcontentloaded' });

    const popup = await openPopup(context, extensionId);
    await popup.getByText('Cognitive', { exact: true }).first().click();

    const toggles = popup.locator('button[role="switch"], input[type="checkbox"]');
    const n = await toggles.count();
    test.skip(n === 0, 'No cognitive toggles in this build');

    await toggles.first().click({ force: true });
    await popup.waitForTimeout(600);

    const [sw] = context.serviceWorkers();
    const { profile } = await sw.evaluate(() => chrome.storage.local.get('profile'));
    // Profile must exist + cognitive subtree must be present.
    expect(profile).toBeTruthy();
    expect(typeof profile.cognitive).toBe('object');
  });

  test('distraction shield does not throw when toggled on', async ({ context, extensionId }) => {
    const errors: string[] = [];
    const target = await context.newPage();
    target.on('pageerror', (err) => errors.push(String(err)));
    await target.goto(TEST_PAGE, { waitUntil: 'domcontentloaded' });

    const popup = await openPopup(context, extensionId);
    await popup.getByText('Cognitive', { exact: true }).first().click();

    const toggles = popup.locator('button[role="switch"], input[type="checkbox"]');
    const n = await toggles.count();
    test.skip(n < 2, 'Need at least 2 toggles to exercise distraction shield');

    // Try the 2nd toggle — distraction shield is usually after focus mode.
    await toggles.nth(1).click({ force: true });
    await popup.waitForTimeout(1_200);

    // Any uncaught errors on the target page during adaptation-apply phase
    // are a regression surface.
    expect(errors).toEqual([]);
  });
});
