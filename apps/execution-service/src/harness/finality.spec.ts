import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, type SigningKeyPair } from '@sol-agent-trader/contracts';
import type { QuorumObserver, SignatureStatus } from '@sol-agent-trader/execution';
import type { FinalityPersist } from '../pipeline/pipeline.js';
import { createWorld, kinds, type WorldOptions } from './world.js';

/**
 * Staged finality, REORG_PENDING and RPC divergence over the real pipeline and journal (§14.7,
 * §40.3, §24.4; INV-22, INV-23). Finality is deferred in every world here, so `/execute` returns
 * CONFIRMED_PROVISIONAL and the tracker does the rest from chain truth.
 */

class SecondaryView implements QuorumObserver {
  readonly label = 'secondary';
  readonly statuses = new Map<string, SignatureStatus>();
  head = 1000;
  height = 100;
  async signatureStatus(signature: string): Promise<SignatureStatus | null> { return this.statuses.get(signature) ?? null; }
  async blockHeight(): Promise<number> { return this.height; }
  async headSlot(): Promise<number> { return this.head; }
}

let dir: string;
let authorizer: SigningKeyPair;
let emergencyOperator: SigningKeyPair;
beforeAll(async () => {
  authorizer = await generateSigningKeyPair();
  emergencyOperator = await generateSigningKeyPair();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solmate-finality-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const world = (opts: WorldOptions = {}) => createWorld(dir, { authorizer, emergencyOperator }, { finality: 'DEFERRED', chain: { lastValidBlockHeight: 150 }, ...opts });

async function confirmedEntry(opts: WorldOptions = {}) {
  const persisted: FinalityPersist[] = [];
  const w = await world({ ...opts, persistFinality: async (u) => { persisted.push(u); } });
  const r = await w.submit();
  expect(r.outcome).toBe('EXECUTED');
  if (r.outcome !== 'EXECUTED') throw new Error('unreachable');
  const signature = r.execution.attempt.expectedTxSignature ?? r.execution.attempt.walletSignature;
  if (!signature) throw new Error('no signature');
  return { w, r, signature, persisted, key: w.pipeline.journal.all()[0]!.payload['idempotencyKey'] as never };
}

describe('staged finality (§14.7): confirmed is provisional exposure, finalized is accounting', () => {
  it('a deferred finality returns CONFIRMED_PROVISIONAL with a confirmed fill, and the tracker promotes it once every view is finalized', async () => {
    const { w, r, signature, persisted, key } = await confirmedEntry();
    expect(r.execution.attempt.state).toBe('CONFIRMED_PROVISIONAL');
    expect(r.execution.fill).toMatchObject({ commitment: 'confirmed', outputAmount: '998000' });
    expect(kinds(w)).toEqual(['ATTEMPT_PREPARED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_SIGNED', 'ATTEMPT_SUBMITTED', 'EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_OBSERVED']);
    expect(w.pipeline.openExposure()).toBe(100_000_000n);
    expect(w.pipeline.registry.state(key)).toBe('EXECUTING');
    // still only confirmed: nothing is promoted (INV-22)
    expect(await w.pipeline.trackFinality()).toEqual([]);
    expect(persisted).toEqual([]);
    w.chain.finalizeAll();
    const updates = await w.pipeline.trackFinality();
    expect(updates).toMatchObject([{ signature, from: 'CONFIRMED_PROVISIONAL', to: 'FINALIZED', verdict: 'FINALIZED', views: 1 }]);
    expect(kinds(w).at(-1)).toBe('ATTEMPT_RESULT');
    expect(w.pipeline.journal.all().at(-1)?.payload).toMatchObject({ state: 'FINALIZED', lifecycle: 'COMPLETED', txSignature: signature, tracked: true });
    expect(w.pipeline.registry.state(key)).toBe('COMPLETED');
    expect(w.pipeline.openExposure()).toBe(100_000_000n);
    expect(persisted).toMatchObject([{ signature, state: 'FINALIZED', slot: expect.any(Number) }]);
    expect(w.pipeline.journal.unresolvedAttempts()).toEqual([]);
    // idempotent afterwards
    expect(await w.pipeline.trackFinality()).toEqual([]);
  });

  it('stalled finality keeps the provisional exposure and never promotes accounting, however often the tracker runs', async () => {
    const { w, persisted } = await confirmedEntry();
    for (let i = 0; i < 5; i++) expect(await w.pipeline.trackFinality()).toEqual([]);
    expect(kinds(w).filter((k) => k === 'ATTEMPT_RESULT')).toEqual([]);
    expect(w.pipeline.openExposure()).toBe(100_000_000n);
    expect(persisted).toEqual([]);
  });

  it('confirmed then missing before finality enters REORG_PENDING, pauses new entries locally and never resubmits; a reappearance re-confirms and the pause lifts after custody is re-read', async () => {
    const { w, signature, persisted } = await confirmedEntry();
    const status = w.chain.statuses.get(signature)!;
    w.chain.statuses.delete(signature);
    const reorg = await w.pipeline.trackFinality();
    expect(reorg).toMatchObject([{ signature, from: 'CONFIRMED_PROVISIONAL', to: 'REORG_PENDING', verdict: 'MISSING' }]);
    expect(w.pipeline.localPause).toEqual({ active: true, reason: `REORG_PENDING:${signature}` });
    expect(kinds(w).slice(-2)).toEqual(['ATTEMPT_REORG_PENDING', 'PAUSE_APPLIED']);
    expect(persisted.at(-1)).toMatchObject({ signature, state: 'REORG_PENDING', reason: 'MISSING' });
    expect(w.pipeline.openExposure()).toBe(100_000_000n);
    // a redelivery is a duplicate, a fresh entry is refused by the local pause, and nothing new reaches the chain
    const { request, intent } = await w.request();
    const fresh = await w.pipeline.submit({ request, storedIntent: intent, approval: null, protectionMode: 'MONITORED_EXIT' });
    expect(fresh).toMatchObject({ outcome: 'DENIED', stage: 'AUTHORITY', reasons: ['MODE_GATE'] });
    expect(w.chain.executeCalls).toHaveLength(1);
    // still missing but the block height has not expired: not dead, still paused
    expect(await w.pipeline.trackFinality()).toMatchObject([{ to: 'REORG_PENDING', note: 'still potentially landable' }]);
    expect(w.pipeline.localPause.active).toBe(true);
    // the transaction reappears confirmed
    w.chain.statuses.set(signature, status);
    const back = await w.pipeline.trackFinality();
    expect(back).toMatchObject([{ signature, from: 'REORG_PENDING', to: 'CONFIRMED_PROVISIONAL' }]);
    expect(kinds(w).slice(-3)).toEqual(['ATTEMPT_OBSERVED', 'CUSTODY_RECONCILED', 'PAUSE_CLEARED']);
    expect(w.pipeline.localPause.active).toBe(false);
    w.chain.finalizeAll();
    expect(await w.pipeline.trackFinality()).toMatchObject([{ to: 'FINALIZED' }]);
  });

  it('a REORG_PENDING transaction becomes NOT_LANDED only once the block height expired on every view with no signature history, releasing exposure and the pause', async () => {
    const { w, signature, persisted, key } = await confirmedEntry();
    w.chain.statuses.delete(signature);
    await w.pipeline.trackFinality();
    expect(w.pipeline.localPause.active).toBe(true);
    w.chain.advanceBlocks(60); // block height 160 > lastValidBlockHeight 150
    const dead = await w.pipeline.trackFinality();
    expect(dead).toMatchObject([{ signature, from: 'REORG_PENDING', to: 'NOT_LANDED', note: 'BLOCK_HEIGHT_EXPIRED' }]);
    expect(w.pipeline.openExposure()).toBe(0n);
    expect(w.pipeline.registry.state(key)).toBe('FAILED');
    expect(persisted.at(-1)).toMatchObject({ signature, state: 'NOT_LANDED', reason: 'BLOCK_HEIGHT_EXPIRED' });
    expect(kinds(w).slice(-4)).toEqual(['EXPOSURE_LEDGER_UPDATED', 'ATTEMPT_RESULT', 'CUSTODY_RECONCILED', 'PAUSE_CLEARED']);
    expect(w.pipeline.journal.unresolvedAttempts()).toEqual([]);
  });

  it('independent views that contradict each other pause entries until they agree; one silent view does not', async () => {
    const secondary = new SecondaryView();
    const { w, signature } = await confirmedEntry({ secondaryChain: secondary });
    // secondary has not caught up: behind, not a contradiction
    secondary.head = w.chain.slot - 5;
    expect(await w.pipeline.trackFinality()).toEqual([]);
    // secondary is far past the slot and still does not know the signature: divergence → REORG_PENDING + pause
    secondary.head = w.chain.slot + 500;
    const div = await w.pipeline.trackFinality();
    expect(div).toMatchObject([{ signature, from: 'CONFIRMED_PROVISIONAL', to: 'REORG_PENDING', verdict: 'DIVERGENT' }]);
    expect(w.pipeline.localPause).toEqual({ active: true, reason: `REORG_PENDING:${signature}` });
    // views agree again → re-confirmed, pause released; both finalized → FINALIZED
    secondary.statuses.set(signature, { ...w.chain.statuses.get(signature)! });
    expect(await w.pipeline.trackFinality()).toMatchObject([{ from: 'REORG_PENDING', to: 'CONFIRMED_PROVISIONAL', views: 2 }]);
    expect(w.pipeline.localPause.active).toBe(false);
    w.chain.finalizeAll();
    expect(await w.pipeline.trackFinality()).toEqual([]); // secondary still confirmed: not finalized everywhere
    secondary.statuses.get(signature)!.confirmationStatus = 'finalized';
    expect(await w.pipeline.trackFinality()).toMatchObject([{ to: 'FINALIZED', views: 2 }]);
  });

  it('a success/failure split between views is divergence even from SUBMITTED, and a consistent on-chain failure is NOT_LANDED', async () => {
    const secondary = new SecondaryView();
    const { w, signature, key } = await confirmedEntry({ secondaryChain: secondary });
    secondary.statuses.set(signature, { slot: w.chain.slot, confirmationStatus: 'confirmed', err: { InstructionError: [3, 'Custom'] } });
    const div = await w.pipeline.trackFinality();
    expect(div).toMatchObject([{ to: 'REORG_PENDING', verdict: 'DIVERGENT' }]);
    // both views now agree the transaction failed
    w.chain.statuses.set(signature, { slot: w.chain.slot, confirmationStatus: 'confirmed', err: { InstructionError: [3, 'Custom'] } });
    const failed = await w.pipeline.trackFinality();
    expect(failed).toMatchObject([{ from: 'REORG_PENDING', to: 'NOT_LANDED', note: 'TX_FAILED_ON_CHAIN' }]);
    expect(w.pipeline.openExposure()).toBe(0n);
    expect(w.pipeline.registry.state(key)).toBe('FAILED');
    expect(w.pipeline.localPause.active).toBe(false);
  });

  it('restart: a CONFIRMED_PROVISIONAL attempt survives in the journal, recovery leaves it pending and the tracker finishes it', async () => {
    const { w, signature } = await confirmedEntry();
    const p2 = await w.reopen();
    const recovered = await p2.recover();
    expect(recovered).toMatchObject([{ resolution: 'LANDED_CONFIRMED_PENDING', signature }]);
    expect(await p2.trackFinality()).toEqual([]);
    w.chain.finalizeAll();
    expect(await p2.trackFinality()).toMatchObject([{ from: 'CONFIRMED_PROVISIONAL', to: 'FINALIZED' }]);
    expect(p2.journal.unresolvedAttempts()).toEqual([]);
    expect(p2.openExposure()).toBe(100_000_000n);
  });
});
