#!/usr/bin/env node
// Files a replay run (blueprint §18, P9; execution plan M10) as a RUN_REPLAY control request that
// the worker's `replay` role validates, binds to the running versions and executes. The operator
// runs this locally against the worker env; the Replay Lab (M9 step 8) files the same request
// from the browser. Nothing on GitHub holds a database credential.
//
// Usage:
//   node tools/replay.mjs --env deploy/profile-0/.env.worker --name "S0 gate value, week 1" \
//     --from 2026-09-08T00:00:00Z --to 2026-09-09T00:00:00Z [--fidelity B_CAPTURED|A_HISTORICAL] \
//     [--strategies S0_RAW@1.0.0,S0_SAFE@1.0.0] [--baseline S0_RAW@1.0.0] [--holdout 2026-09-08T12:00:00Z] \
//     [--seed 7] [--assets <uuid,uuid>] [--no-latency-matched] [--no-proposer-only]
//   node tools/replay.mjs --env deploy/profile-0/.env.worker --list

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);
const envPath = arg('--env');
if (!envPath) {
  console.error('usage: node tools/replay.mjs --env <worker env file> (--list | --name <n> --from <iso> --to <iso> [options])');
  process.exit(2);
}
const env = Object.fromEntries(
  readFileSync(resolve(root, envPath), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const require = createRequire(resolve(root, 'libs/db/package.json'));
const postgres = require('postgres');
const dbUrl = env.SUPABASE_DB_URL;
const operatorId = env.OPERATOR_USER_ID;
if (!dbUrl || !operatorId) {
  console.error('the env file needs SUPABASE_DB_URL and OPERATOR_USER_ID');
  process.exit(2);
}
const sql = postgres(dbUrl, { max: 1, prepare: false });

try {
  if (flag('--list')) {
    const rows = await sql`select id, name, fidelity, status, window_from, window_to, strategy_version_ids, decisions_digest, error, created_at, completed_at from research.replay_runs order by created_at desc limit 20`;
    for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(9)}  ${r.fidelity.padEnd(12)}  ${r.window_from.toISOString()} → ${r.window_to.toISOString()}  ${r.strategy_version_ids.join(',')}  ${r.name}${r.error ? `  ERROR: ${r.error}` : ''}${r.decisions_digest ? `  digest ${r.decisions_digest.slice(0, 12)}` : ''}`);
    if (rows.length === 0) console.log('no replay runs yet');
  } else {
    const name = arg('--name');
    const from = arg('--from');
    const to = arg('--to');
    if (!name || !from || !to) {
      console.error('--name, --from and --to are required');
      process.exit(2);
    }
    const strategies = (arg('--strategies') ?? 'S0_RAW@1.0.0,S0_SAFE@1.0.0').split(',').map((s) => s.trim()).filter(Boolean);
    const payload = {
      name,
      fidelity: arg('--fidelity') ?? 'B_CAPTURED',
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), inSampleUntil: arg('--holdout') ? new Date(arg('--holdout')).toISOString() : null },
      strategyVersionIds: strategies,
      baselineStrategyVersionId: arg('--baseline') ?? strategies[0],
      seed: Number(arg('--seed') ?? 0),
      latencyMatchedBaseline: !flag('--no-latency-matched'),
      proposerOnlyShadow: !flag('--no-proposer-only'),
      assetIds: arg('--assets') ? arg('--assets').split(',').map((s) => s.trim()) : null,
    };
    const [row] = await sql`insert into ops.control_requests (requested_by, kind, payload) values (${operatorId}, 'RUN_REPLAY', ${sql.json(payload)}) returning id`;
    console.log(`filed RUN_REPLAY ${row.id}; the worker's replay role queues and executes it (node tools/replay.mjs --env ${envPath} --list)`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
