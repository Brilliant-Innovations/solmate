import type { Sha256Hex, ActionCycle, AdversarialReview, Amount, Fill, Instant, MintAddress, Position, PositionSafetyState, Proposal, RiskEvaluation, SignedAmount, Uuid, VersionId } from '@sol-agent-trader/contracts';
import { recordClearedTransition } from './audit.js';
import { asJson, type Sql } from './sql.js';

/**
 * Open-position persistence for the position monitor (blueprint §13.4–13.5, §6.19, D24, D39,
 * D44; execution plan M5a MONITORED_EXIT). Marks and stop tightening are the only mutable
 * analytics on a position; a stop can never loosen here (the update is conditional), and an exit
 * reduces exactly the lots the fill names.
 */

export interface OpenPositionRow {
  id: Uuid;
  accountId: Uuid;
  assetId: Uuid;
  mint: MintAddress;
  decimals: number;
  symbol: string;
  quantity: Amount;
  averageEntryPrice: number | null;
  costBasisBaseUnits: Amount;
  realizedPnlBaseUnits: SignedAmount;
  stop: Position['stop'];
  target: Position['target'];
  unreviewedStop: number | null;
  safetyState: PositionSafetyState;
  openedAt: Instant;
  lots: { id: Uuid; sleeveId: Uuid; strategyVersionId: VersionId; quantity: Amount; costBasisBaseUnits: Amount; entryIntentId: Uuid }[];
}

export async function listOpenPositionsForAccount(sql: Sql, accountId: Uuid, limit: number): Promise<OpenPositionRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select p.id, p.account_id, p.asset_id, p.mint, a.decimals, a.symbol, p.quantity::text as quantity, p.average_entry_price, p.cost_basis_base_units::text as cost_basis, p.realized_pnl_base_units::text as realized,
      p.stop, p.target, p.unreviewed_stop, p.safety_state, p.opened_at,
      coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'sleeveId', l.sleeve_id, 'strategyVersionId', l.strategy_version_id, 'quantity', l.quantity::text, 'costBasisBaseUnits', l.cost_basis_base_units::text, 'entryIntentId', l.entry_intent_id) order by l.opened_at)
        from trading.position_lots l where l.position_id = p.id and l.status = 'OPEN'), '[]'::jsonb) as lots
    from trading.positions p join core.assets a on a.id = p.asset_id
    where p.account_id = ${accountId} and p.status <> 'CLOSED' and p.quantity <> 0
    order by p.opened_at asc limit ${limit}`;
  return rows.map((r) => ({
    id: r['id'] as Uuid,
    accountId: r['account_id'] as Uuid,
    assetId: r['asset_id'] as Uuid,
    mint: r['mint'] as MintAddress,
    decimals: r['decimals'] as number,
    symbol: r['symbol'] as string,
    quantity: r['quantity'] as Amount,
    averageEntryPrice: (r['average_entry_price'] as number | null) ?? null,
    costBasisBaseUnits: r['cost_basis'] as Amount,
    realizedPnlBaseUnits: r['realized'] as SignedAmount,
    stop: (r['stop'] as Position['stop']) ?? null,
    target: (r['target'] as Position['target']) ?? null,
    unreviewedStop: (r['unreviewed_stop'] as number | null) ?? null,
    safetyState: r['safety_state'] as PositionSafetyState,
    openedAt: new Date(r['opened_at'] as string).toISOString() as Instant,
    lots: r['lots'] as OpenPositionRow['lots'],
  }));
}

/** Highest 1m candle high since the position opened (any provider); null when no candle covers the window. */
export async function highSince(sql: Sql, assetId: Uuid, since: Instant, until: Instant): Promise<number | null> {
  const [r] = await sql<{ high: number | null }[]>`select max(high) as high from market.candles where asset_id = ${assetId} and resolution = '1m' and bucket_time between ${since} and ${until}`;
  return r?.high ?? null;
}

export async function updateMark(sql: Sql, positionId: Uuid, unrealizedPnl: SignedAmount, nextReassessmentAt: Instant): Promise<void> {
  await sql`update trading.positions set unrealized_pnl_base_units = ${unrealizedPnl}, next_reassessment_at = ${nextReassessmentAt} where id = ${positionId}`;
}

/** Tightens only (D39): returns false when the stored stop is already at or above the level. */
export async function tightenStop(sql: Sql, positionId: Uuid, level: number): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update trading.positions set unreviewed_stop = ${level}, stop = case when stop is null then null else jsonb_set(stop, '{level}', to_jsonb(${level}::double precision)) end
    where id = ${positionId} and status <> 'CLOSED' and (unreviewed_stop is null or unreviewed_stop < ${level}) returning id`;
  return rows.length > 0;
}

