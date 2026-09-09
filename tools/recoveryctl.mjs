#!/usr/bin/env node
/**
 * recoveryctl — signer/custody break-glass control, D25 plane 2 (blueprint D53, D54, §15.7, §22.5
 * "complete infrastructure loss"; plan M3 runbook skeleton).
 *
 *   node tools/recoveryctl.mjs <recovery-env-file> enumerate     # chain-first: what the wallet holds right now
 *   node tools/recoveryctl.mjs <recovery-env-file> runbook       # the ordered incident steps (D54: revoke first)
 *   node tools/recoveryctl.mjs <recovery-env-file> verify-record <record.json>
 *   node tools/recoveryctl.mjs <recovery-env-file> render-policy <record.json>
 *   node tools/recoveryctl.mjs <recovery-env-file> check-sweep   <record.json> <unsigned-tx-hex|base64>
 *
 * The last three exist so the break-glass sweep can be rehearsed *before* an incident rather than
 * discovered during one (INV-27): verify-record proves every pinned token account is the canonical
 * ATA of the pinned cold wallet, render-policy prints the conditions to pin at the provider, and
 * check-sweep evaluates a candidate transaction against the policy the record implies. None of them
 * signs, and none takes a recipient: the destination comes only from the record (D54).
 *
 * This skeleton has no signing capability and never routes through the executor. Every step that
 * signs (executor identity revocation, time-boxed incident identity, provider vault recovery,
 * SWEEP_TO_COLD_RECOVERY) is performed at the signer provider's control plane by the break-glass
 * principal and is shaped by Probe A/C (plan MP); until those probes are recorded this tool only
 * reads chain state and prints the runbook. The recovery env file holds SOLANA_RPC_URL and
 * TRADING_WALLET (public data) and lives with the operator's recovery material, outside every
 * application deployable. The cold-recovery address is never read from here: it is pinned in the
 * signer control plane and documented offline (D54).
 */
import fs from 'node:fs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const [envFile, action, ...rest] = process.argv.slice(2);
const ACTIONS = ['enumerate', 'runbook', 'verify-record', 'render-policy', 'check-sweep'];
if (!envFile || !ACTIONS.includes(action ?? '')) {
  console.error(`usage: node tools/recoveryctl.mjs <recovery-env-file> ${ACTIONS.join('|')}`);
  process.exit(2);
}
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const RUNBOOK = [
  '1. Declare the incident (who, when, suspected scope). Nothing below is routine trading.',
  '2. PAUSE_NEW_ENTRIES through traderctl if the executor still answers; otherwise proceed, the pause is not a precondition.',
  '3. REVOKE FIRST (D54): at the signer provider, disable the executor workload identity\'s signing permission. Record the policy/version identity you changed.',
  '4. Enumerate chain truth: `recoveryctl enumerate` (wallet SOL and SPL balances), provider vault balances, recent signatures. Reconstruct exposure from chain, not from the database.',
  '5. Activate the break-glass principal for a declared, time-boxed window (MFA/quorum as the provider requires). It may sign only: held-asset -> SOL/USDC risk-reducing swaps, provider vault cancel/withdraw/recovery, SWEEP_TO_COLD_RECOVERY.',
  '6. Close or recover risk with the break-glass principal. Every signature is separately logged and alerted.',
  '7. SWEEP_TO_COLD_RECOVERY to the pre-registered cold wallet only. The recipient is pinned in the signer control plane; no CLI argument, env var, database row or browser supplies it.',
  '8. Rotate credentials, redeploy from a clean build, verify the signer policy digest, then reconcile chain/custody into the application (the executor journal and RECONCILED_INTO_DB lines).',
  '9. Operator closure: the incident stays live-blocking until steps 3-8 are complete and reviewed; Live Readiness must be re-run before any live arming.',
];

if (action === 'runbook') {
  console.log(RUNBOOK.join('\n'));
  process.exit(0);
}

