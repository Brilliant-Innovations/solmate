#!/usr/bin/env node
/**
 * Operator presence heartbeat for an attended paper session (blueprint D2, §20.21; plan M5a).
 *
 *   node tools/session-presence.mjs <env-file> [--once]
 *
 * Reads SUPABASE_DB_URL from the env file (never printed), finds the open runtime session of the
 * paper account and stamps `last_presence_heartbeat_at` every 60 s while this process runs. Close
 * it and the session role drops ACTIVE → WATCH after the presence timeout. This is operator
 * tooling: it holds no trading authority and the web app's presence widget replaces it.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postgres = require('../libs/db/node_modules/postgres');

const [envFile, ...flags] = process.argv.slice(2);
if (!envFile) {
  console.error('usage: node tools/session-presence.mjs <env-file> [--once]');
  process.exit(2);
}
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
if (!env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL missing from env file');
  process.exit(2);
}
const sql = postgres(env.SUPABASE_DB_URL, { prepare: false, max: 1 });
const once = flags.includes('--once');

async function beat() {
  const rows = await sql`
    update ops.runtime_sessions s set last_presence_heartbeat_at = now()
    from trading.accounts a
    where a.id = s.account_id and a.mode = 'PAPER' and s.activity_state <> 'OFF'
    returning s.id, s.activity_state, (s.paused ->> 'active')::boolean as paused`;
  const at = new Date().toISOString();
  if (rows.length === 0) console.log(JSON.stringify({ at, event: 'no_open_session' }));
  for (const r of rows) console.log(JSON.stringify({ at, event: 'presence_heartbeat', sessionId: r.id, activity: r.activity_state, paused: r.paused }));
}

await beat();
if (once) {
  await sql.end();
  process.exit(0);
}
const timer = setInterval(() => beat().catch((err) => console.error(JSON.stringify({ event: 'heartbeat_failed', error: String(err) }))), 60_000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    clearInterval(timer);
    await sql.end();
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'presence_stopped' }));
    process.exit(0);
  });
}
