import { addMs, amountToBigInt, bigIntToAmount, compareAmounts, instantToMs, mulDiv, subAmounts, type Amount, type AssetEligibility, type Candidate, type Candle, type ExecutionRequest, type FeatureSnapshot, type Instant, type ReplayDecision, type ReplayVariant, type RiskPolicy, type SolanaAddress, type TradeIntent, type Uuid } from '@sol-agent-trader/contracts';
import { impliedPrice, PaperExecutionAdapter, type DetailedExecution } from '@sol-agent-trader/execution';
import { assertReadable, disciplineFor, guardedRows, observationLagReport, sampleOf, seededRandom, SimulatedClock, ticks, type GuardContext } from '@sol-agent-trader/replay';
import { entryAllowed, evaluateEntry, evaluateExitPolicy } from '@sol-agent-trader/risk';
import { classifyRegime, computeFeatures, detectMomentumCandidate, marketSessionsAt, relativeStrength, type UniverseAsset } from '@sol-agent-trader/signals';
import { closePosition, equityOf, markPosition, newBook, openPosition, portfolioStateOf, rollDay, type ReplayBook, type ReplayPosition } from './book.js';
import { idFrom, NoRouteError, ReplayQuoteSource, unitsIn } from './quotes.js';
import type { DetectFn, ReplayAsset, ReplayEngineDeps, ReplayOutput, ReplayStrategy, ReplayStrategyResult, ReplayTrade, StrategyVerdict } from './types.js';

/**
 * Replay engine (blueprint §18, P9; execution plan M10). Drives the same pure pipeline the live
 * worker runs — feature engine → deterministic trigger → strategy decision → risk core → paper
 * adapter → exit policy — over a frozen dataset under a simulated clock. Every read passes the
 * look-ahead guard, every strategy sees the same candidates, and each strategy trades from its own
 * book with identical starting capital, so the results are one timeline, many strategies.
 *
 * Latency is modelled, not waited for: a strategy's verdict names its decision moment, the engine
 * queues the entry until the clock reaches it, and the paper adapter takes the executable quote
 * the modelled submission delay later. Random draws (execution failure) come from the run seed.
 */

const REPLAY_TAKER = 'Rep1ayTaker11111111111111111111111111111111' as SolanaAddress;
const MINUTE = 60_000;

interface Stream {
  key: string;
  strategy: ReplayStrategy;
  variant: ReplayVariant;
  book: ReplayBook;
  decisions: ReplayDecision[];
  trades: ReplayTrade[];
  rejections: Record<string, number>;
  fills: number;
  /** Position bookkeeping the ledger keeps in lots: proceeds and fees to date for the outcome row. */
  ledger: Map<Uuid, PositionLedger>;
}

interface PositionLedger {
  decisionIndex: number;
  candidate: Candidate;
  snapshot: FeatureSnapshot;
  proceeds: bigint;
  feesSettlement: bigint;
  /** SOL-denominated network and priority fees charged to this position, in lamports (§18.4, M-14). */
  feesLamports: bigint;
  slippageSettlement: bigint;
  entryShortfallBps: number | null;
  decisionToFillMs: number | null;
  horizonMark: Amount | null;
  exitReason: string;
  quantityClosed: bigint;
  quantityOpened: bigint;
  /**
   * Cost basis at entry, kept verbatim. Reconstructing it from the remaining basis and quantity
   * drifts once a partial reduction floors its share (review 2026-09-09, E1).
   */
  costBasisOpened: bigint;
  /** First moment the position could not be quoted, cleared as soon as a quote returns (H-8). */
  unquotableSince: Instant | null;
}

interface PendingEntry {
  stream: Stream;
  candidate: Candidate;
  snapshot: FeatureSnapshot;
  verdict: StrategyVerdict;
  decidedAt: Instant;
  decisionIndex: number;
}

