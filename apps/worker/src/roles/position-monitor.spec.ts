import { addMs, DEFAULT_PAPER_FILL_POLICY, DEFAULT_RISK_POLICY, fixedClock, toInstant, type ActionCycle, type AdversarialReview, type Amount, type Bps, type Fill, type Instant, type MintAddress, type Order, type OrderAttempt, type PortfolioSnapshot, type Proposal, type RiskEvaluation, type SignedAmount, type SolanaAddress, type TradeIntent, type Uuid } from '@sol-agent-trader/contracts';
import type { ExitApplication, OpenPositionRow, PaperBook } from '@sol-agent-trader/db/server';
import { PaperExecutionAdapter, quoteOf, scriptedQuoteClient } from '@sol-agent-trader/execution';
import { createLogger } from '@sol-agent-trader/observability';
import { s0StrategyVersion } from '@sol-agent-trader/strategies';
import { runPositionMonitorCycle, type PositionMonitorRepo } from './position-monitor.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress;
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' as MintAddress;
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
let seq = 500;
const newId = () => id(++seq);
const logger = createLogger({ service: 'worker', sink: () => undefined });
const SAFE = s0StrategyVersion('SAFE', 'abcdef1', NOW);

/** 2 tokens (9 decimals) bought for 200 USDC: entry 100, ATR stop 4 % at 96. */
const position = (over: Partial<OpenPositionRow> = {}): OpenPositionRow => ({
  id: id(1), accountId: id(2), assetId: id(3), mint: TOKEN, decimals: 9, symbol: 'TKN', quantity: '2000000000' as Amount, averageEntryPrice: 100, costBasisBaseUnits: '200000000' as Amount, realizedPnlBaseUnits: '0' as SignedAmount,
  stop: { model: 'ATR', level: 96, distanceFraction: 0.04 }, target: { policy: 'TRAILING_AFTER_THRESHOLD', parameters: { targetRMultiple: 3, trailAfterRMultiple: 1, trailFraction: 0.04, maxHoldMs: 6 * 3_600_000 } }, unreviewedStop: 96, safetyState: 'NORMAL', openedAt: addMs(NOW, -600_000),
  lots: [{ id: id(4), sleeveId: id(5), strategyVersionId: SAFE.versionId, quantity: '2000000000' as Amount, costBasisBaseUnits: '200000000' as Amount, entryIntentId: id(6) }],
  ...over,
});

class MemoryRepo implements PositionMonitorRepo {
  positions: OpenPositionRow[] = [];
  marks: { positionId: Uuid; pnl: SignedAmount }[] = [];
  stops: { positionId: Uuid; level: number }[] = [];
  decisions: { cycle: ActionCycle; proposal: Proposal; review: AdversarialReview; evaluation: RiskEvaluation }[] = [];
  intents: { intent: TradeIntent; states: string[] }[] = [];
  attempts: { order: Order; attempt: OrderAttempt; fill: Fill | null }[] = [];
  exits: ExitApplication[] = [];
  snapshots: PortfolioSnapshot[] = [];
  candleHigh: number | null = null;
  async listOpenPositions() { return this.positions; }
  async highSince() { return this.candleHigh; }
  async updateMark(positionId: Uuid, pnl: SignedAmount) { this.marks.push({ positionId, pnl }); }
  async tightenStop(positionId: Uuid, level: number) { const p = this.positions.find((x) => x.id === positionId)!; if (p.unreviewedStop !== null && p.unreviewedStop >= level) return false; p.unreviewedStop = level; this.stops.push({ positionId, level }); return true; }
  async recordExitDecision(cycle: ActionCycle, proposal: Proposal, review: AdversarialReview, evaluation: RiskEvaluation) { this.decisions.push({ cycle, proposal, review, evaluation }); }
  async createIntent(intent: TradeIntent) { this.intents.push({ intent, states: ['AUTHORIZED'] }); }
  async setIntentState(intentId: Uuid, state: string) { this.intents.find((i) => i.intent.id === intentId)!.states.push(state); }
  async finishAttempt(order: Order, attempt: OrderAttempt, fill: Fill | null) { this.attempts.push({ order, attempt, fill }); }
  async applyExit(x: ExitApplication) { this.exits.push(x); }
  async book(): Promise<PaperBook> { return { settlementBalance: '9800000000' as Amount, exposureAtCost: '200000000' as Amount, markValue: '210000000' as Amount, realizedBySleeve: { [id(5)]: '0' }, openPositions: [], pendingExposure: '0' as Amount, inFlightIncreasing: 0, sleeves: [], feesLamports: '0' as Amount, consecutiveLosses: 0, dayStartEquity: '10000000000' as Amount, rollingHighEquity: '10050000000' as Amount }; }
  async writeSnapshot(s: PortfolioSnapshot) { this.snapshots.push(s); }
}

