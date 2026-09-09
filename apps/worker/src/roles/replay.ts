import { addMs, CONFIDENCE_BINS, confidenceBin, DEFAULT_CALIBRATION_TARGET, instantToMs, ReplayRequestPayload, type Clock, type ControlRequestKind, type Instant, type ReplayDecision, type ReplayResults, type ReplayRun, type Sha256Hex, type StrategyVersion, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { PendingControlRequest, ReplayRunRow, ReplayTradeRow } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';
import { attributeBy, calibration, coreMetrics, decisionsDigest, disagreementAttribution, economicPnl, incrementalValue, latencyCost, newReplayRun, resultsDigest, type AttributionDimension } from '@sol-agent-trader/replay';
import { runReplay } from '../replay/engine.js';
import { recordedReplayStrategy, s0ReplayStrategy } from '../replay/strategies.js';
import type { ReplayAccount, ReplayDataset, ReplayEngineDeps, ReplayOutput, ReplayPolicies, ReplayStrategy } from '../replay/types.js';

/**
 * Worker role `replay` (blueprint §18, §19, P9; execution plan M10). Two cycles:
 *   - requests: every RUN_REPLAY control request from an operator becomes a QUEUED run bound to
 *     the worker's current versions (git SHA, contract digest, feature engine, risk/gate/cost
 *     model, prompt versions, model selections) and the dataset cutoff of the moment it was filed;
 *   - execution: one queued run at a time is claimed, its dataset loaded once, the engine run,
 *     the §19 results computed, decisions and trades stored row by row and the run completed with
 *     its digests. A failure is recorded on the run; nothing is retried silently.
 * FAST (D41): a replay never touches capital, so an operator role is the only requirement.
 */

export interface ReplayRepo {
  listPending(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  operatorRole(userId: Uuid): Promise<'operator' | 'admin' | 'viewer' | null>;
  resolve(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
  insertRun(run: ReplayRun, extra: { controlRequestId: Uuid | null; assetIds: Uuid[] | null }): Promise<void>;
  claimQueued(now: Instant): Promise<ReplayRunRow | null>;
  complete(id: Uuid, done: { decisionsDigest: Sha256Hex; resultsDigest: Sha256Hex; results: ReplayResults; models: ReplayRun['models']; completedAt: Instant }): Promise<void>;
  fail(id: Uuid, error: string, at: Instant): Promise<void>;
  insertDecisions(rows: readonly ReplayDecision[]): Promise<number>;
  insertTrades(rows: readonly ReplayTradeRow[]): Promise<number>;
}

export interface ReplayVersions {
  gitSha: string;
  contractSetDigest: Sha256Hex;
  strategies: Record<VersionId, StrategyVersion>;
  skillVersionId: VersionId | null;
  guidelineVersionId: VersionId | null;
  /** Model id → training cutoff, for the §18.5 look-ahead label. */
  modelCutoffs: Record<string, Instant>;
  providerDatasetVersions: Record<string, string>;
}

export interface ReplayRoleDeps {
  repo: ReplayRepo;
  clock: Clock;
  logger: Logger;
  versions: ReplayVersions;
  policies: ReplayPolicies;
  account: ReplayAccount;
  platformMonthlyUsd: number;
  loadDataset: (run: ReplayRun, assetIds: Uuid[] | null) => Promise<ReplayDataset>;
  /** Injected in tests; default runs the engine. */
  execute?: (deps: ReplayEngineDeps) => Promise<ReplayOutput>;
  /** D37 layer 2: the live model cost the recorded strategies incurred inside the window, per strategy version (0 for deterministic strategies). */
  directCosts?: (run: ReplayRun) => Promise<Record<string, { modelUsd: number; runs: number }>>;
  newId: () => Uuid;
  config: { batchSize: number; maxWindowMs: number };
}

export interface ReplayRequestsReport {
  requests: number;
  queued: number;
  refused: Record<string, number>;
}

export interface ReplayExecutionReport {
  claimed: boolean;
  runId: Uuid | null;
  status: 'COMPLETED' | 'FAILED' | null;
  decisions: number;
  trades: number;
  durationMs: number;
}

const KINDS: ControlRequestKind[] = ['RUN_REPLAY'];

export async function runReplayRequestsCycle(deps: ReplayRoleDeps): Promise<ReplayRequestsReport> {
  const now = deps.clock.now();
  const report: ReplayRequestsReport = { requests: 0, queued: 0, refused: {} };
  const requests = await deps.repo.listPending(KINDS, deps.config.batchSize);
  report.requests = requests.length;
  for (const req of requests) {
    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      report.refused[reason] = (report.refused[reason] ?? 0) + 1;
      await deps.repo.resolve(req.id, 'REJECTED', { reason, ...extra }, now);
      deps.logger.warn('replay_request_refused', { requestId: req.id, reason, by: req.requestedBy, ...extra });
    };
    const role = await deps.repo.operatorRole(req.requestedBy);
    if (role !== 'operator' && role !== 'admin') {
      await refuse('NOT_AN_OPERATOR', { role });
      continue;
    }
    const parsed = ReplayRequestPayload.safeParse(req.payload);
    if (!parsed.success) {
      await refuse('MALFORMED_PAYLOAD', { detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`) });
      continue;
    }
    const p = parsed.data;
    const unknown = p.strategyVersionIds.filter((v) => !deps.versions.strategies[v]);
    if (unknown.length) {
      await refuse('UNKNOWN_STRATEGY_VERSION', { unknown });
      continue;
    }
    if (!p.strategyVersionIds.includes(p.baselineStrategyVersionId)) {
      await refuse('BASELINE_NOT_IN_SET');
      continue;
    }
    if (instantToMs(p.window.from) >= instantToMs(p.window.to) || instantToMs(p.window.to) > instantToMs(now)) {
      await refuse('WINDOW_INVALID', { detail: 'from must precede to and to must not lie in the future' });
      continue;
    }
    if (instantToMs(p.window.to) - instantToMs(p.window.from) > deps.config.maxWindowMs) {
      await refuse('WINDOW_TOO_LONG', { maxWindowMs: deps.config.maxWindowMs });
      continue;
    }
    if (p.window.inSampleUntil !== null && !(instantToMs(p.window.inSampleUntil) > instantToMs(p.window.from) && instantToMs(p.window.inSampleUntil) < instantToMs(p.window.to))) {
      await refuse('HOLDOUT_OUTSIDE_WINDOW');
      continue;
    }
    const strategies = p.strategyVersionIds.map((v) => deps.versions.strategies[v]!);
    const promptVersions: Record<string, VersionId> = {};
    const modelSelections: Record<string, string> = {};
    const models: { role: string; model: string; trainingCutoff: Instant | null }[] = [];
    for (const s of strategies) {
      for (const [k, v] of Object.entries(s.promptVersions)) promptVersions[`${s.versionId}:${k}`] = v;
      for (const [k, v] of Object.entries(s.modelSelections)) {
        modelSelections[`${s.versionId}:${k}`] = v;
        if (!models.some((m) => m.model === v && m.role === k)) models.push({ role: k, model: v, trainingCutoff: deps.versions.modelCutoffs[v] ?? null });
      }
    }
    const run = newReplayRun({
      id: deps.newId(),
      name: p.name,
      fidelity: p.fidelity,
      requestedBy: req.requestedBy,
      window: { from: p.window.from, to: p.window.to, datasetCutoff: now, inSampleUntil: p.window.inSampleUntil },
      strategyVersionIds: p.strategyVersionIds,
      baselineStrategyVersionId: p.baselineStrategyVersionId,
      versions: {
        gitSha: deps.versions.gitSha as never,
        contractSetDigest: deps.versions.contractSetDigest,
        featureEngineVersion: deps.policies.featureSpec.version,
        riskPolicyVersion: deps.policies.risk.version,
        gatePolicyVersion: deps.policies.gate.version,
        costModelVersion: deps.policies.costModel.version,
        promptVersions,
        modelSelections,
        providerDatasetVersions: deps.versions.providerDatasetVersions,
        skillVersionId: deps.versions.skillVersionId,
        guidelineVersionId: deps.versions.guidelineVersionId,
      },
      models,
      seed: p.seed,
      latencyMatchedBaseline: p.latencyMatchedBaseline,
      proposerOnlyShadow: p.proposerOnlyShadow,
      calibrationTarget: p.calibrationTarget ?? DEFAULT_CALIBRATION_TARGET,
      createdAt: now,
    });
    await deps.repo.insertRun(run, { controlRequestId: req.id, assetIds: p.assetIds });
    await deps.repo.resolve(req.id, 'ACCEPTED', { runId: run.id, status: 'QUEUED', datasetCutoff: now }, now);
    report.queued++;
    deps.logger.info('replay_run_queued', { runId: run.id, name: run.name, fidelity: run.fidelity, window: run.window, strategies: run.strategyVersionIds, by: req.requestedBy });
  }
  return report;
}

export function strategiesFor(run: ReplayRun, versions: Record<VersionId, StrategyVersion>, policies: ReplayPolicies): ReplayStrategy[] {
  return run.strategyVersionIds.map((id) => {
    const v = versions[id];
    if (!v) throw new Error(`replay run ${run.id} names unknown strategy version ${id}`);
    if (v.strategyId === 'S0_RAW') return s0ReplayStrategy('RAW', v, policies.gate);
    if (v.strategyId === 'S0_SAFE') return s0ReplayStrategy('SAFE', v, policies.gate);
    return recordedReplayStrategy(v);
  });
}

export async function runReplayExecutionCycle(deps: ReplayRoleDeps): Promise<ReplayExecutionReport> {
  const startedAt = deps.clock.now();
  const claimed = await deps.repo.claimQueued(startedAt);
  if (!claimed) return { claimed: false, runId: null, status: null, decisions: 0, trades: 0, durationMs: 0 };
  const run = claimed.run;
  deps.logger.info('replay_run_started', { runId: run.id, name: run.name, fidelity: run.fidelity, window: run.window, strategies: run.strategyVersionIds });
  try {
    const dataset = await deps.loadDataset(run, claimed.assetIds);
    const strategies = strategiesFor(run, deps.versions.strategies, deps.policies);
    const out = await (deps.execute ?? runReplay)({ run, dataset, strategies, policies: deps.policies, account: deps.account, logger: deps.logger });
    const directCosts = deps.directCosts ? await deps.directCosts(run) : {};
    const results = buildResults(out, run, deps.account, deps.platformMonthlyUsd, directCosts, { dataResolutionMs: 60_000, submissionDelayMs: deps.policies.costModel.fill.submissionDelayMs });
    const [dDigest, rDigest] = await Promise.all([decisionsDigest(out.decisions), resultsDigest(results)]);
    const decisions = await deps.repo.insertDecisions(out.decisions);
    const trades = await deps.repo.insertTrades(out.trades.map((t) => ({
      id: t.id as Uuid,
      runId: run.id,
      strategyVersionId: t.strategyVersionId,
      variant: t.variant,
      sample: t.sample,
      assetId: t.assetId as Uuid,
      candidateId: (t.candidateId as Uuid | null) ?? null,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      cost: t.cost,
      proceeds: t.proceeds,
      fees: t.fees,
      feesLamports: t.feesLamports ?? 0,
      slippageCost: t.slippageCost,
      executionShortfallBps: t.executionShortfallBps,
      executionPath: t.executionPath,
      exitReason: t.exitReason,
      decisionToFillMs: t.decisionToFillMs,
      attributes: t.attributes as unknown as Record<string, unknown>,
    })));
    const completedAt = deps.clock.now();
    await deps.repo.complete(run.id, { decisionsDigest: dDigest, resultsDigest: rDigest, results, models: run.models, completedAt });
    const durationMs = instantToMs(completedAt) - instantToMs(startedAt);
    deps.logger.info('replay_run_completed', { runId: run.id, decisions, trades, candidates: out.candidates, ticks: out.ticks, decisionsDigest: dDigest, durationMs });
    return { claimed: true, runId: run.id, status: 'COMPLETED', decisions, trades, durationMs };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await deps.repo.fail(run.id, message, deps.clock.now());
    deps.logger.error('replay_run_failed', { runId: run.id, error: message });
    return { claimed: true, runId: run.id, status: 'FAILED', decisions: 0, trades: 0, durationMs: instantToMs(deps.clock.now()) - instantToMs(startedAt) };
  }
}

const DIMENSIONS: AttributionDimension[] = ['candidateFamily', 'regime', 'session', 'liquidityBand', 'relativeVolumeBand', 'confidenceBin', 'adversaryVerdict', 'hourOfDayUtc', 'dayOfWeekUtc', 'durationBand', 'executionPath'];

/** §19.1–19.4 over the engine output; every row carries its strategy version and variant. */
export function buildResults(out: ReplayOutput, run: ReplayRun, account: ReplayAccount, platformMonthlyUsd: number, directCosts: Record<string, { modelUsd: number; runs: number }> = {}, costModel?: { dataResolutionMs: number; submissionDelayMs: number }): ReplayResults {
  const scale = 10 ** account.settlementDecimals;
  const startingEquity = Number(account.startingCapital) / scale;
  const window = { from: run.window.from, to: run.window.to };
  const solPriceSettlement = out.dataset.solPriceSettlement;
  const streams = out.perStrategy.map((p) => ({ strategyVersionId: p.strategyVersionId, variant: p.variant }));
  /**
   * Attempts that never became a fill, for the stream and sample being reported. The hold-out and
   * in-sample rows used to pass a hard-coded zero, so `failed_execution_rate` read "0%" on every
   * split of every run regardless of what happened (review 2026-09-09, M-15). `RISK:` refusals are
   * excluded because they are policy decisions, not execution failures.
   */
  const failedBy = (id: VersionId, variant: string, sample: 'IN_SAMPLE' | 'HOLD_OUT' | 'ALL') =>
    out.decisions.filter((d) => d.strategyVersionId === id && d.variant === variant && (sample === 'ALL' || d.sample === sample) && d.rejection !== null && !d.rejection.startsWith('RISK:')).length;
  const metricsFor = (trades: ReplayOutput['trades'], failedExecutions: number) => coreMetrics({ trades, failedExecutions, startingEquity, window, solPriceSettlement });
  const comparison: ReplayResults['comparison'] = [];
  for (const s of streams) {
    const mine = out.trades.filter((t) => t.strategyVersionId === s.strategyVersionId && t.variant === s.variant);
    comparison.push({ strategyVersionId: s.strategyVersionId, variant: s.variant, sample: 'ALL', metrics: metricsFor(mine, failedBy(s.strategyVersionId, s.variant, 'ALL')) as unknown as Record<string, unknown> });
    if (run.window.inSampleUntil !== null) {
      for (const sample of ['IN_SAMPLE', 'HOLD_OUT'] as const) comparison.push({ strategyVersionId: s.strategyVersionId, variant: s.variant, sample, metrics: metricsFor(mine.filter((t) => t.sample === sample), failedBy(s.strategyVersionId, s.variant, sample)) as unknown as Record<string, unknown> });
    }
  }
  const others = run.strategyVersionIds.filter((id) => id !== run.baselineStrategyVersionId);
  const incremental = others.map((id) => incrementalValue(out.decisions, run.baselineStrategyVersionId, id, directCosts[id]?.modelUsd ?? 0, scale) as unknown as Record<string, unknown>);
  const disagreement = others.map((id) => disagreementAttribution(out.decisions, id, run.baselineStrategyVersionId, scale) as unknown as Record<string, unknown>);
  const latencyOpts = costModel ? { dataResolutionMs: costModel.dataResolutionMs, submissionDelayMs: costModel.submissionDelayMs, latencyMatchedMs: out.latencyMatchedMs } : undefined;
  const latency = run.strategyVersionIds.map((id) => latencyCost(out.decisions, id, run.baselineStrategyVersionId, scale, latencyOpts) as unknown as Record<string, unknown>);
  const calib = run.strategyVersionIds.map((id) => calibration(out.decisions, id, run.calibrationTarget.kind, confidenceBin, CONFIDENCE_BINS.map((b) => b.label), scale) as unknown as Record<string, unknown>);
  const attribution: ReplayResults['attribution'] = {};
  for (const dim of DIMENSIONS) {
    attribution[dim] = run.strategyVersionIds.flatMap((id) => {
      const mine = out.trades.filter((t) => t.strategyVersionId === id && t.variant === 'FULL');
      return attributeBy({ trades: mine, failedExecutions: failedBy(id, 'FULL', 'ALL'), startingEquity, window, solPriceSettlement }, dim, confidenceBin).map((g) => ({ strategyVersionId: id, ...g }) as unknown as Record<string, unknown>);
    });
  }
  const economic = economicPnl({
    window,
    strategies: run.strategyVersionIds.map((id) => {
      const mine = out.trades.filter((t) => t.strategyVersionId === id && t.variant === 'FULL');
      const m = metricsFor(mine, failedBy(id, 'FULL', 'ALL'));
      return { strategyVersionId: id, tradingNetUsd: m.netPnl, turnoverUsd: m.turnover, direct: { modelUsd: directCosts[id]?.modelUsd ?? 0, dataUsd: 0, rpcUsd: 0 } };
    }),
    platformMonthlyUsd,
    allocation: 'BY_TURNOVER',
  }) as unknown as Record<string, unknown>;
  return { comparison, incremental, disagreement, latency, calibration: calib, attribution, economic, perStrategy: out.perStrategy as unknown as Record<string, unknown>[], candidates: out.candidates, ticks: out.ticks, dataset: out.dataset };
}

export { addMs as _addMs };
