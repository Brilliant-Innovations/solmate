#!/usr/bin/env node
// Bypass tests — ADR-0010 §4. A hand-written list of protections is disabled one at a time in the
// source, the mapped tests for that project are run, and the run MUST fail. A protection whose
// removal leaves the suite green is a protection nobody is testing. The source is restored after
// every case, whatever happens. Not a mutation-testing platform: each case names the exact line.
//
// Usage: node tools/check-bypass.mjs            (all cases)
//        node tools/check-bypass.mjs approval   (one case)

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CASES = [
  {
    name: 'approval',
    invariant: 'INV-10',
    file: 'libs/contracts/src/envelopes/approval.ts',
    project: '@sol-agent-trader/contracts',
    from: "  if (input.usedNonces.has(grant.nonce)) return { ok: false, reason: 'NONCE_REPLAYED' };",
    to: '  // BYPASS: replayed nonce accepted',
  },
  {
    name: 'entry-gate',
    invariant: 'INV-03',
    file: 'libs/risk/src/policy/eligibility-gate.ts',
    project: '@sol-agent-trader/risk',
    from: "  if (record.hardReject) return { allowed: false, reason: 'HARD_REJECT' };",
    to: '  // BYPASS: hard reject ignored',
  },
  {
    name: 'paused-entries',
    invariant: 'INV-05',
    file: 'libs/risk/src/runtime-session/machine.ts',
    project: '@sol-agent-trader/risk',
    from: "  return !s.paused && (s.activity === 'ACTIVE' || s.activity === 'EVENT_WINDOW') && s.authority !== 'OBSERVE';",
    to: "  return (s.activity === 'ACTIVE' || s.activity === 'EVENT_WINDOW') && s.authority !== 'OBSERVE'; // BYPASS: pause ignored",
  },
  {
    name: 'adversary-veto',
    invariant: 'INV-15',
    file: 'libs/risk/src/mandatory-exit/classifier.ts',
    project: '@sol-agent-trader/risk',
    from: '  void context;\n  const reasons: MandatoryExitReason[] = [];',
    to: "  const reasons: MandatoryExitReason[] = [];\n  if (context.adversaryVerdict === 'REJECT') return { mandatory: false, reasons, adversaryBlocking: true }; // BYPASS: adversary veto",
  },
  {
    name: 'exit-path',
    invariant: 'INV-21',
    file: 'libs/risk/src/safety/held-asset-safety.ts',
    project: '@sol-agent-trader/risk',
    from: '    canReduceNow: primaryRouteAvailable || emergencyRouteAvailable,',
    to: '    canReduceNow: primaryRouteAvailable, // BYPASS: emergency route ignored',
  },
];

const only = process.argv[2];
const selected = only ? CASES.filter((c) => c.name === only) : CASES;
if (selected.length === 0) {
  console.error(`unknown case ${only}; known: ${CASES.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
let failures = 0;
for (const c of selected) {
  const path = resolve(root, c.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(c.from)) {
    console.error(`::error::${c.name}: anchor not found in ${c.file}; the bypass list must follow the code`);
    failures++;
    continue;
  }
  writeFileSync(path, original.replace(c.from, c.to));
  let result;
  try {
    result = spawnSync(pnpm, ['nx', 'test', c.project, '--skip-nx-cache', '--output-style=static'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  } finally {
    writeFileSync(path, original);
  }
  const testsFailed = result.status !== 0;
  console.log(JSON.stringify({ check: 'bypass', case: c.name, invariant: c.invariant, file: c.file, testsFailedAsExpected: testsFailed }));
  if (!testsFailed) {
    console.error(`::error::${c.name}: removing the protection left ${c.project} tests green (${c.invariant} is not exercised)`);
    failures++;
  }
}
process.exit(failures === 0 ? 0 : 1);
