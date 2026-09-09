import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * §24.7 UI/UX end-to-end suite against the local Supabase (every migration applied by `supabase
 * start`) and a production build of the web app. The global setup seeds one operator plus the
 * ledger rows each assertion needs; nothing here touches a hosted project or any live credential.
 * `supabase status -o env` supplies the local URL, publishable and service-role keys at run time
 * so no key is committed (the local demo keys are public, the discipline is the same).
 */
const here = __dirname;
const webDir = path.resolve(here, '..');
const repoDir = path.resolve(webDir, '../..');

function localSupabase(): Record<string, string> {
  const out = execSync('pnpm exec supabase status -o env', { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const env: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}

const local = process.env['E2E_SKIP_SUPABASE_STATUS'] ? {} : localSupabase();
const port = Number(process.env['E2E_PORT'] ?? 3100);
const supabaseUrl = process.env['E2E_SUPABASE_URL'] ?? local['API_URL'] ?? 'http://127.0.0.1:54321';
const publishableKey = process.env['E2E_SUPABASE_PUBLISHABLE_KEY'] ?? local['PUBLISHABLE_KEY'] ?? local['ANON_KEY'] ?? '';
process.env['E2E_DB_URL'] = process.env['E2E_DB_URL'] ?? local['DB_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';
process.env['E2E_SUPABASE_URL'] = supabaseUrl;
process.env['E2E_SERVICE_ROLE_KEY'] = process.env['E2E_SERVICE_ROLE_KEY'] ?? local['SERVICE_ROLE_KEY'] ?? local['SECRET_KEY'] ?? '';

export default defineConfig({
  testDir: here,
  testMatch: /.*\.e2e\.ts/,
  globalSetup: path.join(here, 'global-setup.ts'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile.e2e.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.e2e\.ts/ },
  ],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${port}`,
    cwd: webDir,
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 600_000,
    reuseExistingServer: !process.env['CI'],
    env: {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
