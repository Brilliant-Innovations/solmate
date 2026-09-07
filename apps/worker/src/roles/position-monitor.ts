import { randomUUID } from 'node:crypto';
import { newActionCycle, transition, type ActionCycleEvent } from '@sol-agent-trader/agents';
import { addMs, amountToBigInt, bigIntToAmount, mulDiv, type ActionCycle, type AdversarialReview, type Amount, type Bps, type Clock, type ExecutionRequest, type Fill, type Instant, type MintAddress, type Order, type OrderAttempt, type PortfolioSnapshot, type Proposal, type RiskEvaluation, type RiskPolicy, type SignedAmount, type StrategyVersion, type TradeIntent, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { ExitApplication, OpenPositionRow, PaperBook, TradeIntentState } from '@sol-agent-trader/db/server';
import { allocateExit, impliedPrice, type DetailedExecution } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';
import { evaluateExitPolicy, type ExitDecision } from '@sol-agent-trader/risk';

/**
 * Worker role `position-monitor` (blueprint §13.4–13.5, §11.11, §17.2, D31, D39, D44; execution
 * plan M5a MONITORED_EXIT). Every cycle, for each open paper position: take a real exit quote at
 * the full quantity (the executable mark), store the unrealized P&L, then apply the deterministic
 * exit policy: hard stop, time stop, target, partial tier, trailing stop (tighten only). A held
 * asset in CRITICAL_EXIT or EXIT_RECOMMENDED exits unconditionally: S0 has no discretionary review
 * to weigh a recommendation, so the conservative reading is mandatory.
 *
 * Every exit is recorded as a position action cycle (EXIT/REDUCE, deterministic proposer, the
 * policy as a non-blocking deterministic review: mandatory risk reduction never waits, D31),
 * with a risk evaluation, an intent naming the lots it reduces, the paper adapter's attempt and
 * fill, and lot-scoped accounting on FINALIZED only (INV-22). Nothing here increases exposure.
 */

export interface PositionMonitorRepo {
  listOpenPositions(limit: number): Promise<OpenPositionRow[]>;
  highSince(assetId: Uuid, since: Instant, until: Instant): Promise<number | null>;
  updateMark(positionId: Uuid, unrealizedPnl: SignedAmount, nextReassessmentAt: Instant): Promise<void>;
  tightenStop(positionId: Uuid, level: number): Promise<boolean>;
  recordExitDecision(cycle: ActionCycle, proposal: Proposal, review: AdversarialReview, evaluation: RiskEvaluation): Promise<void>;
  createIntent(intent: TradeIntent, lifecycle: 'AUTHORIZED'): Promise<void>;
  setIntentState(intentId: Uuid, state: TradeIntentState): Promise<void>;
  finishAttempt(order: Order, attempt: OrderAttempt, fill: Fill | null): Promise<void>;
  applyExit(x: ExitApplication): Promise<void>;
  book(now: Instant): Promise<PaperBook>;
  writeSnapshot(snapshot: PortfolioSnapshot): Promise<void>;
  /** The account's open session activity; WIND_DOWN closes every paper lot (§21.2B step 4). */
  sessionActivity(): Promise<string | null>;
}

export interface PositionMonitorDeps {
  repo: PositionMonitorRepo;
  adapter: { executeDetailed(request: ExecutionRequest): Promise<DetailedExecution> };
  /** Exit quote at the full quantity: the executable mark (§17.2). Null = no route now. */
  exitQuote: (inputMint: MintAddress, outputMint: MintAddress, inputAmount: Amount, maxSlippageBps: Bps, now: Instant) => Promise<{ expectedOutputAmount: Amount; impactBps: Bps | null } | null>;
  clock: Clock;
  logger: Logger;
  account: { id: Uuid; settlementMint: MintAddress; settlementDecimals: number };
  strategies: Record<VersionId, StrategyVersion>;
  policy: RiskPolicy;
  config: { batchSize: number; reassessMs: number };
}

export interface PositionMonitorReport {
  positions: number;
  marked: number;
  unmarked: number;
  held: number;
  tightened: number;
  exits: number;
  reductions: number;
  filled: number;
  notFilled: number;
  exitsByReason: Record<string, number>;
  errors: { positionId: Uuid; error: string }[];
}

export async function runPositionMonitorCycle(deps: PositionMonitorDeps): Promise<PositionMonitorReport> {
  const now = deps.clock.now();
  const report: PositionMonitorReport = { positions: 0, marked: 0, unmarked: 0, held: 0, tightened: 0, exits: 0, reductions: 0, filled: 0, notFilled: 0, exitsByReason: {}, errors: [] };
  const positions = await deps.repo.listOpenPositions(deps.config.batchSize);
  report.positions = positions.length;
  const windDown = (await deps.repo.sessionActivity()) === 'WIND_DOWN';

  for (const p of positions) {
    try {
      const quote = await deps.exitQuote(p.mint, deps.account.settlementMint, p.quantity, deps.policy.maxSlippageBps, now);
      const safetyExit = p.safetyState === 'CRITICAL_EXIT' || p.safetyState === 'EXIT_RECOMMENDED';
      const forcedReason = windDown ? 'SESSION_WIND_DOWN' : safetyExit ? `SAFETY_${p.safetyState}` : null;
      if (!quote) {
        report.unmarked++;
        deps.logger.warn('position_unmarked', { positionId: p.id, asset: p.symbol, safetyState: p.safetyState, hint: safetyExit ? 'exit wanted but no route now; held-asset safety owns NO_EXIT_PATH' : 'no exit route for a mark this cycle' });
        continue;
      }
      const price = impliedPrice(quote.expectedOutputAmount, deps.account.settlementDecimals, p.quantity, p.decimals);
      const unrealized = (amountToBigInt(quote.expectedOutputAmount) - amountToBigInt(p.costBasisBaseUnits)).toString() as SignedAmount;
      await deps.repo.updateMark(p.id, unrealized, addMs(now, deps.config.reassessMs));
      report.marked++;
      if (price === null || p.averageEntryPrice === null || !(p.averageEntryPrice > 0)) {
        deps.logger.warn('position_unpriced', { positionId: p.id, asset: p.symbol });
        continue;
      }

      let decision: ExitDecision;
      if (forcedReason) {
        decision = { action: 'EXIT', stop: p.unreviewedStop ?? p.stop?.level ?? 0, reasons: [forcedReason] };
      } else {
        const candleHigh = await deps.repo.highSince(p.assetId, p.openedAt, now);
        const high = Math.max(candleHigh ?? 0, price, p.averageEntryPrice);
        const stop = p.unreviewedStop ?? p.stop?.level ?? p.averageEntryPrice * (1 - deps.policy.stop.maxStopFraction);
        const tp = takeProfitOf(p, deps.policy);
        decision = evaluateExitPolicy(tp, { entryPrice: p.averageEntryPrice, currentPrice: price, highSinceEntry: high, currentStop: stop, initialStopDistanceFraction: p.stop?.distanceFraction ?? deps.policy.stop.maxStopFraction, openedAt: p.openedAt, now });
      }

      if (decision.action === 'HOLD') {
        report.held++;
        continue;
      }
      if (decision.action === 'TIGHTEN_STOP') {
        if (await deps.repo.tightenStop(p.id, decision.stop)) report.tightened++;
        deps.logger.info('position_stop_tightened', { positionId: p.id, asset: p.symbol, stop: decision.stop, price });
        continue;
      }
      // REDUCE or EXIT: a mandatory, deterministic risk reduction.
      const fraction = decision.action === 'REDUCE' ? decision.fraction : 1;
      const requested = decision.action === 'EXIT' ? p.quantity : mulDiv(p.quantity, BigInt(Math.round(fraction * 1_000_000)), 1_000_000n, 'FLOOR');
      if (amountToBigInt(requested) === 0n) continue;
      const reason = decision.reasons[decision.reasons.length - 1] ?? 'EXIT';
      const outcome = await executeExit(deps, p, decision.action, fraction, requested, quote.impactBps, reason, now);
      if (decision.action === 'EXIT') report.exits++;
      else report.reductions++;
      report.exitsByReason[reason] = (report.exitsByReason[reason] ?? 0) + 1;
      if (outcome === 'FILLED') report.filled++;
      else report.notFilled++;
    } catch (err) {
      report.errors.push({ positionId: p.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    const book = await deps.repo.book(now);
    await deps.repo.writeSnapshot(snapshotOf(deps, book, now));
  } catch (err) {
    report.errors.push({ positionId: '00000000-0000-4000-8000-000000000000' as Uuid, error: `snapshot: ${err instanceof Error ? err.message : String(err)}` });
  }
  deps.logger.info('position_monitor_cycle', { positions: report.positions, marked: report.marked, unmarked: report.unmarked, held: report.held, tightened: report.tightened, exits: report.exits, reductions: report.reductions, filled: report.filled, notFilled: report.notFilled, exitsByReason: report.exitsByReason, errors: report.errors.length });
  for (const e of report.errors) deps.logger.warn('position_monitor_failed', { positionId: e.positionId, error: e.error });
  return report;
}

function takeProfitOf(p: OpenPositionRow, policy: RiskPolicy): RiskPolicy['takeProfit'] {
  const params = p.target?.parameters ?? {};
  const num = (k: string, fallback: number) => (typeof params[k] === 'number' ? (params[k] as number) : fallback);
  return {
    policy: p.target?.policy ?? policy.takeProfit.policy,
    targetRMultiple: num('targetRMultiple', policy.takeProfit.targetRMultiple),
    trailAfterRMultiple: num('trailAfterRMultiple', policy.takeProfit.trailAfterRMultiple),
    trailFraction: num('trailFraction', policy.takeProfit.trailFraction),
    maxHoldMs: num('maxHoldMs', policy.takeProfit.maxHoldMs),
  };
}

async function executeExit(deps: PositionMonitorDeps, p: OpenPositionRow, action: 'EXIT' | 'REDUCE', fraction: number, requested: Amount, impactBps: Bps | null, reason: string, now: Instant): Promise<'FILLED' | 'NOT_FILLED'> {
  const strategyVersionId = p.lots[0]?.strategyVersionId ?? (Object.keys(deps.strategies)[0] as VersionId);
  const strategy = deps.strategies[strategyVersionId];
  if (!strategy) throw new Error(`no strategy ${strategyVersionId} for position ${p.id}`);

  // Lot allocation: oldest lots first, exactly the named quantities (D44).
  const allocations: { lotId: Uuid; quantity: Amount }[] = [];
  let remaining = amountToBigInt(requested);
  for (const lot of p.lots) {
    if (remaining === 0n) break;
    const take = remaining < amountToBigInt(lot.quantity) ? remaining : amountToBigInt(lot.quantity);
    if (take > 0n) allocations.push({ lotId: lot.id, quantity: bigIntToAmount(take) });
    remaining -= take;
  }
  const allocated = allocateExit(p.lots.map((l) => ({ lotId: l.id, sleeveId: l.sleeveId, quantity: l.quantity })), allocations);
  if (!allocated.ok) throw new Error(`lot allocation failed: ${allocated.code}`);

  // Action cycle: deterministic proposer, the policy as a non-blocking deterministic review (D31).
  let cycle = newActionCycle({ id: randomUUID() as Uuid, triggerId: p.id, strategyVersionId, speedTier: strategy.speedTier, decisionBudgetMs: strategy.maxDecisionLatencyMs, startedAt: now, positionId: p.id });
  const proposalId = randomUUID() as Uuid;
  const events: ActionCycleEvent[] = [
    { type: 'CONTEXT_BUILT', at: now },
    { type: 'PROPOSED', at: now, runId: null, proposalId, action, cutoffVersion: 1 },
    { type: 'ADVERSARY_REVIEWED', at: now, runId: null, verdict: 'CONFIRM', cutoffVersion: 1, reasonCodes: [reason] },
  ];
  for (const e of events) {
    const r = transition(cycle, e);
    if (!r.ok) throw new Error(`exit cycle rejected ${e.type}: ${JSON.stringify(r.rejection)}`);
    cycle = r.cycle;
  }
  const expiresAt = addMs(now, strategy.liveIntentExpiryMs);
  const proposal: Proposal = {
    id: proposalId, actionCycleId: cycle.id, candidateId: null, positionId: p.id, strategyVersionId, source: 'DETERMINISTIC', createdAt: now, expiresAt,
    proposal: { actionType: action, direction: 'LONG', candidateId: null, positionId: p.id, strategyVersionId, skillVersionId: null, triggerId: p.id, thesis: `Deterministic ${action}: ${reason}`, supportingEvidenceIds: [], contradictingEvidenceIds: [], catalystNovelty: null, expectedHorizonMinutes: 1, confidence: 1, invalidation: 'n/a: mandatory risk reduction', requestedFractionToReduce: action === 'REDUCE' ? fraction : null, protectionIntent: null, urgency: 'high', expiresAt, reasoningSummary: `position monitor ${reason}`, evidenceCutoffVersion: 1 },
  };
  const review: AdversarialReview = { id: randomUUID() as Uuid, actionCycleId: cycle.id, agentRunId: null, deterministicGate: true, verdict: 'CONFIRM', objections: [], confidence: 1, cutoffVersion: 1, latencyMs: 0, blocking: false, createdAt: now };
  const evaluation: RiskEvaluation = {
    id: randomUUID() as Uuid, proposalId, actionCycleId: cycle.id, policyVersion: deps.policy.version, allowed: true, reasonCodes: [reason], settlementMint: deps.account.settlementMint,
    equityBaseUnits: '0' as Amount, equityUsd: null, exposureBaseUnits: p.costBasisBaseUnits, cohortExposure: {}, clusterExposure: {}, sleeveExposure: null, assetEligibilityEvaluationId: null,
    computedMaxLossBaseUnits: null, computedPositionAmount: requested, maxSlippageBps: deps.policy.maxSlippageBps, maxPriceImpactBps: deps.policy.maxImpactBps, stopPolicy: p.stop, targetPolicy: p.target,
    dailyDrawdownFraction: 0, circuitBreakerTripped: false, staleDataChecks: [], createdAt: now,
  };
  await deps.repo.recordExitDecision(cycle, proposal, review, evaluation);

  const intent: TradeIntent = {
    id: randomUUID() as Uuid,
    idempotencyKey: `exit:${p.id}:${cycle.id}` as TradeIntent['idempotencyKey'],
    accountId: p.accountId,
    strategyVersionId,
    sleeveId: p.lots[0]?.sleeveId ?? null,
    assetId: p.assetId,
    action: action === 'EXIT' ? 'EXIT' : 'REDUCE',
    side: 'SELL',
    exposureEffect: 'REDUCE',
    inputMint: p.mint,
    outputMint: deps.account.settlementMint,
    maxInputAmount: requested,
    riskEvaluationId: evaluation.id,
    actionCycleId: cycle.id,
    clearedCutoffVersion: 1,
    // Exits accept the policy's impact cap plus the measured impact at this size: a mandatory exit is not refused for being large.
    constraints: { maxSlippageBps: deps.policy.maxSlippageBps, maxPriceImpactBps: Math.max(deps.policy.maxImpactBps, impactBps ?? 0) as Bps, chaseToleranceBps: 10_000 as Bps, maxQuoteAgeMs: deps.policy.maxQuoteAgeMs },
    protectionPolicyRef: null,
    targetLotIds: allocations.map((a) => a.lotId),
    approvalRequired: false,
    createdAt: now,
    expiresAt,
  };
  await deps.repo.createIntent(intent, 'AUTHORIZED');
  await deps.repo.setIntentState(intent.id, 'EXECUTING');
  const exec = await deps.adapter.executeDetailed({ intent, capitalAuthority: 'PAPER', authorization: null, approvalHash: null, executionPath: 'JUPITER_ORDER', requestedAt: now });
  const fill = exec.fill ? { ...exec.fill, lotAllocations: allocations } : null;
  await deps.repo.finishAttempt(exec.order, exec.attempt, fill);
  if (!fill) {
    const rejection = exec.result.rejectionReasons[0] ?? 'UNKNOWN';
    await deps.repo.setIntentState(intent.id, rejection === 'INTENT_EXPIRED' ? 'EXPIRED' : exec.attempt.state === 'NOT_LANDED' ? 'FAILED' : 'CANCELLED');
    deps.logger.warn('position_exit_not_filled', { positionId: p.id, asset: p.symbol, action, reason, rejection, attemptState: exec.attempt.state });
    return 'NOT_FILLED';
  }
  // Lot accounting: proceeds and released cost pro rata to the quantity each lot gave up.
  const totalOut = amountToBigInt(fill.outputAmount);
  const totalQty = amountToBigInt(fill.inputAmount);
  const lots: ExitApplication['lots'] = allocations.map((a) => {
    const lot = p.lots.find((l) => l.id === a.lotId)!;
    const q = amountToBigInt(a.quantity);
    const proceeds = (totalOut * q) / totalQty;
    const costReleased = (amountToBigInt(lot.costBasisBaseUnits) * q) / amountToBigInt(lot.quantity);
    return { lotId: a.lotId, sleeveId: lot.sleeveId, quantity: a.quantity, costReleased: bigIntToAmount(costReleased), realizedPnl: (proceeds - costReleased).toString() as SignedAmount };
  });
  const closes = action === 'EXIT' || totalQty >= amountToBigInt(p.quantity);
  await deps.repo.applyExit({ positionId: p.id, intentId: intent.id, fill, lots, closesPosition: closes, closedAt: fill.filledAt });
  deps.logger.info('position_exit_filled', { positionId: p.id, asset: p.symbol, action, reason, quantity: fill.inputAmount, proceeds: fill.outputAmount, realizedPnl: lots.reduce((acc, l) => acc + BigInt(l.realizedPnl), 0n).toString(), closed: closes, txSignature: fill.txSignature });
  return 'FILLED';
}

function snapshotOf(deps: PositionMonitorDeps, book: PaperBook, now: Instant): PortfolioSnapshot {
  const equity = amountToBigInt(book.settlementBalance) + amountToBigInt(book.markValue);
  const eq = Number(equity);
  const fraction = (from: Amount | null): number => (from && amountToBigInt(from) > 0n ? Math.max(0, Number(amountToBigInt(from) - equity) / Number(amountToBigInt(from))) : 0);
  return {
    id: randomUUID() as Uuid,
    accountId: deps.account.id,
    asOf: now,
    settlementMint: deps.account.settlementMint,
    equityBaseUnits: bigIntToAmount(equity),
    equityUsd: null,
    exposureBaseUnits: book.markValue,
    exposureFraction: eq > 0 ? Math.min(1, Number(amountToBigInt(book.markValue)) / eq) : 0,
    perSleeve: book.sleeves.map((s) => ({ sleeveId: s.id, committedBaseUnits: s.committedBaseUnits, pnlBaseUnits: (book.realizedBySleeve[s.id] ?? '0') as SignedAmount })),
    perCohort: [],
    drawdown: { dailyFraction: fraction(book.dayStartEquity), rollingFraction: fraction(book.rollingHighEquity) },
    createdAt: now,
  };
}