export async function runReplay(deps: ReplayEngineDeps): Promise<ReplayOutput> {
  const { run, dataset, policies, account } = deps;
  const cost = policies.costModel;
  const tickMs = deps.tickMs ?? MINUTE;
  const clock = new SimulatedClock(run.window.from);
  // §18.1: a Level B run may read a row only from the moment it was actually observed; a Level A
  // run reconstructs from source time and says so. Comparing observation time against the dataset
  // cutoff alone could never bind, which is what made the Level B label empty (review 2026-09-09, H-1).
  const observationDiscipline = disciplineFor(run.fidelity);
  const guard: GuardContext = { clock, datasetCutoff: run.window.datasetCutoff, observationDiscipline };
  // The paper adapter takes the executable quote submissionDelayMs after the decision by design (§17.1); the quote
  // source's horizon is the clock plus that modelled delay, clamped to the dataset cutoff. The clamp
  // matters at the window boundary: a window-end exit is decided at `window.to`, and without it the
  // modelled submission delay would push the quote past the cutoff and abort the run rather than
  // charge the exit (review 2026-09-09, M-13). Strategies never read through this context.
  // The exit decided at `window.to` quotes one submission delay later, so the quote path's cutoff is
  // the run cutoff extended by exactly that modelled delay. In production the role sets the cutoff to
  // request time, far beyond the window end, so this changes nothing; it only keeps a window-end exit
  // from aborting the run instead of being charged. The dataset itself is still filtered at the true
  // cutoff, so no later observation becomes readable.
  const quoteCutoff = addMs(run.window.datasetCutoff, instantToMs(run.window.datasetCutoff) < instantToMs(run.window.to) + cost.fill.submissionDelayMs ? cost.fill.submissionDelayMs : 0);
  const quoteGuard: GuardContext = { clock: { now: () => addMs(clock.now(), cost.fill.submissionDelayMs), nowMs: () => clock.nowMs() + cost.fill.submissionDelayMs }, datasetCutoff: quoteCutoff, observationDiscipline };
  let counter = 0;
  const newId = () => idFrom(`${run.id}:${run.seed}`, counter++);
  const quotes = new ReplayQuoteSource(dataset, quoteGuard, {
    fidelity: run.fidelity,
    settlementMint: account.settlementMint,
    settlementDecimals: account.settlementDecimals,
    maxProbeAgeMs: policies.risk.maxQuoteAgeMs * 10,
    defaultImpactBps: 50 as never,
    slippageBps: policies.risk.maxSlippageBps,
    candleAvailabilityLagMs: cost.candleAvailabilityLagMs,
  });
  const adapter = new PaperExecutionAdapter({ quotes, clock, policy: cost.fill, taker: REPLAY_TAKER, cluster: 'mainnet-beta', newId, wait: async () => undefined, journal: async () => undefined });
  const failureDraw = (key: string): boolean => cost.executionFailureRate > 0 && seededRandom(hash32(`${run.seed}:${key}`))() < cost.executionFailureRate;

  // --- streams: strategy × variant, each with its own book -----------------------------------------
  const nonBaselineLatency = Math.max(0, ...deps.strategies.filter((s) => s.version.versionId !== run.baselineStrategyVersionId).map((s) => s.version.maxDecisionLatencyMs));
  const latencyMatchedMs = deps.latencyMatchedMs ?? nonBaselineLatency;
  const streams: Stream[] = [];
  for (const strategy of deps.strategies) {
    const variants = new Set<ReplayVariant>(strategy.variants.filter((v) => v === 'FULL' || (v === 'PROPOSER_ONLY' && run.proposerOnlyShadow)));
    if (run.latencyMatchedBaseline && strategy.version.versionId === run.baselineStrategyVersionId && latencyMatchedMs > 0) variants.add('LATENCY_MATCHED');
    for (const variant of variants) {
      streams.push({ key: `${strategy.version.versionId}|${variant}`, strategy, variant, book: newBook(strategy.version.versionId, newId(), account.startingCapital as Amount, account.sleeveCap as Amount, account.sleeveRiskBudget as Amount), decisions: [], trades: [], rejections: {}, fills: 0, ledger: new Map() });
    }
  }

  // --- dataset views ---------------------------------------------------------------------------------
  const lookback = Math.max(...Object.values(policies.featureSpec.lookbackBuckets)) + 2;
  const cutoffMs = instantToMs(run.window.datasetCutoff);
  const candlesByAsset = new Map<Uuid, Candle[]>();
  for (const a of dataset.assets) candlesByAsset.set(a.id, (dataset.candles.get(a.id) ?? []).filter((c) => c.resolution === '1m' && instantToMs(c.observedAt) <= cutoffMs).sort((x, y) => instantToMs(x.bucketTime) - instantToMs(y.bucketTime)));
  /**
   * When a candle becomes readable. Source time is bucket close plus the availability lag; under
   * `OBSERVED_TIME` a backfilled candle is additionally unreadable until it was observed, which is
   * what separates a captured-market run from a reconstruction. The two orderings differ — a late
   * backfill arrives out of bucket order — so the cursor walks availability order while the window
   * the feature engine reads stays in bucket order.
   */
  const availableAtMs = (c: Candle): number => {
    const source = instantToMs(c.bucketTime) + MINUTE + cost.candleAvailabilityLagMs;
    return observationDiscipline === 'OBSERVED_TIME' ? Math.max(source, instantToMs(c.observedAt)) : source;
  };
  const byAvailability = new Map<Uuid, Candle[]>();
  for (const [id, all] of candlesByAsset) byAvailability.set(id, [...all].sort((x, y) => availableAtMs(x) - availableAtMs(y)));
  const availabilityCursor = new Map<Uuid, number>();
  // Only the newest `lookback` buckets ever reach a feature vector, so the visible window is bounded;
  // a backfill older than the whole window is genuinely too old to change any feature.
  const WINDOW_CAP = lookback + 8;
  const visibleWindow = new Map<Uuid, Candle[]>();
  const visibleCandles = (asset: ReplayAsset, until: Instant): Candle[] => {
    assertReadable('candles', until, guard);
    const all = byAvailability.get(asset.id) ?? [];
    const window = visibleWindow.get(asset.id) ?? [];
    let i = availabilityCursor.get(asset.id) ?? 0;
    const untilMs = instantToMs(until);
    while (i < all.length && availableAtMs(all[i]!) <= untilMs) {
      const c = all[i]!;
      const at = instantToMs(c.bucketTime);
      let lo = 0;
      let hi = window.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (instantToMs(window[mid]!.bucketTime) <= at) lo = mid + 1;
        else hi = mid;
      }
      window.splice(lo, 0, c);
      i++;
    }
    if (window.length > WINDOW_CAP) window.splice(0, window.length - WINDOW_CAP);
    availabilityCursor.set(asset.id, i);
    visibleWindow.set(asset.id, window);
    return window;
  };
  const latestEligibility = (asset: ReplayAsset, at: Instant): AssetEligibility | null => {
    const rows = guardedRows('eligibility', (dataset.eligibility.get(asset.id) ?? []).map((e) => ({ ...e, firstSeenAt: e.evaluatedAt })), at, guard);
    return rows.length ? rows.reduce((b, e) => (instantToMs(e.evaluatedAt) > instantToMs(b.evaluatedAt) ? e : b)) : null;
  };
  const detect: DetectFn = deps.detect ?? ((input) => {
    const d = detectMomentumCandidate({ ...input, selfInfluence: { isOwned: () => false, ownSignatures: new Set(), windows: [], now: input.now } });
    return d.kind === 'SKIP' ? { kind: 'SKIP', reason: d.reason } : d.kind === 'CANDIDATE' ? { kind: 'CANDIDATE', candidate: d.candidate } : { kind: 'REJECTED', candidate: d.candidate };
  });

  // --- candidate state --------------------------------------------------------------------------------
  const openCandidates = new Map<Uuid, Candidate[]>();
  const lastTerminalAt = new Map<Uuid, Instant | null>();
  let candidateCount = 0;
  const pending: PendingEntry[] = [];
  let tickCount = 0;
  let lastDay = Math.floor(instantToMs(run.window.from) / 86_400_000);

  const drain = async (until: Instant): Promise<void> => {
    pending.sort((a, b) => instantToMs(a.decidedAt) - instantToMs(b.decidedAt));
    while (pending.length && instantToMs(pending[0]!.decidedAt) <= instantToMs(until)) {
      const item = pending.shift()!;
      clock.advanceTo(item.decidedAt);
      await executeEntry(item);
    }
  };

  const recordDecision = (stream: Stream, candidate: Candidate, verdict: StrategyVerdict, decidedAt: Instant): number => {
    const row: ReplayDecision = {
      id: newId(),
      runId: run.id,
      strategyVersionId: stream.strategy.version.versionId,
      variant: stream.variant,
      at: candidate.discoveredAt,
      candidateId: candidate.id,
      assetId: candidate.assetId,
      sample: sampleOf(run.window, candidate.discoveredAt),
      cycleState: verdict.cycleState,
      action: verdict.action,
      proposerConfidence: verdict.proposerConfidence,
      adversaryVerdict: verdict.adversaryVerdict,
      reasonCodes: verdict.reasonCodes,
      decisionLatencyMs: Math.max(0, instantToMs(decidedAt) - instantToMs(candidate.discoveredAt)),
      rejection: null,
      fill: null,
      outcome: null,
    };
    stream.decisions.push(row);
    return stream.decisions.length - 1;
  };

  const reject = (stream: Stream, index: number, reason: string): void => {
    stream.decisions[index] = { ...stream.decisions[index]!, rejection: reason };
    stream.rejections[reason] = (stream.rejections[reason] ?? 0) + 1;
  };

  async function executeEntry(item: PendingEntry): Promise<void> {
    const { stream, candidate, snapshot, verdict } = item;
    const asset = dataset.assets.find((a) => a.id === candidate.assetId)!;
    const now = clock.now();
    const book = stream.book;
    const state = portfolioStateOf(book, asset.id, dataset.memberships, { settlementMint: account.settlementMint, settlementDecimals: account.settlementDecimals, virtualSolLamports: account.virtualSolLamports as Amount });
    const referenceSize = compareAmounts(policies.risk.maxPositionValueBaseUnits, book.settlementBalance) <= 0 ? policies.risk.maxPositionValueBaseUnits : book.settlementBalance;
    const ref = amountToBigInt(referenceSize) > 0n ? await tryQuote(referenceSize, account.settlementMint, asset.mint, now) : null;
    const priceNow = ref ? impliedPrice(referenceSize, account.settlementDecimals, ref.expectedOutputAmount, asset.decimals) : null;
    const f = snapshot.features;
    const num = (n: string) => (typeof f[n] === 'number' ? (f[n] as number) : null);
    const record = latestEligibility(asset, now);
    const gate = entryAllowed(record, now, policies.eligibility);
    const evaluation = evaluateEntry(
      policies.risk,
      state,
      {
        id: newId(),
        proposalId: newId(),
        actionCycleId: newId(),
        assetId: asset.id,
        eligibility: gate,
        eligibilityEvaluationId: record?.id ?? null,
        proposalExpiresAt: verdict.expiresAt ?? addMs(candidate.discoveredAt, stream.strategy.version.maxCandidateAgeMs),
        proposalPriceUsd: priceNow ?? 0,
        quote: ref && priceNow !== null ? { ageMs: 0, impactBps: ref.priceImpactBps, slippageBps: ref.slippageBps, priceUsd: priceNow } : null,
        token2022Compatible: asset.tokenProgram === 'TOKEN' || (record?.settlementRouteConfirmed ?? false),
        duplicateIntent: false,
        liquidityUsd: num('liquidity_usd') ?? record?.liquidityUsd ?? null,
        atrPct: num('atr_14_pct'),
        structureLowPriceUsd: null,
        expectedRewardFraction: null,
      },
      now,
    );
    if (!evaluation.record.allowed) {
      reject(stream, item.decisionIndex, `RISK:${evaluation.record.reasonCodes[0] ?? 'REFUSED'}`);
      return;
    }
    const intent: TradeIntent = {
      id: newId(),
      idempotencyKey: `replay:${run.id}:${stream.key}:${candidate.id}` as TradeIntent['idempotencyKey'],
      accountId: run.id,
      strategyVersionId: stream.strategy.version.versionId,
      sleeveId: book.sleeve.id,
      assetId: asset.id,
      action: 'ENTER',
      side: 'BUY',
      exposureEffect: 'INCREASE',
      inputMint: account.settlementMint,
      outputMint: asset.mint,
      maxInputAmount: evaluation.record.computedPositionAmount as Amount,
      riskEvaluationId: evaluation.record.id,
      actionCycleId: evaluation.record.actionCycleId,
      clearedCutoffVersion: 1,
      constraints: { maxSlippageBps: policies.risk.maxSlippageBps, maxPriceImpactBps: policies.risk.maxImpactBps, chaseToleranceBps: policies.risk.chaseToleranceBps, maxQuoteAgeMs: policies.risk.maxQuoteAgeMs },
      protectionPolicyRef: null,
      targetLotIds: [],
      approvalRequired: false,
      createdAt: now,
      expiresAt: minInstant(verdict.expiresAt ?? addMs(now, stream.strategy.version.liveIntentExpiryMs), addMs(now, stream.strategy.version.liveIntentExpiryMs)),
    };
    const exec = await adapter.executeDetailed(request(intent, now));
    const lamports = exec.fill ? addLamports(exec.fill.fees.networkBaseUnits, exec.fill.fees.priorityBaseUnits) : exec.attempt.state === 'NOT_LANDED' ? addLamports(cost.fill.fees.networkLamports, cost.fill.fees.priorityLamports) : ('0' as Amount);
    if (!exec.fill) {
      book.feesLamports = bigIntToAmount(amountToBigInt(book.feesLamports) + amountToBigInt(lamports));
      reject(stream, item.decisionIndex, exec.result.rejectionReasons[0] ?? 'UNKNOWN');
      return;
    }
    if (failureDraw(`entry:${stream.key}:${candidate.id}`)) {
      book.feesLamports = bigIntToAmount(amountToBigInt(book.feesLamports) + amountToBigInt(lamports));
      reject(stream, item.decisionIndex, 'MODELLED_NOT_LANDED');
      return;
    }
    const entryPrice = impliedPrice(exec.fill.inputAmount, account.settlementDecimals, exec.fill.outputAmount, asset.decimals) ?? priceNow ?? 0;
    const stop = evaluation.record.stopPolicy;
    const stopLevel = stop ? entryPrice * (1 - stop.distanceFraction) : entryPrice * (1 - policies.risk.stop.maxStopFraction);
    const position: ReplayPosition = {
      id: newId(),
      candidateId: candidate.id,
      decisionId: stream.decisions[item.decisionIndex]!.id,
      assetId: asset.id,
      mint: asset.mint,
      decimals: asset.decimals,
      quantity: exec.fill.outputAmount,
      costBasisBaseUnits: exec.fill.inputAmount,
      averageEntryPrice: entryPrice,
      stop: stop ? { model: stop.model, level: stopLevel, distanceFraction: stop.distanceFraction } : null,
      target: evaluation.record.targetPolicy,
      currentStop: stopLevel,
      highSinceEntry: entryPrice,
      openedAt: exec.fill.filledAt,
      markValue: exec.fill.inputAmount,
      proposerConfidence: verdict.proposerConfidence,
    };
    openPosition(book, position, lamports);
    stream.fills++;
    const shortfall = exec.fill.executionShortfallBps;
    stream.decisions[item.decisionIndex] = {
      ...stream.decisions[item.decisionIndex]!,
      fill: { inputAmount: exec.fill.inputAmount, outputAmount: exec.fill.outputAmount, executionShortfallBps: shortfall, feesBaseUnits: exec.fill.fees.routerBaseUnits, executedAt: exec.fill.filledAt },
    };
    stream.ledger.set(position.id, {
      decisionIndex: item.decisionIndex,
      candidate,
      snapshot,
      proceeds: 0n,
      feesSettlement: amountToBigInt(exec.fill.fees.routerBaseUnits),
      feesLamports: amountToBigInt(lamports),
      slippageSettlement: shortfall !== null && shortfall > 0 ? (amountToBigInt(exec.fill.inputAmount) * BigInt(Math.round(shortfall))) / 10_000n : 0n,
      entryShortfallBps: shortfall,
      decisionToFillMs: instantToMs(exec.fill.filledAt) - instantToMs(now),
      horizonMark: null,
      exitReason: 'OPEN',
      quantityClosed: 0n,
      quantityOpened: amountToBigInt(exec.fill.outputAmount),
      costBasisOpened: amountToBigInt(exec.fill.inputAmount),
      unquotableSince: null,
    });
  }

  async function tryQuote(inputAmount: Amount, inputMint: string, outputMint: string, at: Instant) {
    try {
      return (await quotes.quote({ inputMint: inputMint as never, outputMint: outputMint as never, inputAmount, maxSlippageBps: policies.risk.maxSlippageBps, taker: REPLAY_TAKER, cluster: 'mainnet-beta', requestedAt: at })).quote;
    } catch (err) {
      if (err instanceof NoRouteError) return null;
      throw err;
    }
  }

  const request = (intent: TradeIntent, now: Instant): ExecutionRequest => ({ intent, capitalAuthority: 'PAPER', authorization: null, approvalHash: null, executionPath: cost.executionPath, requestedAt: now });

  /**
   * How long a position may stay unquotable before the run books it as unexitable. Live behaviour
   * is not to ignore it: `position-monitor` logs the missing route and held-asset safety escalates
   * NO_EXIT_PATH → UNABLE_TO_EXIT, a CRITICAL dead-man class. Skipping the position instead left
   * the single worst outcome the system exists to survive scoring as neither a loss nor a trade,
   * while equity carried it at its last pre-rug mark (review 2026-09-09, H-8).
   */
  const UNQUOTABLE_EXIT_AFTER_MS = 15 * MINUTE;

  async function managePositions(stream: Stream, now: Instant, forceReason: string | null): Promise<void> {
    for (const p of [...stream.book.positions]) {
      const led = stream.ledger.get(p.id)!;
      const quote = await tryQuote(p.quantity, p.mint, account.settlementMint, now);
      if (!quote) {
        led.unquotableSince ??= now;
        const strandedMs = instantToMs(now) - instantToMs(led.unquotableSince);
        if (forceReason !== null || strandedMs >= UNQUOTABLE_EXIT_AFTER_MS) {
          // Nothing can be sold, so nothing can be marked: the honest value is zero until a route
          // exists again, and the trade is booked as the total loss it is.
          markPosition(stream.book, p.id, '0' as Amount, p.averageEntryPrice);
          finishClose(stream, p, '0' as Amount, '0' as Amount, 0n, 'UNQUOTABLE', now, amountToBigInt(p.quantity));
        }
        continue;
      }
      led.unquotableSince = null;
      const price = impliedPrice(quote.expectedOutputAmount, account.settlementDecimals, p.quantity, p.decimals);
      markPosition(stream.book, p.id, quote.expectedOutputAmount, price ?? p.averageEntryPrice);
      if (led.horizonMark === null && instantToMs(now) - instantToMs(p.openedAt) >= run.calibrationTarget.horizonMs) led.horizonMark = quote.expectedOutputAmount;
      if (price === null || !(p.averageEntryPrice > 0)) continue;
      let action: 'HOLD' | 'TIGHTEN_STOP' | 'REDUCE' | 'EXIT';
      let fraction = 1;
      let reason: string;
      let stop = p.currentStop;
      if (forceReason) {
        action = 'EXIT';
        reason = forceReason;
      } else {
        const d = evaluateExitPolicy(takeProfitOf(p, policies.risk), { entryPrice: p.averageEntryPrice, currentPrice: price, highSinceEntry: p.highSinceEntry, currentStop: p.currentStop, initialStopDistanceFraction: p.stop?.distanceFraction ?? policies.risk.stop.maxStopFraction, openedAt: p.openedAt, now });
        action = d.action;
        stop = d.stop;
        reason = d.reasons[d.reasons.length - 1] ?? d.action;
        if (d.action === 'REDUCE') fraction = d.fraction;
      }
      if (action === 'HOLD') continue;
      if (action === 'TIGHTEN_STOP') {
        p.currentStop = Math.max(p.currentStop, stop);
        continue;
      }
      const requested = action === 'EXIT' ? p.quantity : mulDiv(p.quantity, BigInt(Math.round(fraction * 1_000_000)), 1_000_000n, 'FLOOR');
      if (amountToBigInt(requested) === 0n) continue;
      const intent: TradeIntent = {
        id: newId(),
        idempotencyKey: `replay:${run.id}:${stream.key}:${p.id}:${counter}` as TradeIntent['idempotencyKey'],
        accountId: run.id,
        strategyVersionId: stream.strategy.version.versionId,
        sleeveId: stream.book.sleeve.id,
        assetId: p.assetId,
        action,
        side: 'SELL',
        exposureEffect: 'REDUCE',
        inputMint: p.mint as never,
        outputMint: account.settlementMint,
        maxInputAmount: requested,
        riskEvaluationId: newId(),
        actionCycleId: newId(),
        clearedCutoffVersion: 1,
        constraints: { maxSlippageBps: policies.risk.maxSlippageBps, maxPriceImpactBps: 10_000 as never, chaseToleranceBps: 10_000 as never, maxQuoteAgeMs: policies.risk.maxQuoteAgeMs },
        protectionPolicyRef: null,
        targetLotIds: [],
        approvalRequired: false,
        createdAt: now,
        expiresAt: addMs(now, stream.strategy.version.liveIntentExpiryMs),
      };
      const exec: DetailedExecution = await adapter.executeDetailed(request(intent, now));
      const lamports = exec.fill ? addLamports(exec.fill.fees.networkBaseUnits, exec.fill.fees.priorityBaseUnits) : exec.attempt.state === 'NOT_LANDED' ? addLamports(cost.fill.fees.networkLamports, cost.fill.fees.priorityLamports) : ('0' as Amount);
      // A window-end close pays the same adverse allowance, fees and failure draw as any other
      // exit. Liquidating at the last mark for free biased every position open at window end
      // upward and made WINDOW_END a legitimate-looking exit-reason row (review 2026-09-09, M-13).
      if (!exec.fill || failureDraw(`exit:${stream.key}:${p.id}:${now}`)) {
        stream.book.feesLamports = bigIntToAmount(amountToBigInt(stream.book.feesLamports) + amountToBigInt(lamports));
        led.feesLamports += amountToBigInt(lamports);
        if (forceReason === 'WINDOW_END') {
          // The window ends with this attempt; there is no next tick to retry on. The position is
          // booked at the executable mark it could not actually reach, under its own exit reason.
          finishClose(stream, p, quote.expectedOutputAmount, '0' as Amount, 0n, 'WINDOW_END_UNFILLED', now, amountToBigInt(p.quantity));
        }
        continue; // stays open; the next tick tries again (a live position would still be protected by its stop)
      }
      const shortfall = exec.fill.executionShortfallBps;
      const routerSettlement = unitsIn(exec.fill.fees.routerBaseUnits, price, p.decimals, account.settlementDecimals, 0);
      const feesSettlement = amountToBigInt(routerSettlement) + amountToBigInt(exec.fill.fees.transferFeeBaseUnits);
      const slippage = shortfall !== null && shortfall > 0 ? (amountToBigInt(exec.fill.outputAmount) * BigInt(Math.round(shortfall))) / 10_000n : 0n;
      led.slippageSettlement += slippage;
      finishClose(stream, p, exec.fill.outputAmount, lamports, feesSettlement, reason, exec.fill.filledAt, amountToBigInt(exec.fill.inputAmount));
    }
  }

  function finishClose(stream: Stream, p: ReplayPosition, proceeds: Amount, lamports: Amount, feesSettlement: bigint, reason: string, at: Instant, quantitySold: bigint): void {
    const led = stream.ledger.get(p.id)!;
    led.proceeds += amountToBigInt(proceeds);
    led.feesSettlement += feesSettlement;
    led.feesLamports += amountToBigInt(lamports);
    led.quantityClosed += quantitySold;
    led.exitReason = reason;
    const remaining = amountToBigInt(p.quantity) - quantitySold;
    if (remaining > 0n) {
      // Partial reduction: cost basis leaves proportionally; the position stays open with the rest.
      const costOut = mulDiv(p.costBasisBaseUnits, quantitySold, amountToBigInt(p.quantity), 'FLOOR');
      stream.book.settlementBalance = bigIntToAmount(amountToBigInt(stream.book.settlementBalance) + amountToBigInt(proceeds));
      stream.book.feesLamports = bigIntToAmount(amountToBigInt(stream.book.feesLamports) + amountToBigInt(lamports));
      stream.book.realizedPnl += amountToBigInt(proceeds) - amountToBigInt(costOut);
      stream.book.sleeve.committed = compareAmounts(stream.book.sleeve.committed, costOut) > 0 ? subAmounts(stream.book.sleeve.committed, costOut) : ('0' as Amount);
      p.quantity = bigIntToAmount(remaining);
      p.costBasisBaseUnits = subAmounts(p.costBasisBaseUnits, costOut);
      p.markValue = mulDiv(p.markValue, remaining, remaining + quantitySold, 'FLOOR');
      return;
    }
    const totalCost = costBasisTotal(stream, p);
    closePosition(stream.book, p.id, proceeds, lamports);
    const realized = led.proceeds - totalCost;
    const decision = stream.decisions[led.decisionIndex]!;
    const holdMs = instantToMs(at) - instantToMs(p.openedAt);
    const targetHit = targetOf(run.calibrationTarget.kind, realized, reason, led, totalCost, holdMs, run.calibrationTarget.horizonMs);
    stream.decisions[led.decisionIndex] = { ...decision, outcome: { closedAt: at, realizedPnlBaseUnits: realized.toString(), holdMs, exitReason: reason, targetHit } };
    const scale = 10 ** account.settlementDecimals;
    const snap = led.snapshot;
    const num = (n: string) => (typeof snap.features[n] === 'number' ? (snap.features[n] as number) : null);
    stream.trades.push({
      id: p.id,
      variant: stream.variant,
      sample: sampleOf(run.window, led.candidate.discoveredAt),
      strategyVersionId: stream.strategy.version.versionId,
      assetId: p.assetId,
      candidateId: led.candidate.id,
      openedAt: p.openedAt,
      closedAt: at,
      cost: Number(totalCost) / scale,
      proceeds: Number(led.proceeds) / scale,
      fees: Number(led.feesSettlement) / scale,
      feesLamports: Number(led.feesLamports),
      slippageCost: Number(led.slippageSettlement) / scale,
      executionShortfallBps: led.entryShortfallBps,
      executionPath: cost.executionPath,
      exitReason: reason,
      decisionToFillMs: led.decisionToFillMs,
      attributes: {
        candidateFamily: led.candidate.triggerFamily,
        regime: snap.regime,
        sessions: snap.marketSessions,
        tokenAgeBand: null,
        liquidityBand: liquidityBand(num('liquidity_usd')),
        marketCapBand: null,
        relativeVolumeBand: relVolumeBand(num('rel_volume_60')),
        smartMoneyPresent: led.candidate.triggerFamily === 'SMART_MONEY_ACCUMULATION' ? true : null,
        newsCatalystPresent: led.candidate.triggerFamily === 'CATALYST_RESPONSE' ? true : null,
        socialAccelerationPresent: led.candidate.triggerFamily === 'SOCIAL_ACCELERATION' ? true : null,
        proposerConfidence: decision.proposerConfidence,
        adversaryVerdict: decision.adversaryVerdict,
      },
    });
    stream.ledger.delete(p.id);
  }

  function costBasisTotal(stream: Stream, p: ReplayPosition): bigint {
    // Recorded at entry, not reconstructed: rescaling the remaining basis by the remaining quantity
    // drifts once a partial reduction has floored its share of the cost (review 2026-09-09, E1).
    return stream.ledger.get(p.id)!.costBasisOpened;
  }

  // --- main loop ---------------------------------------------------------------------------------------
  for (const t of ticks(run.window.from, run.window.to, tickMs)) {
    await drain(t);
    clock.advanceTo(t);
    tickCount++;
    const day = Math.floor(instantToMs(t) / 86_400_000);
    if (day !== lastDay) {
      for (const s of streams) rollDay(s.book);
      lastDay = day;
    }
    for (const s of streams) await managePositions(s, t, null);

    // Expire candidates past their TTL (terminal for cooldown purposes).
    for (const [assetId, list] of openCandidates) {
      const keep: Candidate[] = [];
      for (const c of list) {
        if (instantToMs(c.expiresAt) <= instantToMs(t)) lastTerminalAt.set(assetId, c.expiresAt);
        else keep.push(c);
      }
      openCandidates.set(assetId, keep);
    }

    if (instantToMs(t) % MINUTE !== 0) continue;
    const asOf = t;
    const computed: { asset: ReplayAsset; snapshot: FeatureSnapshot; warm: boolean }[] = [];
    for (const asset of dataset.assets) {
      const candles = visibleCandles(asset, asOf);
      if (candles.length === 0) continue;
      const window = candles.slice(-lookback);
      const record = latestEligibility(asset, asOf);
      const { snapshot, warmup } = computeFeatures({
        id: newId(),
        assetId: asset.id,
        asOf,
        provenance: 'REPLAY',
        candles1m: window,
        overview: null,
        eligibility: record ? { liquidityUsd: record.liquidityUsd, priceImpactProbes: record.priceImpactProbes, settlementRouteConfirmed: record.settlementRouteConfirmed } : null,
        marketSnapshotId: null,
        marketSessions: marketSessionsAt(asOf),
        selfInfluenceSuppressed: false,
        spec: policies.featureSpec,
      });
      computed.push({ asset, snapshot, warm: warmup.ready });
    }
    const num = (s: FeatureSnapshot, n: string): number | null => (typeof s.features[n] === 'number' ? (s.features[n] as number) : null);
    const solReturn = dataset.solReturn1h.get(asOf) ?? null;
    const universe: UniverseAsset[] = computed.map(({ snapshot }) => ({ assetId: snapshot.assetId, ret1h: num(snapshot, 'ret_1h'), relVolume60: num(snapshot, 'rel_volume_60'), cohorts: dataset.memberships.filter((m) => m.assetId === snapshot.assetId).map((m) => m.cohortName) }));
    const regime = classifyRegime({ sol: { ret1h: solReturn }, assets: universe, policy: policies.regime });
    const rs = relativeStrength(universe);

    for (const { asset, snapshot: raw } of computed) {
      const r = rs.get(asset.id);
      const snapshot: FeatureSnapshot = { ...raw, regime: regime.regime, features: { ...raw.features, rs_universe_1h: r?.rsUniverse1h ?? null, rs_cohort_1h: r?.rsCohort1h ?? null } };
      const record = latestEligibility(asset, asOf);
      const gate = entryAllowed(record, asOf, policies.eligibility);
      const own1h = num(snapshot, 'ret_1h');
      const d = detect({
        snapshot,
        now: asOf,
        newId,
        entryGate: { allowed: gate.allowed, reason: gate.allowed ? null : gate.reason, eligibilityEvaluationId: record?.id ?? null },
        openCandidates: openCandidates.get(asset.id) ?? [],
        lastTerminalAt: lastTerminalAt.get(asset.id) ?? null,
        spec: policies.featureSpec,
        policy: policies.momentum,
        solRelativeReturn1h: own1h !== null && solReturn !== null ? own1h - solReturn : null,
      });
      if (d.kind === 'SKIP') continue;
      candidateCount++;
      if (d.kind === 'REJECTED') {
        lastTerminalAt.set(asset.id, asOf);
        continue;
      }
      openCandidates.set(asset.id, [...(openCandidates.get(asset.id) ?? []), d.candidate]);
      for (const stream of streams) {
        const verdict = stream.strategy.decide({ candidate: d.candidate, snapshot, now: asOf, guard, dataset, newId, variant: stream.variant });
        const decidedAt = stream.variant === 'LATENCY_MATCHED' ? addMs(verdict.decidedAt, latencyMatchedMs) : verdict.decidedAt;
        const index = recordDecision(stream, d.candidate, verdict, decidedAt);
        if (verdict.action === 'ENTER' && verdict.cycleState === 'CLEARED') pending.push({ stream, candidate: d.candidate, snapshot, verdict, decidedAt, decisionIndex: index });
      }
    }
  }

  await drain(run.window.to);
  clock.advanceTo(run.window.to);
  for (const item of pending.splice(0)) reject(item.stream, item.decisionIndex, 'WINDOW_END');
  for (const s of streams) await managePositions(s, run.window.to, 'WINDOW_END');

  const perStrategy: ReplayStrategyResult[] = streams.map((s) => ({
    strategyVersionId: s.strategy.version.versionId,
    variant: s.variant,
    decisions: s.decisions.length,
    fills: s.fills,
    rejections: s.rejections,
    closedTrades: s.trades.length,
    finalEquity: equityOf(s.book),
    realizedPnlBaseUnits: s.book.realizedPnl.toString(),
  }));
  // What the dataset can actually support, measured rather than asserted: a Level B label over a
  // series that was mostly backfilled long after its buckets is, for candle-derived features,
  // indistinguishable from Level A (review 2026-09-09, H-1).
  const lag = observationLagReport([...candlesByAsset.values()].flat(), MINUTE, cost.candleAvailabilityLagMs);
  const dataset_: ReplayOutput['dataset'] = {
    observationDiscipline,
    candles: lag,
    universe: dataset.universe ?? { requested: null, selected: dataset.assets.length, available: dataset.assets.length, truncated: false, selectionRule: 'unknown' },
    solPriceSettlement: dataset.solPriceSettlement ?? null,
  };
  deps.logger.info('replay_run_completed', { runId: run.id, fidelity: run.fidelity, ticks: tickCount, candidates: candidateCount, dataset: dataset_, streams: perStrategy.map((p) => ({ strategy: p.strategyVersionId, variant: p.variant, decisions: p.decisions, fills: p.fills, closed: p.closedTrades, realized: p.realizedPnlBaseUnits })) });
  return { run, decisions: streams.flatMap((s) => s.decisions), trades: streams.flatMap((s) => s.trades), perStrategy, candidates: candidateCount, ticks: tickCount, dataset: dataset_, latencyMatchedMs: run.latencyMatchedBaseline && latencyMatchedMs > 0 ? latencyMatchedMs : null };
}