// --- rehearsal: the pinned record and a candidate sweep, from the built libraries ----------------
if (action === 'verify-record' || action === 'render-policy' || action === 'check-sweep') {
  const [recordPath, txArg] = rest;
  if (!recordPath) {
    console.error(`${action} needs a path to the cold-recovery record JSON`);
    process.exit(2);
  }
  if (!env.TRADING_WALLET) {
    console.error('TRADING_WALLET is required in the recovery env file');
    process.exit(2);
  }
  const { ColdRecoveryRecord, renderTurnkeyPolicy, sweepDestinations, sweepSignerPolicy } = await import('../libs/contracts/dist/index.js');
  const parsed = ColdRecoveryRecord.safeParse(JSON.parse(fs.readFileSync(recordPath, 'utf8')));
  if (!parsed.success) {
    console.error(JSON.stringify({ event: 'record_invalid', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, null, 2));
    process.exit(1);
  }
  const record = parsed.data;
  const { checkSweepTransaction, decodeTransaction, verifyColdRecoveryRecord } = await import('../libs/execution/dist/index.js');
  const wallet = env.TRADING_WALLET;
  const policyVersion = `break-glass-sweep-${record.version}`;

  if (action === 'verify-record') {
    const v = verifyColdRecoveryRecord(record);
    console.log(JSON.stringify({ event: 'record_verified', ok: v.ok, destinations: sweepDestinations(record), findings: v.ok ? [] : v.findings, offlineRecord: record.offlineRecordReference }, null, 2));
    if (!v.ok) console.error('A pinned token account is not the canonical ATA of the pinned wallet. Correct the record before the drill, not during an incident.');
    process.exit(v.ok ? 0 : 1);
  }

  if (action === 'render-policy') {
    const policy = sweepSignerPolicy(record, { policyVersion, tradingWallet: wallet });
    console.log(JSON.stringify({ event: 'sweep_policy', policy, provider: renderTurnkeyPolicy(policy) }, null, 2));
    console.error('Pin these conditions on the break-glass principal at the provider. Nothing here enforces them (D53).');
    process.exit(0);
  }

  if (!txArg) {
    console.error('check-sweep needs the unsigned transaction as hex or base64');
    process.exit(2);
  }
  const bytes = /^[0-9a-fA-F]+$/.test(txArg) && txArg.length % 2 === 0 ? Buffer.from(txArg, 'hex') : Buffer.from(txArg, 'base64');
  let verdict;
  try {
    verdict = checkSweepTransaction(decodeTransaction(new Uint8Array(bytes)), record, { policyVersion, tradingWallet: wallet, cluster: record.cluster });
  } catch (err) {
    console.error(JSON.stringify({ event: 'sweep_undecodable', error: err instanceof Error ? err.message : String(err) }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ event: 'sweep_checked', ...verdict, destinations: sweepDestinations(record) }, null, 2));
  process.exit(verdict.ok ? 0 : 1);
}

if (!env.SOLANA_RPC_URL || !env.TRADING_WALLET) {
  console.error('SOLANA_RPC_URL and TRADING_WALLET are required in the recovery env file');
  process.exit(2);
}
let id = 0;
async function rpc(method, params) {
  const res = await fetch(env.SOLANA_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.code} ${json.error.message}`);
  return json.result;
}
// Read-only, closed method set: balances, token accounts, recent signatures. Nothing here can sign or send.
const [balance, slot] = await Promise.all([rpc('getBalance', [env.TRADING_WALLET, { commitment: 'finalized' }]), rpc('getSlot', [{ commitment: 'finalized' }])]);
const holdings = [];
for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
  const r = await rpc('getTokenAccountsByOwner', [env.TRADING_WALLET, { programId }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  for (const a of r.value) {
    const info = a.account.data.parsed.info;
    holdings.push({ tokenAccount: a.pubkey, mint: info.mint, amount: info.tokenAmount.amount, decimals: info.tokenAmount.decimals, state: info.state ?? null, program: programId === TOKEN_PROGRAM ? 'TOKEN' : 'TOKEN_2022' });
  }
}
const signatures = await rpc('getSignaturesForAddress', [env.TRADING_WALLET, { limit: 20, commitment: 'finalized' }]);
console.log(JSON.stringify({ event: 'recovery_enumerate', wallet: env.TRADING_WALLET, slot, lamports: balance.value, holdings, recentSignatures: signatures.map((s) => ({ signature: s.signature, slot: s.slot, err: s.err ?? null, blockTime: s.blockTime ?? null })) }, null, 2));
console.error('Next: steps 3 onward in `recoveryctl runbook`. This tool cannot sign; the break-glass principal acts at the signer control plane (D53).');