/** A deterministic exit decision as a position action cycle with its proposal, review and evaluation, linked and marked reviewed. */
export async function recordExitDecision(sql: Sql, cycle: ActionCycle, proposal: Proposal, review: AdversarialReview, evaluation: RiskEvaluation, releaseDigest: Sha256Hex | null = null): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`
      insert into agents.action_cycles (id, automation_run_id, trigger_id, candidate_id, position_id, strategy_version_id, skill_version_id, guideline_version_id, speed_tier, decision_budget_ms,
        proposed_action, proposal_id, proposer_run_ids, adversary_run_ids, verdict, reason_codes, revision_round, state, unresolved_reason, cutoffs, cleared_cutoff_version, risk_evaluation_id, intent_id, started_at, terminal_at)
      values (${cycle.id}, ${cycle.automationRunId}, ${cycle.triggerId}, ${cycle.candidateId}, ${cycle.positionId}, ${cycle.strategyVersionId}, ${cycle.skillVersionId}, ${cycle.guidelineVersionId}, ${cycle.speedTier}, ${cycle.decisionBudgetMs},
        ${cycle.proposedAction}, ${cycle.proposalId}, ${cycle.proposerRunIds}, ${cycle.adversaryRunIds}, ${cycle.verdict}, ${cycle.reasonCodes}, ${cycle.revisionRound}, ${cycle.state}, ${cycle.unresolvedReason}, ${t.json(asJson(cycle.cutoffs))}, ${cycle.clearedCutoffVersion}, null, null, ${cycle.startedAt}, ${cycle.terminalAt})`;
    await t`
      insert into trading.proposals (id, action_cycle_id, candidate_id, position_id, strategy_version_id, source, proposal, created_at, expires_at)
      values (${proposal.id}, ${proposal.actionCycleId}, ${proposal.candidateId}, ${proposal.positionId}, ${proposal.strategyVersionId}, ${proposal.source}, ${t.json(asJson(proposal.proposal))}, ${proposal.createdAt}, ${proposal.expiresAt})`;
    await t`
      insert into agents.adversarial_reviews (id, action_cycle_id, agent_run_id, deterministic_gate, verdict, objections, confidence, cutoff_version, latency_ms, blocking, created_at)
      values (${review.id}, ${review.actionCycleId}, ${review.agentRunId}, ${review.deterministicGate}, ${review.verdict}, ${t.json(asJson(review.objections))}, ${review.confidence}, ${review.cutoffVersion}, ${review.latencyMs}, ${review.blocking}, ${review.createdAt})`;
    const e = evaluation;
    await t`
      insert into trading.risk_evaluations (id, proposal_id, action_cycle_id, policy_version, allowed, reason_codes, settlement_mint, equity_base_units, equity_usd, exposure_base_units, cohort_exposure, cluster_exposure, sleeve_exposure,
        asset_eligibility_evaluation_id, computed_max_loss_base_units, computed_position_amount, max_slippage_bps, max_price_impact_bps, stop_policy, target_policy, daily_drawdown_fraction, circuit_breaker_tripped, stale_data_checks, created_at)
      values (${e.id}, ${e.proposalId}, ${e.actionCycleId}, ${e.policyVersion}, ${e.allowed}, ${e.reasonCodes}, ${e.settlementMint}, ${e.equityBaseUnits}, ${e.equityUsd}, ${e.exposureBaseUnits}, ${t.json(asJson(e.cohortExposure))}, ${t.json(asJson(e.clusterExposure))}, ${e.sleeveExposure},
        ${e.assetEligibilityEvaluationId}, ${e.computedMaxLossBaseUnits}, ${e.computedPositionAmount}, ${e.maxSlippageBps}, ${e.maxPriceImpactBps}, ${e.stopPolicy ? t.json(asJson(e.stopPolicy)) : null}, ${e.targetPolicy ? t.json(asJson(e.targetPolicy)) : null}, ${e.dailyDrawdownFraction}, ${e.circuitBreakerTripped}, ${t.json(asJson(e.staleDataChecks))}, ${e.createdAt})`;
    if (cycle.state === 'CLEARED') await recordClearedTransition(t, { cycle, proposal, releaseDigest });
    await t`update agents.action_cycles set risk_evaluation_id = ${e.id} where id = ${cycle.id}`;
    await t`update trading.positions set last_reviewed_cycle_id = ${cycle.id}, review_state = 'REVIEWED', review_state_reason = null, review_state_since = ${cycle.terminalAt ?? cycle.startedAt} where id = ${cycle.positionId}`;
  });
}