function takeProfitOf(p: ReplayPosition, policy: RiskPolicy): RiskPolicy['takeProfit'] {
  const params = p.target?.parameters ?? {};
  const num = (k: string, fallback: number) => (typeof params[k] === 'number' ? (params[k] as number) : fallback);
  return { policy: p.target?.policy ?? policy.takeProfit.policy, targetRMultiple: num('targetRMultiple', policy.takeProfit.targetRMultiple), trailAfterRMultiple: num('trailAfterRMultiple', policy.takeProfit.trailAfterRMultiple), trailFraction: num('trailFraction', policy.takeProfit.trailFraction), maxHoldMs: num('maxHoldMs', policy.takeProfit.maxHoldMs) };
}

function targetOf(kind: 'NET_PNL_POSITIVE_AT_CLOSE' | 'REACHED_TARGET_BEFORE_STOP', realized: bigint, reason: string, led: PositionLedger, totalCost: bigint, holdMs: number, horizonMs: number): boolean | null {
  if (kind === 'NET_PNL_POSITIVE_AT_CLOSE') {
    // At the horizon when the position outlived it, else at close.
    if (holdMs > horizonMs && led.horizonMark !== null) return amountToBigInt(led.horizonMark) > totalCost;
    return realized > 0n;
  }
  if (reason.startsWith('TARGET') || reason.startsWith('PARTIAL') || reason.startsWith('TRAIL')) return true;
  if (reason === 'HARD_STOP') return false;
  return null;
}

function liquidityBand(usd: number | null): string | null {
  if (usd === null) return null;
  if (usd < 100_000) return '<100k';
  if (usd < 250_000) return '100k–250k';
  if (usd < 500_000) return '250k–500k';
  if (usd < 1_000_000) return '500k–1M';
  if (usd < 5_000_000) return '1M–5M';
  return '>5M';
}

function relVolumeBand(x: number | null): string | null {
  if (x === null) return null;
  if (x < 1) return '<1x';
  if (x < 2) return '1x–2x';
  if (x < 3) return '2x–3x';
  if (x < 5) return '3x–5x';
  return '5x+';
}

function addLamports(a: Amount, b: Amount): Amount {
  return bigIntToAmount(amountToBigInt(a) + amountToBigInt(b));
}

function minInstant(a: Instant, b: Instant): Instant {
  return instantToMs(a) <= instantToMs(b) ? a : b;
}

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

