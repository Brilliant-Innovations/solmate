import { randomUUID } from 'node:crypto';
import { addAmounts, addMs, amountToBigInt, compareAmounts, instantToMs, subAmounts, type Amount, type Bps, type Clock, type ExecutionRequest, type Fill, type Instant, type MintAddress, type Order, type OrderAttempt, type PortfolioSnapshot, type Position, type PositionLot, type RiskEvaluation, type RiskPolicy, type StrategySleeve, type StrategyVersion, type TradeIntent, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { EntryCandidateRow, PaperBook, TradeIntentState } from '@sol-agent-trader/db/server';
import { impliedPrice, type DetailedExecution } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';
import { evaluateEntry, type PortfolioState } from '@sol-agent-trader/risk';

/**
 * Worker role `paper-entry` (blueprint §13, §17, §6.11–6.20; execution plan M5a "first paper
 * trade"). For every CLEARED S0 cycle without a risk evaluation: build the portfolio state from
 * the paper book (pending exposure counted as spent, P1), run the deterministic risk core, record
 * the immutable evaluation, and when allowed create the intent and hand it to the paper adapter.
 * A fill opens the position and its sleeve lot; a refusal leaves the evaluation as the record.
 * Every cleared cycle is evaluated exactly once, allowed or not, so the ledger explains itself.
 *
 * Paper authority: the risk evaluation is the authorization. Live needs the signed envelope and
 * the isolated authorizer (M7); this role never runs under a live capital authority.
 */

export interface PaperEntryRepo {
  listAwaiting(strategyVersionIds: VersionId[], limit: number): Promise<EntryCandidateRow[]>;
  book(now: Instant): Promise<PaperBook>;
  health(): Promise<{ feedsBlockEntries: boolean; entriesPaused: boolean; sessionAllowsEntries: boolean }>;
  recordRiskEvaluation(e: RiskEvaluation): Promise<void>;
  createIntent(intent: TradeIntent, lifecycle: 'AUTHORIZED'): Promise<void>;
  setIntentState(intentId: Uuid, state: TradeIntentState): Promise<void>;
  finishAttempt(order: Order, attempt: OrderAttempt, fill: Fill | null): Promise<void>;
  openPosition(position: Position, lot: PositionLot): Promise<void>;
  writeSnapshot(snapshot: PortfolioSnapshot): Promise<void>;
}

export interface PaperExecutor {
  executeDetailed(request: ExecutionRequest): Promise<DetailedExecution>;
}

export interface PaperEntryDeps {
  repo: PaperEntryRepo;
  adapter: PaperExecutor;
  /** Reference quote for impact and price at the policy's maximum position size, taken at evaluation time. */
  referenceQuote: (inputMint: MintAddress, outputMint: MintAddress, inputAmount: Amount, maxSlippageBps: Bps, now: Instant) => Promise<{ impactBps: Bps | null; expectedOutputAmount: Amount; slippageBps: Bps; quotedAt: Instant } | null>;
  clock: Clock;
  logger: Logger;
  account: { id: Uuid; settlementMint: MintAddress; settlementDecimals: number; startingCapital: Amount; virtualSolLamports: Amount };
  strategies: Record<VersionId, StrategyVersion>;
  sleeves: Record<VersionId, StrategySleeve>;
  policy: RiskPolicy;
  config: { batchSize: number; featureMaxAgeMs: number };
}

export interface PaperEntryReport {
  scanned: number;
  allowed: number;
  refused: number;
  filled: number;
  notFilled: number;
  refusalsByCode: Record<string, number>;
  errors: { cycleId: Uuid; error: string }[];
}

export async function runPaperEntryCycle(deps: PaperEntryDeps): Promise<PaperEntryReport> {
  const now = deps.clock.now();
  const report: PaperEntryReport = { scanned: 0, allowed: 0, refused: 0, filled: 0, notFilled: 0, refusalsByCode: {}, errors: [] };
  const versionIds = Object.keys(deps.strategies) as VersionId[];
  const awaiting = await deps.repo.listAwaiting(versionIds, deps.config.batchSize);
  report.scanned = awaiting.length;

  for (const row of awaiting) {
    try {
      // Fresh book per cycle: the previous fill in this loop is already pending or committed exposure.
      const [book, health] = await Promise.all([deps.repo.book(now), deps.repo.health()]);
      const strategy = deps.strategies[row.cycle.strategyVersionId];
      const sleeve = deps.sleeves[row.cycle.strategyVersionId];
      if (!strategy || !sleeve) throw new Error(`no strategy/sleeve for ${row.cycle.strategyVersionId}`);
      const state = portfolioState(deps, book, health, sleeve, row.asset.id);
      const f = row.snapshot.features;
      const num = (n: string) => (typeof f[n] === 'number' ? (f[n] as number) : null);
      const referenceSize = minAmount(deps.policy.maxPositionValueBaseUnits, book.settlementBalance);
      const ref = amountToBigInt(referenceSize) > 0n ? await deps.referenceQuote(deps.account.settlementMint, row.asset.mint, referenceSize, deps.policy.maxSlippageBps, now) : null;
      const priceNow = ref ? impliedPrice(referenceSize, deps.account.settlementDecimals, ref.expectedOutputAmount, row.asset.decimals) : null;
      const proposalPrice = num('price_usd') ?? priceNow ?? 0;
      const evaluationId = randomUUID() as Uuid;
      const evaluation = evaluateEntry(
        deps.policy,
        state,
        {
          id: evaluationId,
          proposalId: row.proposal.id,
          actionCycleId: row.cycle.id,
          assetId: row.asset.id,
          eligibility: row.eligibility ? { allowed: true } : { allowed: false, reason: 'NO_ELIGIBILITY_RECORD' },
          eligibilityEvaluationId: row.eligibility?.id ?? null,
          proposalExpiresAt: row.proposal.expiresAt,
          proposalPriceUsd: proposalPrice,
          quote: ref && priceNow !== null ? { ageMs: instantToMs(now) - instantToMs(ref.quotedAt), impactBps: ref.impactBps, slippageBps: ref.slippageBps, priceUsd: priceNow } : null,
          // A plain SPL token is always compatible; Token-2022 or an undetermined program needs the confirmed settlement route from eligibility.
          token2022Compatible: row.asset.tokenProgram === 'TOKEN' || (row.eligibility?.settlementRouteConfirmed ?? false),
          duplicateIntent: false,
          liquidityUsd: num('liquidity_usd') ?? row.eligibility?.liquidityUsd ?? null,
          atrPct: num('atr_14_pct'),
          structureLowPriceUsd: null,
          expectedRewardFraction: null,
        },
        now,
      );
      await deps.repo.recordRiskEvaluation(evaluation.record);
      if (!evaluation.record.allowed) {
        report.refused++;
        for (const code of evaluation.record.reasonCodes) report.refusalsByCode[code] = (report.refusalsByCode[code] ?? 0) + 1;
        deps.logger.info('paper_entry_refused', { cycleId: row.cycle.id, asset: row.asset.symbol, reasons: evaluation.record.reasonCodes, binding: evaluation.sizing?.binding ?? null });
        continue;
      }
      report.allowed++;

      const intent: TradeIntent = {
        id: randomUUID() as Uuid,
        idempotencyKey: `entry:${row.cycle.id}` as TradeIntent['idempotencyKey'],
        accountId: deps.account.id,
        strategyVersionId: row.cycle.strategyVersionId,
        sleeveId: sleeve.id,
        assetId: row.asset.id,
        action: 'ENTER',
        side: 'BUY',
        exposureEffect: 'INCREASE',
        inputMint: deps.account.settlementMint,
        outputMint: row.asset.mint,
        maxInputAmount: evaluation.record.computedPositionAmount as Amount,
        riskEvaluationId: evaluationId,
        actionCycleId: row.cycle.id,
        clearedCutoffVersion: row.cycle.clearedCutoffVersion,
        constraints: { maxSlippageBps: deps.policy.maxSlippageBps, maxPriceImpactBps: deps.policy.maxImpactBps, chaseToleranceBps: deps.policy.chaseToleranceBps, maxQuoteAgeMs: deps.policy.maxQuoteAgeMs },
        protectionPolicyRef: null,
        targetLotIds: [],
        approvalRequired: false,
        createdAt: now,
        expiresAt: minInstant(row.proposal.expiresAt, addMs(now, strategy.liveIntentExpiryMs)),
      };
      await deps.repo.createIntent(intent, 'AUTHORIZED');
      await deps.repo.setIntentState(intent.id, 'EXECUTING');
      const exec = await deps.adapter.executeDetailed({ intent, capitalAuthority: 'PAPER', authorization: null, approvalHash: null, executionPath: 'JUPITER_ORDER', requestedAt: now });
      await deps.repo.finishAttempt(exec.order, exec.attempt, exec.fill);

      if (exec.fill) {
        const positionId = randomUUID() as Uuid;
        const stop = evaluation.record.stopPolicy;
        const entryPrice = impliedPrice(exec.fill.inputAmount, deps.account.settlementDecimals, exec.fill.outputAmount, row.asset.decimals);
        const stopLevel = stop && entryPrice !== null ? entryPrice * (1 - stop.distanceFraction) : null;
        const position: Position = {
          id: positionId,
          accountId: deps.account.id,
          assetId: row.asset.id,
          mint: row.asset.mint,
          quantity: exec.fill.outputAmount,
          averageEntryPrice: entryPrice,
          costBasisBaseUnits: exec.fill.inputAmount,
          realizedPnlBaseUnits: '0' as never,
          unrealizedPnlBaseUnits: null,
          stop: stop ? { model: stop.model, level: stopLevel, distanceFraction: stop.distanceFraction } : null,
          target: evaluation.record.targetPolicy,
          unreviewedStop: stopLevel,
          custodySplit: [],
          status: 'OPEN',
          reviewState: 'REVIEWED',
          reviewStateReason: null,
          reviewStateSince: now,
          lastReviewedCycleId: row.cycle.id,
          nextReassessmentAt: addMs(now, 60_000),
          safetyState: 'NORMAL',
          lotIds: [],
          openedAt: exec.fill.filledAt,
          closedAt: null,
        };
        const lot: PositionLot = {
          id: randomUUID() as Uuid,
          positionId,
          sleeveId: sleeve.id,
          strategyVersionId: row.cycle.strategyVersionId,
          assetId: row.asset.id,
          mint: row.asset.mint,
          quantity: exec.fill.outputAmount,
          costBasisBaseUnits: exec.fill.inputAmount,
          entryIntentId: intent.id,
          entryFillIds: [exec.fill.id],
          exitFillIds: [],
          realizedPnlBaseUnits: '0' as never,
          protectionMode: 'MONITORED_EXIT',
          providerOrderId: null,
          reservedForProtection: '0' as Amount,
          status: 'OPEN',
          openedAt: exec.fill.filledAt,
          closedAt: null,
        };
        await deps.repo.openPosition(position, lot);
        await deps.repo.setIntentState(intent.id, 'COMPLETED');
        report.filled++;
        deps.logger.info('paper_entry_filled', { cycleId: row.cycle.id, asset: row.asset.symbol, strategy: row.cycle.strategyVersionId, intentId: intent.id, positionId, input: exec.fill.inputAmount, output: exec.fill.outputAmount, entryPrice, stop: stopLevel, shortfallBps: exec.fill.executionShortfallBps, txSignature: exec.fill.txSignature });
      } else {
        const reason = exec.result.rejectionReasons[0] ?? 'UNKNOWN';
        await deps.repo.setIntentState(intent.id, reason === 'INTENT_EXPIRED' ? 'EXPIRED' : exec.attempt.state === 'NOT_LANDED' ? 'FAILED' : 'CANCELLED');
        report.notFilled++;
        deps.logger.warn('paper_entry_not_filled', { cycleId: row.cycle.id, asset: row.asset.symbol, intentId: intent.id, reason, attemptState: exec.attempt.state });
      }
    } catch (err) {
      report.errors.push({ cycleId: row.cycle.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    const book = await deps.repo.book(now);
    await deps.repo.writeSnapshot(snapshotOf(deps, book, now));
  } catch (err) {
    report.errors.push({ cycleId: '00000000-0000-4000-8000-000000000000' as Uuid, error: `snapshot: ${err instanceof Error ? err.message : String(err)}` });
  }
  deps.logger.info('paper_entry_cycle', { scanned: report.scanned, allowed: report.allowed, refused: report.refused, filled: report.filled, notFilled: report.notFilled, refusalsByCode: report.refusalsByCode, errors: report.errors.length, policy: deps.policy.version });
  for (const e of report.errors) deps.logger.warn('paper_entry_failed', { cycleId: e.cycleId, error: e.error });
  return report;
}

/** Paper equity: settlement balance plus open positions at their last executable mark (cost until the monitor marks them). */
export function equityOf(book: PaperBook): Amount {
  return addAmounts(book.settlementBalance, book.markValue);
}

function portfolioState(deps: PaperEntryDeps, book: PaperBook, health: { feedsBlockEntries: boolean; entriesPaused: boolean; sessionAllowsEntries: boolean }, sleeve: StrategySleeve, assetId: Uuid): PortfolioState {
  const equity = equityOf(book);
  const assetExposure = book.openPositions.filter((p) => p.assetId === assetId).reduce((acc, p) => addAmounts(acc, p.costBasis), '0' as Amount);
  const gas = compareAmounts(deps.account.virtualSolLamports, book.feesLamports) > 0 ? subAmounts(deps.account.virtualSolLamports, book.feesLamports) : ('0' as Amount);
  const fraction = (from: Amount | null): number => (from && amountToBigInt(from) > 0n ? Math.max(0, Number(amountToBigInt(from) - amountToBigInt(equity)) / Number(amountToBigInt(from))) : 0);
  return {
    settlementMint: deps.account.settlementMint,
    settlementDecimals: deps.account.settlementDecimals,
    equityBaseUnits: equity,
    exposureBaseUnits: book.markValue,
    pendingExposureBaseUnits: book.pendingExposure,
    inFlightExposureIncreasing: book.inFlightIncreasing,
    openPositions: book.openPositions.length,
    assetExposureBaseUnits: assetExposure,
    settlementAvailableBaseUnits: book.settlementBalance,
    gasReserveLamports: gas,
    sleeve: {
      id: sleeve.id,
      active: sleeve.active,
      capRemainingBaseUnits: compareAmounts(sleeve.capitalCapBaseUnits, sleeve.committedBaseUnits) > 0 ? subAmounts(sleeve.capitalCapBaseUnits, sleeve.committedBaseUnits) : ('0' as Amount),
      riskRemainingBaseUnits: compareAmounts(sleeve.riskBudgetBaseUnits, sleeve.riskUsedBaseUnits) > 0 ? subAmounts(sleeve.riskBudgetBaseUnits, sleeve.riskUsedBaseUnits) : ('0' as Amount),
    },
    cohort: null,
    cluster: null,
    drawdown: { dailyFraction: fraction(book.dayStartEquity), rollingFraction: fraction(book.rollingHighEquity), consecutiveLosses: book.consecutiveLosses, circuitBreakerTripped: false, breakerTrippedAt: null },
    health: {
      feedsBlockEntries: health.feedsBlockEntries,
      staleDataClasses: [],
      reconciliationClean: !health.entriesPaused,
      dbAvailable: true,
      executionAnomalies: 0,
      providerAuthFailure: false,
      clockDriftMs: 0,
      operatorKill: health.entriesPaused,
      sessionAllowsEntries: health.sessionAllowsEntries,
    },
  };
}

function snapshotOf(deps: PaperEntryDeps, book: PaperBook, now: Instant): PortfolioSnapshot {
  const equity = equityOf(book);
  const eq = Number(amountToBigInt(equity));
  const fraction = (from: Amount | null): number => (from && amountToBigInt(from) > 0n ? Math.max(0, Number(amountToBigInt(from) - amountToBigInt(equity)) / Number(amountToBigInt(from))) : 0);
  return {
    id: randomUUID() as Uuid,
    accountId: deps.account.id,
    asOf: now,
    settlementMint: deps.account.settlementMint,
    equityBaseUnits: equity,
    equityUsd: null,
    exposureBaseUnits: book.markValue,
    exposureFraction: eq > 0 ? Math.min(1, Number(amountToBigInt(book.markValue)) / eq) : 0,
    perSleeve: book.sleeves.map((s) => ({ sleeveId: s.id, committedBaseUnits: s.committedBaseUnits, pnlBaseUnits: (book.realizedBySleeve[s.id] ?? '0') as never })),
    perCohort: [],
    drawdown: { dailyFraction: fraction(book.dayStartEquity), rollingFraction: fraction(book.rollingHighEquity) },
    createdAt: now,
  };
}

function minAmount(a: Amount, b: Amount): Amount {
  return compareAmounts(a, b) <= 0 ? a : b;
}
function minInstant(a: Instant, b: Instant): Instant {
  return instantToMs(a) <= instantToMs(b) ? a : b;
}
