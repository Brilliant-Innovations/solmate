import { expect, type Page } from '@playwright/test';

export const OPERATOR = { email: 'e2e-operator@example.test', password: 'e2e-operator-password-1' };

/** Password sign-in (aal1). Controls stay locked (no TOTP) but every read surface renders; the suite asserts rendering and lock behaviour, never a live action. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(OPERATOR.email);
  await page.getByLabel(/password/i).fill(OPERATOR.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('status', { name: /runtime status/i })).toBeVisible();
}

/** The persistent status bar (§20.1). */
export function statusBar(page: Page) {
  return page.getByRole('status', { name: /runtime status/i });
}

export const OPERATIONAL_ROUTES = ['/', '/positions', '/alerts', '/approvals', '/agent-activity', '/health', '/wallet', '/scanner', '/readiness', '/releases'];
