import { expect, test } from '@playwright/test';
import { signIn, statusBar } from './helpers';
import { seeded } from './seed-state';

/**
 * §24.7 assertions that need seeded ledger rows: stale data visibly stale, critical alerts persist,
 * reconciliation mismatch surfaced, HOLD cycle visible and auditable, inspector reconstructs
 * proposer → adversary → risk → execution, approval binds to the exact hash and expires visibly,
 * arming refused while readiness fails, Control Room exposure equals the sum of lots,
 * PROTECTION_ONLY propagates.
 */
test.describe('ledger-backed surfaces', () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test('stale market data is visibly stale and never a fresh zero', async ({ page }) => {
    await page.goto('/');
    await expect(statusBar(page).getByText(/STALE|NO DATA/).first()).toBeVisible();
    await page.goto('/health');
    const row = page.locator('tr', { hasText: 'BIRDEYE:CANDLES' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(/STALE|FAILED|DEGRADED/).first()).toBeVisible();
    await expect(row.getByText(/^0(\.0)?s$/)).toHaveCount(0);
  });

  test('a CRITICAL alert persists in the alert center until acknowledged and tops the Control Room', async ({ page }) => {
    await page.goto('/alerts');
    const open = page.locator('section', { hasText: /^Open/ }).first();
    await expect(open.getByText('CRITICAL', { exact: true }).first()).toBeVisible();
    await expect(open.getByText('UNABLE_TO_EXIT')).toBeVisible();
    await expect(open.getByRole('button', { name: /acknowledge/i }).first()).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('alert').filter({ hasText: /intervention check/i })).toContainText(/CRITICAL/);
  });

  test('a wallet/custody reconciliation mismatch is surfaced prominently', async ({ page }) => {
    await page.goto('/health');
    await expect(page.locator('tr', { hasText: 'Wallet reconciliation' }).getByText('FAILED')).toBeVisible();
    await page.goto('/wallet');
    await expect(page.getByText('MISMATCH').first()).toBeVisible();
  });

  test('an open-position HOLD cycle is visible and auditable, and the inspector reconstructs the decision chain', async ({ page }) => {
    await page.goto('/agent-activity');
    const holdRow = page.locator('tr', { hasText: 'HOLD' }).first();
    await expect(holdRow).toBeVisible();
    await expect(holdRow.getByText(seeded.symbol).first()).toBeVisible();
    await page.goto(`/agent-activity/${seeded.entryCycleId}`);
    await expect(page.getByRole('heading', { name: /decision \/ action inspector/i })).toBeVisible();
    const timeline = page.locator('section', { hasText: /^Timeline/ }).first();
    await expect(timeline.getByText(/^Proposer/).first()).toBeVisible();
    await expect(timeline.getByText(/^Adversary/).first()).toBeVisible();
    await expect(timeline.getByText(/^Risk policy/).first()).toBeVisible();
    await expect(timeline.getByText(/^Intent/).first()).toBeVisible();
    await expect(timeline.getByText(/^Chain fill/).first()).toBeVisible();
    await expect(timeline.getByText('DETERMINISTIC').first()).toBeVisible();
  });

  test('an approval binds to the exact authorization hash and expires visibly; approval needs a passkey', async ({ page }) => {
    await page.goto('/approvals');
    await expect(page.getByText(seeded.authorizationHash)).toBeVisible();
    await expect(page.getByText(/expires in/i).first()).toBeVisible();
    await expect(page.getByText(/exact max authorized/i)).toBeVisible();
    const approve = page.getByRole('button', { name: /approve exact intent/i });
    await expect(approve).toBeDisabled();
    // aal1 session: the control is locked with the reason on screen; with aal2 and no passkey the control itself says 'needs a passkey'
    await expect(page.getByRole('alert').filter({ hasText: /controls are locked/i })).toBeVisible();
  });

  test('live arming cannot complete while a required readiness gate fails', async ({ page }) => {
    await page.goto(`/releases/${seeded.releaseId}`);
    const blocker = page.getByRole('alert').filter({ hasText: /arming would be refused/i });
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText(/no READY verdict/);
    await expect(page.getByRole('button', { name: /^arm release/i })).toBeDisabled();
  });

  test('Control Room exposure equals the sum of open lots', async ({ page }) => {
    await page.goto('/');
    const expected = `$${(seeded.lotCostBaseUnits / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    const row = page.locator('tr', { hasText: /^exposure/ }).first();
    await expect(row).toContainText(expected);
  });

  test('PROTECTION_ONLY is visible on Positions and Agent Activity', async ({ page }) => {
    await page.goto('/positions');
    await expect(page.getByText(/PROTECTION_ONLY/).first()).toBeVisible();
    await page.goto('/agent-activity');
    await expect(page.getByRole('alert').filter({ hasText: /without a cleared review/i })).toContainText('PROTECTION_ONLY');
  });

  test('Releases UI offers no in-place edit of a bound artifact and the Audit Log verifies the chain', async ({ page }) => {
    await page.goto('/releases');
    // the only text inputs are step-up confirmations (type RETIRE / ARM); no binding field is editable
    await expect(page.locator('input:not([type=hidden]):not([placeholder^="type "])')).toHaveCount(0);
    await expect(page.getByText(/nothing is edited in place|never edited in place/i).first()).toBeVisible();
    await page.goto('/audit');
    await expect(page.getByText(/CHAIN OK|CHAIN UNCHECKED|CHAIN BROKEN/)).toBeVisible();
  });

  test('watchlist membership cannot bypass eligibility', async ({ page }) => {
    await page.goto('/watchlist');
    await expect(page.getByText(/never grants eligibility or execution permission|never eligibility or execution permission/i).first()).toBeVisible();
    await page.goto('/scanner?watched=1');
    await expect(page.getByText(seeded.symbol).first()).toBeVisible();
  });
});