/** Exit quote: selling 2 tokens returns `usdc` USDC. */
function deps(repo: MemoryRepo, usdcForTwoTokens: bigint, execOut = usdcForTwoTokens) {
  const quotes = scriptedQuoteClient([quoteOf(2_000_000_000n, usdcForTwoTokens * 1_000_000n, 100, 20, TOKEN, USDC, NOW), quoteOf(2_000_000_000n, execOut * 1_000_000n, 100, 20, TOKEN, USDC, NOW)]);
  const adapter = new PaperExecutionAdapter({ quotes, clock: fixedClock(NOW), policy: DEFAULT_PAPER_FILL_POLICY, taker: TOKEN as unknown as SolanaAddress, cluster: 'mainnet-beta', newId, wait: async () => undefined, journal: async () => undefined });
  return {
    repo,
    adapter,
    exitQuote: async (_i: MintAddress, _o: MintAddress, amount: Amount) => ({ expectedOutputAmount: ((BigInt(amount) * usdcForTwoTokens * 1_000_000n) / 2_000_000_000n).toString() as Amount, impactBps: 20 as Bps }),
    clock: fixedClock(NOW),
    logger,
    account: { id: id(2), settlementMint: USDC, settlementDecimals: 6 },
    strategies: { [SAFE.versionId]: SAFE },
    policy: DEFAULT_RISK_POLICY,
    config: { batchSize: 10, reassessMs: 30_000 },
  };
}

