import { expect, test } from '@playwright/test';
import { OPERATIONAL_ROUTES, signIn, statusBar } from './helpers';

/** §24.7: PAPER and LIVE_AUTO are visually distinguishable on every primary route; pause is available from all operational surfaces. */
test.describe('capital authority and pause on every primary route', () => {
  test.beforeEach(async ({ page }) => signIn(page));

  for (const route of OPERATIONAL_ROUTES) {
    test(`${route}: PAPER is named, LIVE is not implied, PAUSE is reachable`, async ({ page }) => {
      await page.goto(route);
      const bar = statusBar(page);
      await expect(bar).toBeVisible();
      await expect(bar.getByText('PAPER', { exact: true })).toBeVisible();
      await expect(bar.getByText('LIVE_AUTO', { exact: true })).toHaveCount(0);
      await expect(page.locator('.shell')).toHaveAttribute('data-authority', 'PAPER');
      const pause = bar.getByRole('button', { name: /pause/i });
      await expect(pause).toBeVisible();
      // locked at aal1: the button exists and is disabled, never hidden (§20.24 degraded states)
      await expect(pause).toBeDisabled();
    });
  }

  test('an aal1 session sees controls locked with the reason, not a generic error', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('alert').filter({ hasText: /controls are locked/i })).toBeVisible();
  });
});
