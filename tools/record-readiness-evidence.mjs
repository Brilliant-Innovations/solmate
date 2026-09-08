#!/usr/bin/env node
// Records Live Readiness evidence (§29, ADR-0004, ADR-0010 §5) as a RUN_READINESS_DRILL control
// request that the worker's `readiness` role turns into a row bound to the running deployment.
// The operator runs this locally after a drill, a probe or a CI run; nothing on GitHub holds a
// database credential. A PASS is accepted only from an admin with an evidence reference (and a
// verified step-up for drills and probes); a FAIL needs only an operator.
//
// Usage:
//   node tools/record-readiness-evidence.mjs --env deploy/profile-0/.env.worker \
//     --row INVARIANT_COVERAGE --kind CI_EVIDENCE --verdict PASS \
//     --evidence "https://github.com/<org>/<repo>/actions/runs/<id>" [--detail '{"job":"ci"}']

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
const envPath = arg('--env');
const rowId = arg('--row');
const kind = arg('--kind');
const verdict = arg('--verdict');
const evidenceRef = arg('--evidence') ?? null;
const detail = arg('--detail') ? JSON.parse(arg('--detail')) : {};
if (!envPath || !rowId || !kind || !verdict) {
  console.error('usage: --env <file> --row <ROW_ID> --kind DRILL|PROBE|CI_EVIDENCE --verdict PASS|FAIL|NOT_APPLICABLE [--evidence <ref>] [--detail <json>]');
  process.exit(2);
}
if (!['DRILL', 'PROBE', 'CI_EVIDENCE'].includes(kind) || !['PASS', 'FAIL', 'NOT_APPLICABLE'].includes(verdict)) {
  console.error('kind must be DRILL|PROBE|CI_EVIDENCE and verdict PASS|FAIL|NOT_APPLICABLE');
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(resolve(root, envPath), 'utf8')
    .replace(/^﻿/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const url = env['SUPABASE_DB_URL'];
const operator = env['OPERATOR_USER_ID'];
if (!url || !operator) {
  console.error('the env file must set SUPABASE_DB_URL and OPERATOR_USER_ID');
  process.exit(2);
}

// The db lib's own dependency, resolved from its package directory (pnpm keeps it there, not at the root).
const require = createRequire(resolve(root, 'libs/db/package.json'));
const postgres = require('postgres');
const sql = postgres(url, { max: 1, prepare: false });
try {
  const payload = { rowId, kind, verdict, evidenceRef, detail };
  const [row] = await sql`
    insert into ops.control_requests (requested_by, kind, payload)
    values (${operator}, 'RUN_READINESS_DRILL', ${sql.json(payload)})
    returning id, created_at`;
  console.log(JSON.stringify({ event: 'readiness_evidence_requested', requestId: row.id, rowId, kind, verdict, evidenceRef, createdAt: row.created_at, note: kind === 'CI_EVIDENCE' ? 'the readiness role records it on its next cycle' : 'a PASS drill/probe also needs a verified step-up on this request before the role records it' }));
} finally {
  await sql.end({ timeout: 5 });
}
