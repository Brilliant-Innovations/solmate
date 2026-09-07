import { addMs, DEFAULT_PAPER_FILL_POLICY, DEFAULT_RISK_POLICY, fixedClock, toInstant, type Amount, type Bps, type Fill, type MintAddress, type Order, type OrderAttempt, type PortfolioSnapshot, type Position, type PositionLot, type RiskEvaluation, type SolanaAddress, type StrategySleeve, type TradeIntent, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { EntryCandidateRow, PaperBook } from '@sol-agent-trader/db/server';
import { PaperExecutionAdapter, quoteOf, scriptedQuoteClient } from '@sol-agent-trader/execution';
import { createLogger } from '@sol-agent-trader/observability';
import { s0StrategyVersion } from '@sol-agent-trader/strategies';
import { runPaperEntryCycle, type PaperEntryRepo } from './paper-entry.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress;
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
let seq = 100;
const newId = () => id(++seq);
const logger = createLogger({ service: 'worker', sink: () => undefined });
const SAFE = s0StrategyVersion('SAFE', 'abcdef1', NOW);
const sleeve: StrategySleeve = { id: id(1), accountId: id(2), strategyVersionId: SAFE.versionId, versionId: 'sleeve-v1' as VersionId, settlementMint: USDC, capitalCapBaseUnits: '4000000000' as Amount, riskBudgetBaseUnits: '500000000' as Amount, committedBaseUnits: '0' as Amount, riskUsedBaseUnits: '0' as Amount, active: true, createdAt: NOW };

const row = (over: Partial<EntryCandidateRow> = {}): EntryCandidateRow => ({
  cycle: { id: id(10), strategyVersionId: SAFE.versionId, candidateId: id(11), clearedCutoffVersion: 1, startedAt: addMs(NOW, -5_000) },
  proposal: { id: id(12), actionCycleId: id(10), candidateId: id(11), positionId: null, strategyVersionId: SAFE.versionId, source: 'DETERMINISTIC', createdAt: addMs(NOW, -5_000), expiresAt: addMs(NOW, 300_000), proposal: { actionType: 'ENTER', direction: 'LONG', candidateId: id(11), positionId: null, strategyVersionId: SAFE.versionId, skillVersionId: null, triggerId: id(11), thesis: 't', supportingEvidenceIds: [], contradictingEvidenceIds: [], catalystNovelty: null, expectedHorizonMinutes: 240, confidence: 0.7, invalidation: 'i', requestedFractionToReduce: null, protectionIntent: null, urgency: 'normal', expiresAt: addMs(NOW, 300_000), reasoningSummary: 'r', evidenceCutoffVersion: 1 } },
  asset: { id: id(20), mint: TOKEN, decimals: 9, symbol: 'TKN', tokenProgram: 'TOKEN' },
  eligibility: { id: id(21), settlementRouteConfirmed: true, liquidityUsd: 800_000 },
  snapshot: { id: id(22), asOf: addMs(NOW, -60_000), features: { atr_14_pct: 0.02, liquidity_usd: 800_000 } },
  ...over,
});

class MemoryRepo implements PaperEntryRepo {
  rows: EntryCandidateRow[] = [];
  evaluations: RiskEvaluation[] = [];
  intents: { intent: TradeIntent; states: string[] }[] = [];
  attempts: { order: Order; attempt: OrderAttempt; fill: Fill | null }[] = [];
  positions: { position: Position; lot: PositionLot }[] = [];
  snapshots: PortfolioSnapshot[] = [];
  bookState: PaperBook = { settlementBalance: '10000000000' as Amount, exposureAtCost: '0' as Amount, openPositions: [], pendingExposure: '0' as Amount, inFlightIncreasing: 0, sleeves: [sleeve], feesLamports: '0' as Amount, consecutiveLosses: 0, dayStartEquity: null, rollingHighEquity: null };
  healthState = { feedsBlockEntries: false, entriesPaused: false };
  async listAwaiting() { return this.rows.filter((r) => !this.evaluations.some((e) => e.actionCycleId === r.cycle.id)); }
  async book() { return this.bookState; }
  async health() { return this.healthState; }
  async recordRiskEvaluation(e: RiskEvaluation) { if (this.evaluations.some((x) => x.actionCycleId === e.actionCycleId)) throw new Error('already evaluated'); this.evaluations.push(e); }
  async createIntent(intent: TradeIntent) { this.intents.push({ intent, states: ['AUTHORIZED'] }); }
  async setIntentState(intentId: Uuid, state: string) { this.intents.find((i) => i.intent.id === intentId)!.states.push(state); }
  async finishAttempt(order: Order, attempt: OrderAttempt, fill: Fill | null) { this.attempts.push({ order, attempt, fill }); }
  async openPosition(position: Position, lot: PositionLot) { this.positions.push({ position, lot }); this.bookState = { ...this.bookState, openPositions: [...this.bookState.openPositions, { id: position.id, assetId: position.assetId, mint: position.mint, quantity: position.quantity, costBasis: position.costBasisBaseUnits }], exposureAtCost: (BigInt(this.bookState.exposureAtCost) + BigInt(position.costBasisBaseUnits)).toString() as Amount, settlementBalance: (BigInt(this.bookState.settlementBalance) - BigInt(position.costBasisBaseUnits)).toString() as Amount }; }
  async writeSnapshot(s: PortfolioSnapshot) { this.snapshots.push(s); }
}

function deps(repo: MemoryRepo, quotes: ReturnType<typeof scriptedQuoteClient>) {
  const adapter = new PaperExecutionAdapter({ quotes, clock: fixedClock(NOW), policy: DEFAULT_PAPER_FILL_POLICY, taker: TOKEN as unknown as SolanaAddress, cluster: 'mainnet-beta', newId, wait: async () => undefined, journal: async () => undefined });
  return {
    repo,
    adapter,
    referenceQuote: async (_i: MintAddress, _o: MintAddress, amount: Amount) => ({ impactBps: 20 as Bps, expectedOutputAmount: ((BigInt(amount) * 10n ** 9n) / 100_000_000n).toString() as Amount, slippageBps: 100 as Bps, quotedAt: NOW }),
    clock: fixedClock(NOW),
    logger,
    account: { id: id(2), settlementMint: USDC, settlementDecimals: 6, startingCapital: '10000000000' as Amount, virtualSolLamports: '1000000000' as Amount },
    strategies: { [SAFE.versionId]: SAFE },
    sleeves: { [SAFE.versionId]: sleeve },
    policy: DEFAULT_RISK_POLICY,
    config: { batchSize: 10, featureMaxAgeMs: 300_000 },
  };
}

describe('worker role paper-entry (§13, §17, M5a first paper trade)', () => {
  it('evaluates a cleared cycle, creates the intent, fills through the paper adapter, opens the position with its sleeve lot and writes a snapshot', async () => {
    const repo = new MemoryRepo();
    repo.rows = [row()];
    // 100 USDC (1e8) buys 1e9 token base units at both decision and execution: price 100 USDC per token
    const quotes = scriptedQuoteClient([quoteOf(200_000_000n, 2_000_000_000n, 100, 20, USDC, TOKEN, NOW), quoteOf(200_000_000n, 1_990_000_000n, 100, 20, USDC, TOKEN, NOW)]);
    const report = await runPaperEntryCycle(deps(repo, quotes));
    expect(report).toMatchObject({ scanned: 1, allowed: 1, refused: 0, filled: 1, notFilled: 0, errors: [] });
    expect(repo.evaluations).toHaveLength(1);
    expect(repo.evaluations[0]).toMatchObject({ allowed: true, computedPositionAmount: '200000000', policyVersion: 'risk-v1' });
    const { intent, states } = repo.intents[0]!;
    expect(intent).toMatchObject({ idempotencyKey: 'entry:00000010-0000-4000-8000-000000000000', maxInputAmount: '200000000', exposureEffect: 'INCREASE', sleeveId: sleeve.id, riskEvaluationId: repo.evaluations[0]!.id });
    expect(states).toEqual(['AUTHORIZED', 'EXECUTING', 'COMPLETED']);
    expect(repo.attempts[0]!.attempt.state).toBe('FINALIZED');
    expect(repo.attempts[0]!.fill).not.toBeNull();
    const { position, lot } = repo.positions[0]!;
    expect(position).toMatchObject({ status: 'OPEN', reviewState: 'REVIEWED', safetyState: 'NORMAL', costBasisBaseUnits: '200000000', quantity: repo.attempts[0]!.fill!.outputAmount, lastReviewedCycleId: id(10) });
    expect(position.stop).toMatchObject({ model: 'ATR', distanceFraction: 0.04 });
    expect(position.averageEntryPrice).toBeCloseTo(100.65, 1); // 200 USDC / 1.98701 tokens after the 15 bps allowance
    expect(position.unreviewedStop).toBeCloseTo(position.averageEntryPrice! * 0.96, 3);
    expect(lot).toMatchObject({ sleeveId: sleeve.id, strategyVersionId: SAFE.versionId, protectionMode: 'MONITORED_EXIT', entryIntentId: intent.id, entryFillIds: [repo.attempts[0]!.fill!.id], status: 'OPEN' });
    expect(repo.snapshots).toHaveLength(1);
    expect(repo.snapshots[0]).toMatchObject({ equityBaseUnits: '10000000000', exposureBaseUnits: '200000000', exposureFraction: 0.02 });
  });

  it('a refused evaluation is recorded once and creates no intent; a second cycle sees the first fill as exposure', async () => {
    const repo = new MemoryRepo();
    repo.rows = [row(), row({ cycle: { ...row().cycle, id: id(30) }, proposal: { ...row().proposal, id: id(31), actionCycleId: id(30) } })];
    repo.healthState = { feedsBlockEntries: true, entriesPaused: false };
    const quotes = scriptedQuoteClient([quoteOf(200_000_000n, 2_000_000_000n, 100, 20, USDC, TOKEN, NOW)]);
    const report = await runPaperEntryCycle(deps(repo, quotes));
    expect(report).toMatchObject({ scanned: 2, allowed: 0, refused: 2, filled: 0, refusalsByCode: { FEEDS_STALE: 2 } });
    expect(repo.intents).toHaveLength(0);
    expect(repo.evaluations.map((e) => e.actionCycleId)).toEqual([id(10), id(30)]);
    // nothing left awaiting: every cleared cycle carries exactly one evaluation
    expect(await repo.listAwaiting()).toEqual([]);

    const repo2 = new MemoryRepo();
    repo2.rows = [row(), row({ cycle: { ...row().cycle, id: id(30) }, proposal: { ...row().proposal, id: id(31), actionCycleId: id(30) } })];
    const quotes2 = scriptedQuoteClient([quoteOf(200_000_000n, 2_000_000_000n, 100, 20, USDC, TOKEN, NOW)]);
    const report2 = await runPaperEntryCycle(deps(repo2, quotes2));
    // both cycles on the same asset are allowed (2 % of equity each, 2 of 3 positions); the second is sized against the book that already holds the first
    expect(report2.filled).toBe(2);
    const total = repo2.intents.reduce((acc, i) => acc + BigInt(i.intent.maxInputAmount), 0n);
    expect(total <= 10_000_000_000n - BigInt(DEFAULT_RISK_POLICY.minSettlementReserveBaseUnits)).toBe(true);
    expect(repo2.evaluations).toHaveLength(2);
  });

  it('a not-landed paper attempt marks the intent FAILED, opens nothing and is counted', async () => {
    const repo = new MemoryRepo();
    repo.rows = [row()];
    const tight = { ...DEFAULT_RISK_POLICY, maxSlippageBps: 5 as Bps };
    const quotes = scriptedQuoteClient([quoteOf(200_000_000n, 2_000_000_000n, 5, 20, USDC, TOKEN, NOW), quoteOf(200_000_000n, 2_000_000_000n, 5, 20, USDC, TOKEN, NOW)]);
    const d = { ...deps(repo, quotes), policy: tight, referenceQuote: async (_i: MintAddress, _o: MintAddress, amount: Amount) => ({ impactBps: 20 as Bps, expectedOutputAmount: ((BigInt(amount) * 10n ** 9n) / 100_000_000n).toString() as Amount, slippageBps: 5 as Bps, quotedAt: NOW }) };
    const report = await runPaperEntryCycle(d);
    expect(report).toMatchObject({ allowed: 1, filled: 0, notFilled: 1 });
    expect(repo.intents[0]!.states).toEqual(['AUTHORIZED', 'EXECUTING', 'FAILED']);
    expect(repo.attempts[0]!.attempt.state).toBe('NOT_LANDED');
    expect(repo.positions).toHaveLength(0);
  });
});
