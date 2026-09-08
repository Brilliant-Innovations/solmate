import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { addMs, fixtures, generateSigningKeyPair, signPayload, toInstant, type Amount, type Bps, type EmergencyCommand, type MintAddress, type PositionRiskShadow, type SigningKeyPair } from '@sol-agent-trader/contracts';
import { evaluateShadowStops, planEmergencyClose, type EmergencyClosePolicy, type Holding } from '@sol-agent-trader/execution';
import { base58Encode } from '@sol-agent-trader/solana-hard-state';
import { OTHER_MINT } from './fake-chain.js';
import { AT, TOKEN, USDC, createWorld, kinds, newId, nonceOf, nextSeq, type World } from './world.js';

/**
 * D22 / §15.10 / §15.10A emergency close over the harness: DB-independent, chain-custody-bounded,
 * settlement-only, journaled, and followed by a local pause that blocks new entries until review.
 */

let dir: string;
let authorizer: SigningKeyPair;
let operator: SigningKeyPair;
let rogue: SigningKeyPair;
beforeAll(async () => {
  authorizer = await generateSigningKeyPair();
  operator = await generateSigningKeyPair();
  rogue = await generateSigningKeyPair();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solmate-emergency-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const world = (opts = {}) => createWorld(dir, { authorizer, emergencyOperator: operator }, opts);

async function command(w: World, over: Partial<EmergencyCommand> = {}, key: SigningKeyPair = operator) {
  const n = nextSeq();
  const c: EmergencyCommand = { commandId: newId(), type: 'EMERGENCY_CLOSE_ASSET', cluster: 'devnet', mint: TOKEN, maxAmount: null, issuer: 'OPERATOR_OUT_OF_BAND', reason: 'operator emergency', issuedAt: AT, expiresAt: addMs(AT, 300_000), nonce: nonceOf(n), ...over };
  return signPayload(c, key, AT);
}

/** An entry that leaves the wallet holding TOKEN on the fake chain. */
async function enter(w: World): Promise<void> {
  const r = await w.submit();
  if (r.outcome !== 'EXECUTED' || r.execution.attempt.state !== 'FINALIZED') throw new Error(`entry did not finalize: ${JSON.stringify(r)}`);
}

describe('D22 emergency close: chain-bounded, settlement-only, journaled, pauses entries', () => {
  it('a signed out-of-band EMERGENCY_CLOSE_ASSET sells the chain-confirmed amount into the settlement mint with no database, releases the ledger and applies the local pause', async () => {
    const w = await world();
    await enter(w);
    expect(w.chain.balances.get(TOKEN)).toBe(998_000n);
    expect(w.pipeline.openExposure()).toBe(100_000_000n);
    const r = await w.pipeline.emergency({ signed: await command(w) });
    expect(r.outcome).toBe('CLOSED');
    if (r.outcome !== 'CLOSED') return;
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ mint: TOKEN, amount: '998000', heldAmount: '998000', state: 'FINALIZED' });
    expect(w.chain.balances.get(TOKEN)).toBe(0n);
    expect(w.chain.landed).toHaveLength(2);
    expect(w.chain.landed[1]?.inputAmount).toBe(998_000n);
    const k = kinds(w);
    expect(k.slice(6)).toEqual(['EMERGENCY_COMMAND_RECEIVED', 'ATTEMPT_PREPARED', 'ATTEMPT_SIGNED', 'ATTEMPT_SUBMITTED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_RESULT', 'PAUSE_APPLIED']);
    expect(w.pipeline.openExposure()).toBe(0n);
    expect(w.pipeline.localPause).toEqual({ active: true, reason: expect.stringMatching(/^EMERGENCY_ACTION:/) });
    // the pause blocks new entries at the executor whatever the database says, and survives a restart
    const entry = await w.submit();
    expect(entry).toMatchObject({ outcome: 'DENIED', stage: 'AUTHORITY', reasons: ['MODE_GATE'] });
    await w.reopen();
    expect(w.pipeline.localPause.active).toBe(true);
    expect((await w.submit()).outcome).toBe('DENIED');
    // the same command delivered again cannot sell twice
    const again = await w.pipeline.emergency({ signed: await command(w) });
    expect(again.outcome).toBe('REJECTED');
    expect(w.chain.landed).toHaveLength(2);
  });

  it('EMERGENCY_CLOSE_ALL closes every held non-settlement asset and never touches a settlement mint; a maxAmount above custody is capped to chain truth', async () => {
    const w = await world();
    await enter(w);
    const usdcBefore = w.chain.balances.get(USDC)!;
    const r = await w.pipeline.emergency({ signed: await command(w, { type: 'EMERGENCY_CLOSE_ALL', mint: null }) });
    if (r.outcome !== 'CLOSED') throw new Error(JSON.stringify(r));
    expect(r.actions.map((a) => [a.mint, a.amount, a.state])).toEqual([[TOKEN, '998000', 'FINALIZED'], [OTHER_MINT, '500', 'FINALIZED']]);
    expect(w.chain.balances.get(TOKEN)).toBe(0n);
    expect(w.chain.balances.get(OTHER_MINT)).toBe(0n);
    expect(w.chain.balances.get(USDC)! > usdcBefore).toBe(true);
    const capped = await world();
    await enter(capped);
    const c = await capped.pipeline.emergency({ signed: await command(capped, { maxAmount: '5000000000' as Amount }) });
    if (c.outcome !== 'CLOSED') throw new Error(JSON.stringify(c));
    expect(c.actions[0]).toMatchObject({ amount: '998000', heldAmount: '998000' });
    const partial = await world();
    await enter(partial);
    const p = await partial.pipeline.emergency({ signed: await command(partial, { maxAmount: '400000' as Amount }) });
    if (p.outcome !== 'CLOSED') throw new Error(JSON.stringify(p));
    expect(p.actions[0]).toMatchObject({ amount: '400000', state: 'FINALIZED' });
    expect(partial.chain.balances.get(TOKEN)).toBe(598_000n);
    // proportional release: 400000/998000 of the 100 USDC entry
    expect(partial.pipeline.openExposure()).toBe(100_000_000n - 40_080_160n);
  });

  it('refuses an unaccepted key, a wrong cluster, an expired or replayed command, an asset not held, a settlement mint, and a PAUSE that then blocks entries but never exits', async () => {
    const w = await world();
    await enter(w);
    const cases: [Parameters<typeof command>[1], SigningKeyPair, string][] = [
      [{}, rogue, 'OPERATOR_KEY_NOT_ACCEPTED'],
      [{ cluster: 'mainnet-beta' }, operator, 'CLUSTER_MISMATCH'],
      [{ expiresAt: AT }, operator, 'COMMAND_EXPIRED'],
      [{ mint: OTHER_MINT, maxAmount: '0' as Amount }, operator, 'NOTHING_TO_CLOSE'],
      [{ mint: base58Encode(new Uint8Array(32).fill(200)) as MintAddress }, operator, 'ASSET_NOT_HELD'],
      [{ mint: USDC }, operator, 'ASSET_IS_SETTLEMENT'],
    ];
    for (const [over, key, reason] of cases) {
      const r = await w.pipeline.emergency({ signed: await command(w, over, key) });
      expect(r.outcome, reason).toBe('REJECTED');
      if (r.outcome === 'REJECTED') expect(r.reasons, reason).toContain(reason);
    }
    expect(w.chain.landed).toHaveLength(1);
    expect(w.pipeline.localPause.active).toBe(false);
    // PAUSE_NEW_ENTRIES: immediate local pause; entries denied; an emergency close still runs while paused (risk reduction is never gated)
    const pause = await w.pipeline.emergency({ signed: await command(w, { type: 'PAUSE_NEW_ENTRIES', mint: null }) });
    expect(pause.outcome).toBe('PAUSED');
    expect((await w.submit())).toMatchObject({ outcome: 'DENIED', reasons: ['MODE_GATE'] });
    const close = await w.pipeline.emergency({ signed: await command(w) });
    expect(close.outcome).toBe('CLOSED');
    expect(w.chain.balances.get(TOKEN)).toBe(0n);
  });

  it('a replayed nonce is refused after restart', async () => {
    const w = await world();
    await enter(w);
    const signed = await command(w);
    expect((await w.pipeline.emergency({ signed })).outcome).toBe('CLOSED');
    await w.reopen();
    const replay = await w.pipeline.emergency({ signed });
    expect(replay.outcome).toBe('REJECTED');
    if (replay.outcome === 'REJECTED') expect(replay.reasons).toContain('NONCE_REPLAYED');
  });

  it('shadow stops (§15.10A): a hit closes at chain-confirmed quantity even when the shadow claims more; a stale shadow is refused; a request that would increase exposure has no shape', async () => {
    const w = await world();
    await enter(w);
    await w.pipeline.journal.append('SHADOW_SYNCED', 'shadow', { sequence: 7 });
    const shadow: PositionRiskShadow = { ...fixtures.positionRiskShadow(), sequence: 7 as never, settlementMints: [USDC], positions: [{ ...fixtures.positionRiskShadow().positions[0]!, mint: TOKEN, lastConfirmedQuantity: '5000000' as Amount, stop: { model: 'PERCENTAGE', level: 0.9 }, trailingLevel: null, timeStopAt: null, unreviewedStop: null }] };
    const marks = new Map<MintAddress, number>([[TOKEN, 0.85]]);
    const { hits, unmarked } = evaluateShadowStops(shadow, marks, w.clock.now());
    expect(hits).toEqual([{ positionId: shadow.positions[0]!.positionId, mint: TOKEN, lastConfirmedQuantity: '5000000', reason: 'HARD_STOP' }]);
    expect(unmarked).toEqual([]);
    expect(evaluateShadowStops(shadow, new Map(), w.clock.now())).toEqual({ hits: [], unmarked: [TOKEN] });
    const stale = await w.pipeline.emergency({ monitor: { commandId: newId(), type: 'EMERGENCY_CLOSE_ASSET', mint: TOKEN, maxAmount: hits[0]!.lastConfirmedQuantity, reason: 'HARD_STOP', shadowSequence: 6 } });
    expect(stale).toMatchObject({ outcome: 'REJECTED', reasons: ['SHADOW_STALE'] });
    expect(w.chain.balances.get(TOKEN)).toBe(998_000n);
    const r = await w.pipeline.emergency({ monitor: { commandId: newId(), type: 'EMERGENCY_CLOSE_ASSET', mint: TOKEN, maxAmount: hits[0]!.lastConfirmedQuantity, reason: 'HARD_STOP', shadowSequence: 7 } });
    if (r.outcome !== 'CLOSED') throw new Error(JSON.stringify(r));
    expect(r.actions[0]).toMatchObject({ amount: '998000', heldAmount: '998000', state: 'FINALIZED' });
    expect(w.chain.balances.get(TOKEN)).toBe(0n);
    expect(kinds(w)).toContain('EMERGENCY_COMMAND_RECEIVED');
  });

  it('property: every planned action sells a held non-settlement asset into the settlement mint for at most the chain amount, and never anything else', () => {
    const mint = (n: number) => base58Encode(new Uint8Array(32).fill(n)) as MintAddress;
    const policy = (settlement: MintAddress[]): EmergencyClosePolicy => ({ settlementMints: settlement, slippageBps: 200 as Bps, hardMaxProtectiveSlippageBps: 300 as Bps, maxPriceImpactBps: 500 as Bps, maxQuoteAgeMs: 15_000, validityMs: 60_000, maxTxBaseUnits: null });
    fc.assert(
      fc.property(
        fc.array(fc.record({ m: fc.integer({ min: 1, max: 12 }), amount: fc.bigInt({ min: 0n, max: 10n ** 12n }), frozen: fc.boolean() }), { maxLength: 8 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 3 }),
        fc.option(fc.integer({ min: 1, max: 12 }), { nil: null }),
        fc.option(fc.bigInt({ min: 0n, max: 10n ** 12n }), { nil: null }),
        (raw, settlementIdx, target, maxAmount) => {
          const holdings: Holding[] = raw.map((h, i) => ({ mint: mint(h.m), tokenAccount: `ata-${i}`, amount: h.amount, frozen: h.frozen, program: 'tok' }));
          const settlement = settlementIdx.map(mint);
          const request = target === null ? { type: 'EMERGENCY_CLOSE_ALL' as const, mint: null, maxAmount: maxAmount?.toString() as Amount | null ?? null } : { type: 'EMERGENCY_CLOSE_ASSET' as const, mint: mint(target), maxAmount: (maxAmount?.toString() ?? null) as Amount | null };
          const plan = planEmergencyClose(request, holdings, policy(settlement), toInstant(Date.UTC(2026, 8, 8)));
          if (!plan.ok) return;
          for (const a of plan.actions) {
            expect(settlement).toContain(a.outputMint);
            expect(settlement).not.toContain(a.mint);
            const held = holdings.filter((h) => h.mint === a.mint && h.tokenAccount === a.tokenAccount)[0]!;
            expect(held.frozen).toBe(false);
            expect(BigInt(a.amount) > 0n && BigInt(a.amount) <= held.amount).toBe(true);
            if (maxAmount !== null) expect(BigInt(a.amount) <= maxAmount).toBe(true);
            expect(a.bounds.exposureEffect).toBe('REDUCE');
            expect(a.bounds.maxSlippageBps <= 300).toBe(true);
          }
        },
      ),
    );
  });
});