describe('worker role position-monitor (§13.4–13.5, §17.2, D31, D39, D44)', () => {
  it('marks the position from the executable exit quote and holds when no policy fires; the snapshot carries marks and drawdown', async () => {
    const repo = new MemoryRepo();
    repo.positions = [position()];
    const report = await runPositionMonitorCycle(deps(repo, 202n)); // price 101: below 1R (104), above the stop
    expect(report).toMatchObject({ positions: 1, marked: 1, held: 1, tightened: 0, exits: 0, errors: [] });
    expect(repo.marks).toEqual([{ positionId: id(1), pnl: '2000000' }]);
    expect(repo.intents).toHaveLength(0);
    expect(repo.snapshots[0]).toMatchObject({ equityBaseUnits: '10010000000', exposureBaseUnits: '210000000', drawdown: { dailyFraction: 0, rollingFraction: expect.closeTo(0.00398, 4) } });
  });

  it('trails after 1R and only ever tightens the stop', async () => {
    const repo = new MemoryRepo();
    repo.positions = [position()];
    repo.candleHigh = 106;
    await runPositionMonitorCycle(deps(repo, 210n)); // price 105, high 106 ≥ 1R → trail to 106 × 0.96 = 101.76
    expect(repo.stops).toEqual([{ positionId: id(1), level: expect.closeTo(101.76, 6) }]);
    repo.candleHigh = 104; // a lower high later
    const report = await runPositionMonitorCycle(deps(repo, 208n));
    expect(report.tightened).toBe(0);
    expect(repo.positions[0]!.unreviewedStop).toBeCloseTo(101.76, 6);
  });

  it('a hard-stop breach exits the whole position through a recorded cycle, a lot-scoped intent, a paper fill and final accounting', async () => {
    const repo = new MemoryRepo();
    repo.positions = [position()];
    const report = await runPositionMonitorCycle(deps(repo, 190n)); // price 95 < stop 96
    expect(report).toMatchObject({ exits: 1, filled: 1, exitsByReason: { HARD_STOP: 1 } });
    const d = repo.decisions[0]!;
    expect(d.cycle).toMatchObject({ state: 'CLEARED', verdict: 'CONFIRM', proposedAction: 'EXIT', positionId: id(1), candidateId: null, reasonCodes: ['HARD_STOP'] });
    expect(d.review).toMatchObject({ deterministicGate: true, blocking: false, verdict: 'CONFIRM' });
    expect(d.evaluation).toMatchObject({ allowed: true, reasonCodes: ['HARD_STOP'], computedPositionAmount: '2000000000', proposalId: d.proposal.id, actionCycleId: d.cycle.id });
    const { intent, states } = repo.intents[0]!;
    expect(intent).toMatchObject({ action: 'EXIT', side: 'SELL', exposureEffect: 'REDUCE', inputMint: TOKEN, outputMint: USDC, maxInputAmount: '2000000000', targetLotIds: [id(4)], riskEvaluationId: d.evaluation.id, actionCycleId: d.cycle.id });
    expect(intent.idempotencyKey).toBe(`exit:${id(1)}:${d.cycle.id}`);
    expect(states).toEqual(['AUTHORIZED', 'EXECUTING']); // COMPLETED is set by applyExit in the same transaction
    expect(repo.attempts[0]!.attempt.state).toBe('FINALIZED');
    const x = repo.exits[0]!;
    expect(x).toMatchObject({ positionId: id(1), intentId: intent.id, closesPosition: true });
    expect(x.fill.lotAllocations).toEqual([{ lotId: id(4), quantity: '2000000000' }]);
    // 190 USDC gross, 15 bps allowance → 189.715 USDC proceeds against 200 USDC cost
    expect(x.lots).toEqual([{ lotId: id(4), sleeveId: id(5), quantity: '2000000000', costReleased: '200000000', realizedPnl: '-10285000' }]);
  });

  it('a partial tier reduces half across lots pro rata and leaves the position open; a safety CRITICAL_EXIT exits regardless of price', async () => {
    const repo = new MemoryRepo();
    const tiers = position({ target: { policy: 'PARTIAL_TIERS', parameters: { targetRMultiple: 2, trailAfterRMultiple: 1, trailFraction: 0.04, maxHoldMs: 6 * 3_600_000 } }, lots: [
      { id: id(41), sleeveId: id(5), strategyVersionId: SAFE.versionId, quantity: '1500000000' as Amount, costBasisBaseUnits: '150000000' as Amount, entryIntentId: id(6) },
      { id: id(42), sleeveId: id(5), strategyVersionId: SAFE.versionId, quantity: '500000000' as Amount, costBasisBaseUnits: '50000000' as Amount, entryIntentId: id(7) },
    ] });
    repo.positions = [tiers];
    const report = await runPositionMonitorCycle(deps(repo, 209n)); // price 104.5 = 1R of a 2R target → REDUCE 50 %
    expect(report).toMatchObject({ reductions: 1, filled: 1, exitsByReason: { PARTIAL_TIER: 1 } });
    expect(repo.intents[0]!.intent).toMatchObject({ action: 'REDUCE', maxInputAmount: '1000000000', targetLotIds: [id(41)] });
    expect(repo.exits[0]).toMatchObject({ closesPosition: false });
    expect(repo.exits[0]!.lots).toEqual([{ lotId: id(41), sleeveId: id(5), quantity: '1000000000', costReleased: '100000000', realizedPnl: expect.stringMatching(/^\d+$/) }]);

    const repo2 = new MemoryRepo();
    repo2.positions = [position({ safetyState: 'CRITICAL_EXIT' })];
    const report2 = await runPositionMonitorCycle(deps(repo2, 220n)); // price 110: no policy exit, safety forces one
    expect(report2).toMatchObject({ exits: 1, filled: 1, exitsByReason: { SAFETY_CRITICAL_EXIT: 1 } });
    expect(repo2.decisions[0]!.cycle.reasonCodes).toEqual(['SAFETY_CRITICAL_EXIT']);
  });

  it('a not-landed exit leaves the position open with a FAILED intent so the next cycle retries under a new key', async () => {
    const repo = new MemoryRepo();
    repo.positions = [position()];
    const d = { ...deps(repo, 190n), policy: { ...DEFAULT_RISK_POLICY, maxSlippageBps: 5 as Bps } };
    const report = await runPositionMonitorCycle(d);
    expect(report).toMatchObject({ exits: 1, filled: 0, notFilled: 1 });
    expect(repo.intents[0]!.states).toEqual(['AUTHORIZED', 'EXECUTING', 'FAILED']);
    expect(repo.exits).toHaveLength(0);
    void ((_: Instant) => undefined);
  });
});
