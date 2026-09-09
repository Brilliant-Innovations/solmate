import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Runs the seed in a plain Node process so the workspace packages load as the ESM they are built
 * as, outside Playwright's test transform (§24.7). The seed itself lives in seed.mjs.
 */
export default async function globalSetup(): Promise<void> {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'seed.mjs')], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`E2E seed failed with exit code ${r.status}`);
}
