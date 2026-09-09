import { NATIVE_SOL_MINT, fixtures, type Instant, type Uuid, type WalletFundingEvent } from '@sol-agent-trader/contracts';
import type { PendingControlRequest } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { runFundingCycle, type FundingDeps, type FundingRepo } from './funding.js';

const logger = createLogger({ service: 'worker', minLevel: 'error' });
const T0 = fixtures.T0 as Instant;
const OP = '11111111-1111-4111-8111-111111111111' as Uuid;
const ACCOUNT = '22222222-2222-4222-8222-222222222222' as Uuid;
const EVENT = '33333333-3333-4333-8333-333333333333' as Uuid;
const TRADING = 'TradingWa11et11111111111111111111111111111';
const SOURCE = 'SourceWa11et111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ATA = 'Ata9fTradingWa11et111111111111111111111111';
const SIG = 'Sig' + '1'.repeat(85);

function harness(role: 'operator' | 'viewer' = 'operator') {
  const inserted: WalletFundingEvent[] = [];
  const resolved: { state: string; resolution: Record<string, unknown> }[] = [];
  let pending: PendingControlRequest[] = [];
  const repo: FundingRepo = {
    async listPending() { return pending; },
    async operatorRole() { return role; },
    async accountByTradingWallet(w) { return w === TRADING ? { id: ACCOUNT, cluster: 'mainnet-beta', tradingWallet: TRADING, settlementMint: USDC, settlementAta: ATA } : null; },
    async insertFundingEvent(e) { inserted.push(e); },
    async resolve(_id, state, resolution) { resolved.push({ state, resolution }); return true; },
  };
  const deps: FundingDeps = { repo, clock: { now: () => T0, nowMs: () => Date.parse(T0) }, logger, config: { batchSize: 10 }, newId: () => EVENT };
  return { deps, inserted, resolved, setPending: (p: PendingControlRequest[]) => { pending = p; } };
}

const request = (payload: Record<string, unknown>): PendingControlRequest => ({ id: 'a0000000-0000-4000-8000-000000000001' as Uuid, requestedBy: OP, kind: 'FUND_TRADING_WALLET', payload, createdAt: T0 });
const transfer = { sourceWallet: SOURCE, destinationTradingWallet: TRADING, destinationAta: null, fundingMint: NATIVE_SOL_MINT, requestedAmount: '50000000', cluster: 'mainnet-beta' };

describe('worker funding role (§20.18, D56)', () => {
  it('records a SUBMITTED transfer the guard accepts, with the signature the wallet reported', async () => {
    const h = harness();
    h.setPending([request({ transfer, outcome: 'SUBMITTED', txSignature: SIG, failureReason: null, source: 'wallet' })]);
    const r = await runFundingCycle(h.deps);
    expect(r.recorded).toBe(1);
    expect(h.inserted[0]).toMatchObject({ id: EVENT, state: 'SUBMITTED', txSignature: SIG, fundingMint: NATIVE_SOL_MINT, destinationTradingWallet: TRADING, submittedAt: T0, confirmedAt: null });
    expect(h.resolved[0]).toMatchObject({ state: 'ACCEPTED', resolution: { fundingEventId: EVENT, state: 'SUBMITTED', native: true } });
  });

  it('records ABANDONED and FAILED outcomes without a signature; refuses SUBMITTED without one', async () => {
    const h = harness();
    h.setPending([request({ transfer: { ...transfer, destinationAta: ATA, fundingMint: USDC, requestedAmount: '250000000' }, outcome: 'ABANDONED', txSignature: null, failureReason: 'user rejected in wallet' })]);
    let r = await runFundingCycle(h.deps);
    expect(r.recorded).toBe(1);
    expect(h.inserted[0]).toMatchObject({ state: 'ABANDONED', txSignature: null, failureReason: 'user rejected in wallet' });
    h.setPending([request({ transfer, outcome: 'SUBMITTED', txSignature: null, failureReason: null })]);
    r = await runFundingCycle(h.deps);
    expect(r.refused).toEqual({ MALFORMED_PAYLOAD: 1 });
  });

  it('refuses a substituted destination, mint or cluster and an unknown destination wallet', async () => {
    const h = harness();
    h.setPending([request({ transfer: { ...transfer, cluster: 'devnet' }, outcome: 'SUBMITTED', txSignature: SIG, failureReason: null })]);
    let r = await runFundingCycle(h.deps);
    expect(r.refused).toEqual({ FUNDING_GUARD: 1 });
    expect(h.resolved[0]!.resolution['reasons']).toEqual(['CLUSTER_MISMATCH']);
    h.setPending([request({ transfer: { ...transfer, destinationTradingWallet: SOURCE }, outcome: 'SUBMITTED', txSignature: SIG, failureReason: null })]);
    r = await runFundingCycle(h.deps);
    expect(r.refused).toEqual({ UNKNOWN_DESTINATION: 1 });
    h.setPending([request({ transfer: { ...transfer, fundingMint: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }, outcome: 'SUBMITTED', txSignature: SIG, failureReason: null })]);
    r = await runFundingCycle(h.deps);
    expect(r.refused).toEqual({ FUNDING_GUARD: 1 });
    expect(h.inserted).toHaveLength(0);
  });

  it('viewers cannot record funding', async () => {
    const h = harness('viewer');
    h.setPending([request({ transfer, outcome: 'SUBMITTED', txSignature: SIG, failureReason: null })]);
    expect((await runFundingCycle(h.deps)).refused).toEqual({ NOT_AN_OPERATOR: 1 });
  });
});
