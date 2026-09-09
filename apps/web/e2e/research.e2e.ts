import { expect, test } from '@playwright/test';
import { signIn } from './helpers';
import { seeded } from './seed-state';

/**
 * §20.10, §20.11, §20.15, §20.16 (§24.7): the research surfaces render from the ledger and the
 * replay record under RLS, simulated time is labelled so a replay can never look like live
 * trading, S0_RAW and S0_SAFE stay separate, Trade History filters and exports as the signed-in
 * operator, and Attribution shows all three economic layers.
 */
test.describe('research surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('Replay Lab labels simulated time, lists the cost model and offers the run form to an operator', async ({ page }) => {
    await page.goto('/replay');
    await expect(page.getByRole('heading', { name: 'Replay Lab' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: /SIMULATED TIME/ })).toBeVisible();
    await expect(page.getByText(/replay-cost-v1/)).toBeVisible();
    await expect(page.getByRole('button', { name: /file replay run/i })).toBeVisible();
    await expect(page.getByLabel(/Fidelity/)).toBeVisible();
    // The seeded strategy version is offered as a checkbox; nothing is submitted by the suite.
    await expect(page.getByRole('checkbox', { name: new RegExp(seeded.strategyVersionId) })).toBeVisible();
  });

  test('Strategy Lab shows versions with their bindings and never merges S0 variants', async ({ page }) => {
    await page.goto('/strategy-lab');
    await expect(page.getByRole('heading', { name: 'Strategy Lab' })).toBeVisible();
    await expect(page.getByRole('cell', { name: seeded.strategyVersionId, exact: true }).first()).toBeVisible();
    await expect(page.getByText(/S0_RAW/).first()).toBeVisible();
    await expect(page.getByText(/S0_SAFE/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Parameter \/ version diffs/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Promotion \/ retirement history/ })).toBeVisible();
    await expect(page.getByText(/never edited in place/)).toBeVisible();
  });

  test('Trade History filters, shows the seeded lot with its cycle drill-down and exports as the signed-in operator', async ({ page }) => {
    await page.goto('/history?open=1');
    await expect(page.getByRole('heading', { name: 'Trade History' })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: seeded.symbol }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: 'entry' })).toHaveAttribute('href', `/agent-activity/${seeded.entryCycleId}`);
    await expect(page.getByRole('link', { name: 'CSV' })).toHaveAttribute('href', /\/api\/history\/export\?.*format=csv/);
    const json = await page.request.get('/api/history/export?open=1&format=json');
    expect(json.status()).toBe(200);
    const body = (await json.json()) as { rows: { lotId: string; strategyVersionId: string; entryCycleId: string | null }[] };
    const lot = body.rows.find((r) => r.lotId === seeded.lotId);
    expect(lot).toBeDefined();
    expect(lot!.strategyVersionId).toBe(seeded.strategyVersionId);
    expect(lot!.entryCycleId).toBe(seeded.entryCycleId);
    const csv = await page.request.get('/api/history/export?open=1&format=csv');
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain('lot_id,position_id');
    // Filtering by a strategy that does not exist yields no row, not an error.
    await page.goto('/history?open=1&strategy=NOPE@0');
    await expect(page.getByText(/No lot matches/)).toBeVisible();
  });

  test('Attribution shows trading, strategy-economic and platform-economic layers with unit costs', async ({ page }) => {
    await page.goto('/attribution?days=90');
    await expect(page.getByRole('heading', { name: /Attribution \/ Economics/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Trading P&L$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Strategy economic P&L/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Platform economic P&L/ })).toBeVisible();
    await expect(page.getByText(/final operating result/)).toBeVisible();
    await expect(page.getByText(/per candidate/)).toBeVisible();
    await expect(page.getByText(/Birdeye/).first()).toBeVisible();
  });

  test('the export endpoint refuses an anonymous request', async ({ browser }) => {
    const context = await browser.newContext();
    const res = await context.request.get('/api/history/export?format=json', { maxRedirects: 0 });
    // 401 from the handler, or the sign-in redirect from the app's auth guard: never rows.
    expect([401, 302, 307]).toContain(res.status());
    expect(res.headers()['content-type'] ?? '').not.toContain('application/json');
    await context.close();
  });
});
