import { expect, test } from '@playwright/test';
import { signIn, statusBar } from './helpers';
import { seeded } from './seed-state';

/** §24.7 / §20.22: mobile can pause and emergency-close without desktop navigation. */
test.describe('mobile operational surface', () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test('pause, positions with close, alerts and approvals are reachable from the compact nav', async ({ page }) => {
    await page.goto('/');
    await expect(statusBar(page).getByRole('button', { name: /pause/i })).toBeVisible();
    const nav = page.getByRole('navigation', { name: /primary \(compact\)/i });
    await expect(nav).toBeVisible();
    await nav.getByRole('link', { name: 'Positions' }).click();
    const cards = page.getByLabel(/open positions \(compact\)/i);
    await expect(cards).toBeVisible();
    await expect(cards.getByText(seeded.symbol).first()).toBeVisible();
    await expect(cards.getByRole('button', { name: /^close$/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /emergency close all/i })).toBeVisible();
    await nav.getByRole('link', { name: 'Alerts' }).click();
    await expect(page.getByText('CRITICAL', { exact: true }).first()).toBeVisible();
    await nav.getByRole('link', { name: 'Approvals' }).click();
    await expect(page.getByRole('heading', { name: /approval queue/i })).toBeVisible();
  });
});
