#!/usr/bin/env node
/**
 * Operator control requests from the terminal (blueprint §20.23, §23.3; plan M5a).
 *
 *   node tools/session-control.mjs <env-file> start|end|pause [--user <auth user id>]
 *
 * Inserts a PENDING row into ops.control_requests exactly as the web app does; the worker's
 * session role validates state and resolves it with an audit row. RESUME is deliberately absent
 * here: it needs a passkey step-up assertion bound to the request, which only the web flow can
 * produce (D41, ADR-0006). The requesting operator's auth user id comes from --user or
 * OPERATOR_USER_ID in the env file; the service-role connection carries no auth.uid().
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postgres = require('../libs/db/node_modules/postgres');

const KINDS = { start: 'START_SESSION', end: 'END_SESSION', pause: 'PAUSE_NEW_ENTRIES' };
const [envFile, action, ...rest] = process.argv.slice(2);
const kind = KINDS[action ?? ''];
if (!envFile || !kind) {
  console.error('usage: node tools/session-control.mjs <env-file> start|end|pause [--user <auth user id>]');
  process.exit(2);
}
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const userFlag = rest.indexOf('--user');
const user = userFlag >= 0 ? rest[userFlag + 1] : env.OPERATOR_USER_ID;
if (!env.SUPABASE_DB_URL || !user) {
  console.error('SUPABASE_DB_URL and an operator auth user id (--user or OPERATOR_USER_ID) are required');
  process.exit(2);
}
const sql = postgres(env.SUPABASE_DB_URL, { prepare: false, max: 1 });
const [row] = await sql`
  insert into ops.control_requests (requested_by, kind, payload) values (${user}, ${kind}, ${sql.json({ source: 'tools/session-control' })}) returning id, kind, state, created_at`;
console.log(JSON.stringify({ event: 'control_request_created', id: row.id, kind: row.kind, state: row.state, createdAt: row.created_at }));
await sql.end();