export interface ExitApplication {
  positionId: Uuid;
  intentId: Uuid;
  fill: Fill;
  /** Per-lot reduction with the cost basis it releases and the realized P&L it books. */
  lots: { lotId: Uuid; sleeveId: Uuid; quantity: Amount; costReleased: Amount; realizedPnl: SignedAmount }[];
  closesPosition: boolean;
  closedAt: Instant;
}

/** Applies a finalized exit fill to its lots, the position and the sleeves atomically (D24, D44; INV-22 final accounting on FINALIZED only). */
export async function applyExit(sql: Sql, x: ExitApplication): Promise<void> {
  if (x.fill.commitment !== 'finalized') throw new Error('exit accounting requires a finalized fill (INV-22)');
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    let totalQty = 0n;
    let totalCost = 0n;
    let totalPnl = 0n;
    for (const l of x.lots) {
      const rows = await t<{ id: string }[]>`
        update trading.position_lots set quantity = quantity - ${l.quantity}::core.amount, cost_basis_base_units = cost_basis_base_units - ${l.costReleased}::core.amount,
          realized_pnl_base_units = realized_pnl_base_units + ${l.realizedPnl}::core.signed_amount, exit_fill_ids = array_append(exit_fill_ids, ${x.fill.id}::uuid),
          status = case when quantity - ${l.quantity}::core.amount = 0 then 'CLOSED' else status end, closed_at = case when quantity - ${l.quantity}::core.amount = 0 then ${x.closedAt}::timestamptz else closed_at end
        where id = ${l.lotId} and status = 'OPEN' and quantity >= ${l.quantity}::core.amount returning id`;
      if (rows.length === 0) throw new Error(`lot ${l.lotId} cannot release ${l.quantity}`);
      await t`update trading.strategy_sleeves set committed_base_units = greatest(0, committed_base_units - ${l.costReleased}::core.amount) where id = ${l.sleeveId}`;
      totalQty += BigInt(l.quantity);
      totalCost += BigInt(l.costReleased);
      totalPnl += BigInt(l.realizedPnl);
    }
    const updated = await t<{ id: string }[]>`
      update trading.positions set quantity = quantity - ${totalQty.toString()}::core.amount, cost_basis_base_units = cost_basis_base_units - ${totalCost.toString()}::core.amount,
        realized_pnl_base_units = realized_pnl_base_units + ${totalPnl.toString()}::core.signed_amount,
        status = ${x.closesPosition ? 'CLOSED' : 'OPEN'}, closed_at = ${x.closesPosition ? x.closedAt : null}, unrealized_pnl_base_units = ${x.closesPosition ? '0' : null}
      where id = ${x.positionId} and status <> 'CLOSED' and quantity >= ${totalQty.toString()}::core.amount returning id`;
    if (updated.length === 0) throw new Error(`position ${x.positionId} cannot release ${totalQty}`);
    await t`update trading.intents set lifecycle_state = 'COMPLETED' where id = ${x.intentId}`;
  });
}
