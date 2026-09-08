#!/usr/bin/env node
/**
 * traderctl — application emergency control, D25 plane 1 (blueprint §15.8, §15.10; plan M3 skeleton).
 *
 *   node tools/traderctl.mjs <operator-env-file> health
 *   node tools/traderctl.mjs <operator-env-file> pause            [--reason "..."]
 *   node tools/traderctl.mjs <operator-env-file> close-asset <mint> [--max <base units>] [--reason "..."]
 *   node tools/traderctl.mjs <operator-env-file> close-all        [--reason "..."]
 *
 * Signs one narrowly typed EmergencyCommand with the operator's emergency key and posts it to the
 * executor's out-of-band endpoint. The endpoint accepts nothing else: there is no recipient, no
 * buy, no amount increase and no raw signing verb to ask for. The operator env file holds
 * OUT_OF_BAND_URL, SOLANA_CLUSTER, EMERGENCY_OPERATOR_KEY_PKCS8 and EMERGENCY_OPERATOR_PUBLIC_KEY
 * and lives on the operator's machine, never in this workspace or any application deployable
 * (GUARDRAILS Part 4 "Credentials", D65). The command expires two minutes after issue and carries
 * a fresh nonce, so a captured command cannot be replayed later.
 *
 * Runs against the built contracts library (`pnpm nx build @sol-agent-trader/contracts`) so the
 * envelope format is the one the executor verifies.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const contractsPath = resolve(here, '..', 'libs', 'contracts', 'dist', 'index.js');
if (!fs.existsSync(contractsPath)) {
  console.error('libs/contracts/dist is missing: run `pnpm nx build @sol-agent-trader/contracts` first');
  process.exit(2);
}
const contracts = await import(pathToFileURL(contractsPath).href);

const [envFile, action, ...rest] = process.argv.slice(2);
const usage = () => {
  console.error('usage: node tools/traderctl.mjs <operator-env-file> health | pause [--reason r] | close-asset <mint> [--max <base units>] [--reason r] | close-all [--reason r]');
  process.exit(2);
};
if (!envFile || !action) usage();
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const url = (env.OUT_OF_BAND_URL ?? 'http://127.0.0.1:8792').replace(/\/$/, '');

if (action === 'health') {
  const res = await fetch(`${url}/v1/health`);
  console.log(JSON.stringify({ event: 'out_of_band_health', status: res.status, body: await res.json() }));
  process.exit(res.ok ? 0 : 1);
}

const TYPES = { pause: 'PAUSE_NEW_ENTRIES', 'close-asset': 'EMERGENCY_CLOSE_ASSET', 'close-all': 'EMERGENCY_CLOSE_ALL' };
const type = TYPES[action];
if (!type) usage();
if (!env.EMERGENCY_OPERATOR_KEY_PKCS8 || !env.EMERGENCY_OPERATOR_PUBLIC_KEY || !env.SOLANA_CLUSTER) {
  console.error('EMERGENCY_OPERATOR_KEY_PKCS8, EMERGENCY_OPERATOR_PUBLIC_KEY and SOLANA_CLUSTER are required in the operator env file');
  process.exit(2);
}
const mint = type === 'EMERGENCY_CLOSE_ASSET' ? rest[0] : null;
if (type === 'EMERGENCY_CLOSE_ASSET' && (!mint || mint.startsWith('--'))) usage();
const maxAmount = flag('--max') ?? null;
const reason = flag('--reason') ?? `traderctl ${action} by operator at ${new Date().toISOString()}`;

const now = Date.now();
const command = contracts.EmergencyCommand.parse({
  commandId: randomUUID(),
  type,
  cluster: env.SOLANA_CLUSTER,
  mint,
  maxAmount,
  issuer: 'OPERATOR_OUT_OF_BAND',
  reason,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 120_000).toISOString(),
  nonce: randomBytes(16).toString('hex'),
});
const key = await contracts.importSigningKeyPair(env.EMERGENCY_OPERATOR_KEY_PKCS8, env.EMERGENCY_OPERATOR_PUBLIC_KEY);
const signed = await contracts.signPayload(command, key, new Date(now).toISOString());
console.error(JSON.stringify({ event: 'emergency_command_signed', commandId: command.commandId, type, mint, maxAmount, keyId: key.keyId, expiresAt: command.expiresAt }));

const res = await fetch(`${url}/v1/emergency`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
const body = await res.json().catch(() => null);
console.log(JSON.stringify({ event: 'emergency_command_result', status: res.status, body }));
process.exit(res.ok ? 0 : 1);
