import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMs, generateSigningKeyPair, signPayload, signServiceRequest, type EmergencyCommand, type SigningKeyPair } from '@sol-agent-trader/contracts';
import { createLogger } from '@sol-agent-trader/observability';
import { ExecutorClient, ExecutorHttpError } from '@sol-agent-trader/execution';
import { close, listen } from './http.js';
import { createInternalApi } from './internal.js';
import { createOutOfBandApi } from './out-of-band.js';
import { AT, TOKEN, createWorld, newId, nonceOf, nextSeq, type World } from '../harness/world.js';

/**
 * Internal API and out-of-band endpoint over loopback (§15.2, §15.8, D25): authenticated verbs
 * only, replay refused, no signing primitive reachable, emergency commands accepted by signature
 * alone.
 */

const SECRET = randomBytes(32).toString('hex');
const OTHER_SECRET = randomBytes(32).toString('hex');
const logger = createLogger({ service: 'execution-service', sink: () => undefined });

let dir: string;
let authorizer: SigningKeyPair;
let operator: SigningKeyPair;
beforeAll(async () => {
  authorizer = await generateSigningKeyPair();
  operator = await generateSigningKeyPair();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solmate-api-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function servers(w: World) {
  const internal = createInternalApi({
    pipeline: w.pipeline, secretsHex: [SECRET], clock: w.clock, logger, contractSetDigest: 'digest',
    loadIntent: async (id) => stored.get(id) ?? null,
    loadApproval: async () => null,
    signerHealth: () => w.signer.health(),
  });
  const oob = createOutOfBandApi({ pipeline: w.pipeline, clock: w.clock, logger });
  const a = await listen(internal, { host: '127.0.0.1', port: 0 });
  const b = await listen(oob, { host: '127.0.0.1', port: 0 });
  return { internal, oob, internalUrl: a.url, oobUrl: b.url, stop: async () => { await close(internal); await close(oob); } };
}
const stored = new Map<string, Awaited<ReturnType<World['request']>>['intent']>();

describe('executor internal API and out-of-band endpoint', () => {
  it('a signed request executes an intent end to end; health reports the pipeline; replayed, forged, skewed or foreign-key requests are refused; no signing route exists', async () => {
    const w = await createWorld(dir, { authorizer, emergencyOperator: operator });
    const s = await servers(w);
    try {
      const client = new ExecutorClient({ baseUrl: s.internalUrl, secretHex: SECRET, clock: w.clock });
      const health = await client.health();
      expect(health).toMatchObject({ service: 'execution-service', contractSetDigest: 'digest', unresolvedAttempts: 0, openExposureBaseUnits: '0' });
      const { request, intent } = await w.request();
      stored.set(intent.id, intent);
      const out = (await client.execute(request, 'MONITORED_EXIT')) as { outcome: string; execution?: { attempt: { state: string } } };
      expect(out.outcome).toBe('EXECUTED');
      expect(out.execution?.attempt.state).toBe('FINALIZED');
      expect(w.chain.landed).toHaveLength(1);
      // redelivery through the API is a duplicate, never a second attempt
      const dup = (await client.execute(request, 'MONITORED_EXIT')) as { outcome: string };
      expect(dup.outcome).toBe('DUPLICATE');
      expect(w.chain.landed).toHaveLength(1);
      // missing stored row: denied, nothing journaled beyond the first intent
      const { request: r2 } = await w.request();
      const missing = (await client.execute(r2, 'MONITORED_EXIT')) as { outcome: string; reasons: string[] };
      expect(missing).toMatchObject({ outcome: 'DENIED', reasons: ['INTENT_RECORD_MISSING'] });
      // replay: same headers twice
      const body = JSON.stringify({ request, protectionMode: 'MONITORED_EXIT' });
      const headers = await signServiceRequest(SECRET, { method: 'POST', path: '/v1/execute', body }, { nowMs: Date.parse(w.clock.now()), nonce: 'replay-nonce-0000000001' });
      const first = await fetch(`${s.internalUrl}/v1/execute`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
      expect(first.status).toBe(200);
      const second = await fetch(`${s.internalUrl}/v1/execute`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
      expect(second.status).toBe(401);
      expect(await second.json()).toEqual({ error: 'NONCE_REPLAYED' });
      // tampered body under a valid signature
      const tampered = await fetch(`${s.internalUrl}/v1/execute`, { method: 'POST', headers: { ...(await signServiceRequest(SECRET, { method: 'POST', path: '/v1/execute', body }, { nowMs: Date.parse(w.clock.now()), nonce: 'tamper-nonce-000000001' })), 'content-type': 'application/json' }, body: body.replace('MONITORED_EXIT', 'JUPITER_TRIGGER') });
      expect(await tampered.json()).toEqual({ error: 'BAD_SIGNATURE' });
      // wrong secret, skewed clock, no headers
      const foreign = new ExecutorClient({ baseUrl: s.internalUrl, secretHex: OTHER_SECRET, clock: w.clock });
      await expect(foreign.health()).rejects.toMatchObject({ status: 401, body: { error: 'UNKNOWN_KEY' } } satisfies Partial<ExecutorHttpError>);
      const skewed = new ExecutorClient({ baseUrl: s.internalUrl, secretHex: SECRET, clock: { now: () => addMs(AT, 10 * 60_000) } as never });
      await expect(skewed.health()).rejects.toMatchObject({ status: 401, body: { error: 'TIMESTAMP_SKEW' } });
      const bare = await fetch(`${s.internalUrl}/v1/health`);
      expect(bare.status).toBe(401);
      // there is no route that signs or sends anything
      for (const path of ['/v1/sign', '/v1/send', '/v1/transfer', '/v1/call']) {
        const h = await signServiceRequest(SECRET, { method: 'POST', path, body: '{}' }, { nowMs: Date.parse(w.clock.now()), nonce: `nosuch-${path.replace(/\W/g, '')}-0000000` });
        const r = await fetch(`${s.internalUrl}${path}`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{}' });
        expect(r.status, path).toBe(404);
      }
      // recover and pause clearing are reachable only through the authenticated plane
      expect(await client.recover()).toEqual({ recovered: [] });
    } finally {
      await s.stop();
    }
  });

  it('the out-of-band endpoint accepts a pinned-key emergency command with no database and no shared secret, refuses garbage and unpinned keys, and the internal plane then clears the pause after review', async () => {
    const w = await createWorld(dir, { authorizer, emergencyOperator: operator });
    const s = await servers(w);
    try {
      const { request, intent } = await w.request();
      stored.set(intent.id, intent);
      const client = new ExecutorClient({ baseUrl: s.internalUrl, secretHex: SECRET, clock: w.clock });
      expect(((await client.execute(request, 'MONITORED_EXIT')) as { outcome: string }).outcome).toBe('EXECUTED');
      expect(w.chain.balances.get(TOKEN)).toBe(998_000n);
      const cmd: EmergencyCommand = { commandId: newId(), type: 'EMERGENCY_CLOSE_ASSET', cluster: 'devnet', mint: TOKEN, maxAmount: null, issuer: 'OPERATOR_OUT_OF_BAND', reason: 'drill', issuedAt: AT, expiresAt: addMs(AT, 300_000), nonce: nonceOf(nextSeq()) };
      const signed = await signPayload(cmd, operator, AT);
      const ok = await fetch(`${s.oobUrl}/v1/emergency`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ outcome: 'CLOSED', actions: [{ mint: TOKEN, amount: '998000', state: 'FINALIZED' }] });
      expect(w.chain.balances.get(TOKEN)).toBe(0n);
      expect(w.pipeline.localPause.active).toBe(true);
      // replay of the same signed command
      const replay = await fetch(`${s.oobUrl}/v1/emergency`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
      expect(replay.status).toBe(403);
      expect(await replay.json()).toMatchObject({ outcome: 'REJECTED', reasons: ['NONCE_REPLAYED'] });
      // garbage and an unpinned signer
      expect((await fetch(`${s.oobUrl}/v1/emergency`, { method: 'POST', body: 'not json' })).status).toBe(400);
      const rogue = await generateSigningKeyPair();
      const forged = await signPayload({ ...cmd, commandId: newId(), nonce: nonceOf(nextSeq()) }, rogue, AT);
      const bad = await fetch(`${s.oobUrl}/v1/emergency`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forged) });
      expect(bad.status).toBe(403);
      expect(await bad.json()).toMatchObject({ outcome: 'REJECTED', reasons: ['OPERATOR_KEY_NOT_ACCEPTED'] });
      expect((await fetch(`${s.oobUrl}/v1/execute`, { method: 'POST', body: '{}' })).status).toBe(404);
      // entries stay blocked until the authenticated plane records the review
      const { request: r2, intent: i2 } = await w.request();
      stored.set(i2.id, i2);
      expect(await client.execute(r2, 'MONITORED_EXIT')).toMatchObject({ outcome: 'DENIED', reasons: ['MODE_GATE'] });
      expect(await client.clearLocalPause('operator review #1')).toEqual({ localPause: { active: false, reason: null } });
      const { request: r3, intent: i3 } = await w.request();
      stored.set(i3.id, i3);
      expect(((await client.execute(r3, 'MONITORED_EXIT')) as { outcome: string }).outcome).toBe('EXECUTED');
    } finally {
      await s.stop();
    }
  });
});

