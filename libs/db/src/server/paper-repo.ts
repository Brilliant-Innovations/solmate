import type { Amount, Fill, Instant, MintAddress, Order, OrderAttempt, PortfolioSnapshot, Position, PositionLot, Proposal, RiskEvaluation, SolanaAddress, SolanaCluster, StrategySleeve, TradeIntent, Uuid, VersionId } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Paper book persistence (blueprint §17, §6.11–6.20; execution plan M5a). A PAPER account is a
 * normal trading account whose custody is virtual: the same intents, orders, attempts, fills,
 * positions, lots and snapshots as live, written through the same immutability rules, so the
 * Inspector, attribution and the parity suite read one shape. Nothing here computes a decision;
 * the risk core and the paper adapter do, and this module records their outputs.
 */

export interface PaperAccount {
  id: Uuid;
  name: string;
  cluster: SolanaCluster;
  tradingWallet: SolanaAddress;
  settlementMint: MintAddress;
}

export async function ensurePaperAccount(sql: Sql, a: PaperAccount): Promise<PaperAccount> {
  const [row] = await sql<{ id: string; name: string; cluster: SolanaCluster; trading_wallet: string; settlement_mint: string; mode: string }[]>`
    insert into trading.accounts (id, name, cluster, trading_wallet, settlement_mint, mode)
    values (${a.id}, ${a.name}, ${a.cluster}, ${a.tradingWallet}, ${a.settlementMint}, 'PAPER')
    on conflict (name) do update set name = excluded.name
    returning id, name, cluster, trading_wallet, settlement_mint, mode`;
  if (!row) throw new Error('paper account upsert returned nothing');
  if (row.mode !== 'PAPER') throw new Error(`account ${a.name} is ${row.mode}, not PAPER`);
  return { id: row.id as Uuid, name: row.name, cluster: row.cluster, tradingWallet: row.trading_wallet as SolanaAddress, settlementMint: row.settlement_mint as MintAddress };
}

/** One sleeve per (account, strategy version, sleeve version); caps are immutable per version. */
export async function ensureSleeve(sql: Sql, s: StrategySleeve): Promise<StrategySleeve> {
  const [row] = await sql<Record<string, unknown>[]>`
    insert into trading.strategy_sleeves (id, account_id, strategy_version_id, version_id, settlement_mint, capital_cap_base_units, risk_budget_base_units, committed_base_units, risk_used_base_units, active)
    values (${s.id}, ${s.accountId}, ${s.strategyVersionId}, ${s.versionId}, ${s.settlementMint}, ${s.capitalCapBaseUnits}, ${s.riskBudgetBaseUnits}, ${s.committedBaseUnits}, ${s.riskUsedBaseUnits}, ${s.active})
    on conflict (account_id, strategy_version_id, version_id) do update set active = trading.strategy_sleeves.active
    returning *`;
  return rowToSleeve(row!);
}

export async function listSleeves(sql: Sql, accountId: Uuid): Promise<StrategySleeve[]> {
  const rows = await sql<Record<string, unknown>[]>`select * from trading.strategy_sleeves where account_id = ${accountId} order by created_at asc`;
  return rows.map(rowToSleeve);
}

function rowToSleeve(r: Record<string, unknown>): StrategySleeve {
  return {
    id: r['id'] as Uuid,
    accountId: r['account_id'] as Uuid,
    strategyVersionId: r['strategy_version_id'] as VersionId,
    versionId: r['version_id'] as VersionId,
    settlementMint: r['settlement_mint'] as MintAddress,
    capitalCapBaseUnits: r['capital_cap_base_units'] as Amount,
    riskBudgetBaseUnits: r['risk_budget_base_units'] as Amount,
    committedBaseUnits: r['committed_base_units'] as Amount,
    riskUsedBaseUnits: r['risk_used_base_units'] as Amount,
    active: r['active'] as boolean,
    createdAt: new Date(r['created_at'] as string).toISOString() as Instant,
  };
}

export interface EntryCandidateRow {
  cycle: { id: Uuid; strategyVersionId: VersionId; candidateId: Uuid; clearedCutoffVersion: number; startedAt: Instant };
  proposal: Proposal;
  asset: { id: Uuid; mint: MintAddress; decimals: number; symbol: string; tokenProgram: 'TOKEN' | 'TOKEN_2022' | 'UNKNOWN' };
  eligibility: { id: Uuid; settlementRouteConfirmed: boolean; liquidityUsd: number | null } | null;
  snapshot: { id: Uuid; asOf: Instant; features: Record<string, number | null> };
}

/** CLEARED cycles for these strategies with no risk evaluation yet, oldest first, with what the risk core needs. */
export async function listCyclesAwaitingEntry(sql: Sql, strategyVersionIds: VersionId[], limit: number): Promise<EntryCandidateRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select c.id as cycle_id, c.strategy_version_id, c.candidate_id, c.cleared_cutoff_version, c.started_at,
      p.id as p_id, p.action_cycle_id as p_cycle, p.candidate_id as p_candidate, p.position_id as p_position, p.strategy_version_id as p_strategy, p.source as p_source, p.proposal as p_body, p.created_at as p_created, p.expires_at as p_expires,
      a.id as a_id, a.mint_address, a.decimals, a.symbol, a.token_program,
      e.id as e_id, e.settlement_route_confirmed, e.liquidity_usd,
      f.id as f_id, f.as_of as f_as_of, f.features as f_features
    from agents.action_cycles c
    join trading.proposals p on p.id = c.proposal_id
    join signals.candidates k on k.id = c.candidate_id
    join core.assets a on a.id = k.asset_id
    join signals.feature_snapshots f on f.id = k.feature_snapshot_id
    left join core.asset_eligibility e on e.id = k.eligibility_evaluation_id
    where c.state = 'CLEARED' and c.verdict = 'CONFIRM' and c.proposed_action = 'ENTER' and c.risk_evaluation_id is null
      and c.strategy_version_id = any(${strategyVersionIds}::core.version_id[])
    order by c.started_at asc
    limit ${limit}`;
  return rows.map((r) => ({
    cycle: { id: r['cycle_id'] as Uuid, strategyVersionId: r['strategy_version_id'] as VersionId, candidateId: r['candidate_id'] as Uuid, clearedCutoffVersion: r['cleared_cutoff_version'] as number, startedAt: iso(r['started_at']) },
    proposal: { id: r['p_id'] as Uuid, actionCycleId: r['p_cycle'] as Uuid, candidateId: r['p_candidate'] as Uuid | null, positionId: r['p_position'] as Uuid | null, strategyVersionId: r['p_strategy'] as VersionId, source: r['p_source'] as Proposal['source'], proposal: r['p_body'] as Proposal['proposal'], createdAt: iso(r['p_created']), expiresAt: iso(r['p_expires']) },
    asset: { id: r['a_id'] as Uuid, mint: r['mint_address'] as MintAddress, decimals: r['decimals'] as number, symbol: r['symbol'] as string, tokenProgram: r['token_program'] as 'TOKEN' | 'TOKEN_2022' | 'UNKNOWN' },
    eligibility: r['e_id'] ? { id: r['e_id'] as Uuid, settlementRouteConfirmed: r['settlement_route_confirmed'] as boolean, liquidityUsd: (r['liquidity_usd'] as number | null) ?? null } : null,
    snapshot: { id: r['f_id'] as Uuid, asOf: iso(r['f_as_of']), features: r['f_features'] as Record<string, number | null> },
  }));
}

export interface PaperBook {
  /** Starting capital − finalized entry inputs + finalized exit outputs (settlement base units). */
  settlementBalance: Amount;
  /** Sum of open-lot cost basis, i.e. exposure at cost. */
  exposureAtCost: Amount;
  openPositions: { id: Uuid; assetId: Uuid; mint: MintAddress; quantity: Amount; costBasis: Amount }[];
  /** Exposure-increasing intents not yet terminal, plus provisional attempts (P1). */
  pendingExposure: Amount;
  inFlightIncreasing: number;
  sleeves: StrategySleeve[];
  /** Lamports spent on modelled fees so far. */
  feesLamports: Amount;
  consecutiveLosses: number;
  /** Equity snapshots for drawdown: first of the UTC day and the 30-day high. */
  dayStartEquity: Amount | null;
  rollingHighEquity: Amount | null;
}

export async function paperBook(sql: Sql, accountId: Uuid, settlementMint: MintAddress, startingCapital: Amount, now: Instant): Promise<PaperBook> {
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
  const rolling = new Date(Date.parse(now) - 30 * 86_400_000).toISOString();
  const [flows] = await sql<{ entries: string; exits: string; fees: string }[]>`
    select
      coalesce(sum(case when i.side = 'BUY' then f.input_amount else 0 end), 0)::text as entries,
      coalesce(sum(case when i.side = 'SELL' then f.output_amount else 0 end), 0)::text as exits,
      coalesce(sum((f.fees->>'networkBaseUnits')::numeric + (f.fees->>'priorityBaseUnits')::numeric), 0)::text as fees
    from trading.fills f
    join trading.order_attempts oa on oa.id = f.order_attempt_id
    join trading.intents i on i.id = oa.intent_id
    where i.account_id = ${accountId} and f.commitment = 'finalized'`;
  const positions = await sql<{ id: string; asset_id: string; mint: string; quantity: string; cost_basis_base_units: string }[]>`
    select id, asset_id, mint, quantity::text, cost_basis_base_units::text from trading.positions where account_id = ${accountId} and status <> 'CLOSED'`;
  const [pending] = await sql<{ pending: string; in_flight: number }[]>`
    select
      coalesce(sum(case when i.lifecycle_state in ('AUTHORIZED', 'APPROVED', 'EXECUTING') then i.max_input_amount else 0 end), 0)::text as pending,
      count(*) filter (where i.lifecycle_state = 'EXECUTING')::int as in_flight
    from trading.intents i where i.account_id = ${accountId} and i.exposure_effect = 'INCREASE'`;
  const [provisional] = await sql<{ amount: string }[]>`
    select coalesce(sum(i.max_input_amount), 0)::text as amount
    from trading.order_attempts oa join trading.intents i on i.id = oa.intent_id
    where i.account_id = ${accountId} and i.exposure_effect = 'INCREASE' and oa.state in ('CONFIRMED_PROVISIONAL', 'REORG_PENDING')`;
  const recentLots = await sql<{ pnl: string }[]>`
    select l.realized_pnl_base_units::text as pnl from trading.position_lots l join trading.positions p on p.id = l.position_id
    where p.account_id = ${accountId} and l.status = 'CLOSED' order by l.closed_at desc limit 20`;
  let consecutiveLosses = 0;
  for (const r of recentLots) {
    if (BigInt(r.pnl) < 0n) consecutiveLosses++;
    else break;
  }
  const [day] = await sql<{ equity: string | null }[]>`
    select equity_base_units::text as equity from trading.portfolio_snapshots where account_id = ${accountId} and as_of >= ${dayStart} order by as_of asc limit 1`;
  const [high] = await sql<{ equity: string | null }[]>`
    select max(equity_base_units)::text as equity from trading.portfolio_snapshots where account_id = ${accountId} and as_of >= ${rolling}`;
  const sleeves = await listSleeves(sql, accountId);
  void settlementMint;
  const exposure = positions.reduce((acc, p) => acc + BigInt(p.cost_basis_base_units), 0n);
  const balance = BigInt(startingCapital) - BigInt(flows?.entries ?? '0') + BigInt(flows?.exits ?? '0');
  return {
    settlementBalance: (balance < 0n ? 0n : balance).toString() as Amount,
    exposureAtCost: exposure.toString() as Amount,
    openPositions: positions.map((p) => ({ id: p.id as Uuid, assetId: p.asset_id as Uuid, mint: p.mint as MintAddress, quantity: p.quantity as Amount, costBasis: p.cost_basis_base_units as Amount })),
    pendingExposure: (BigInt(pending?.pending ?? '0') + BigInt(provisional?.amount ?? '0')).toString() as Amount,
    inFlightIncreasing: pending?.in_flight ?? 0,
    sleeves,
    feesLamports: (flows?.fees ?? '0').split('.')[0] as Amount,
    consecutiveLosses,
    dayStartEquity: (day?.equity as Amount | null) ?? null,
    rollingHighEquity: (high?.equity as Amount | null) ?? null,
  };
}

/** Feed classes blocking entries and any active runtime pause: the paper book obeys the same kill conditions (§13.6). */
export async function entryHealth(sql: Sql): Promise<{ feedsBlockEntries: boolean; entriesPaused: boolean }> {
  const [feeds] = await sql<{ n: number }[]>`select count(*)::int as n from ops.provider_health where effect_on_entries = 'BLOCK'`;
  const [paused] = await sql<{ n: number }[]>`select count(*)::int as n from ops.runtime_sessions where (paused->>'active')::boolean and activity_state <> 'OFF'`;
  return { feedsBlockEntries: (feeds?.n ?? 0) > 0, entriesPaused: (paused?.n ?? 0) > 0 };
}

/** Inserts the evaluation and links it to its cycle in one transaction; a cycle is evaluated once. */
export async function recordRiskEvaluation(sql: Sql, e: RiskEvaluation): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`
      insert into trading.risk_evaluations (id, proposal_id, action_cycle_id, policy_version, allowed, reason_codes, settlement_mint, equity_base_units, equity_usd, exposure_base_units, cohort_exposure, cluster_exposure, sleeve_exposure,
        asset_eligibility_evaluation_id, computed_max_loss_base_units, computed_position_amount, max_slippage_bps, max_price_impact_bps, stop_policy, target_policy, daily_drawdown_fraction, circuit_breaker_tripped, stale_data_checks, created_at)
      values (${e.id}, ${e.proposalId}, ${e.actionCycleId}, ${e.policyVersion}, ${e.allowed}, ${e.reasonCodes}, ${e.settlementMint}, ${e.equityBaseUnits}, ${e.equityUsd}, ${e.exposureBaseUnits}, ${t.json(asJson(e.cohortExposure))}, ${t.json(asJson(e.clusterExposure))}, ${e.sleeveExposure},
        ${e.assetEligibilityEvaluationId}, ${e.computedMaxLossBaseUnits}, ${e.computedPositionAmount}, ${e.maxSlippageBps}, ${e.maxPriceImpactBps}, ${e.stopPolicy ? t.json(asJson(e.stopPolicy)) : null}, ${e.targetPolicy ? t.json(asJson(e.targetPolicy)) : null}, ${e.dailyDrawdownFraction}, ${e.circuitBreakerTripped}, ${t.json(asJson(e.staleDataChecks))}, ${e.createdAt})`;
    const updated = await t<{ id: string }[]>`update agents.action_cycles set risk_evaluation_id = ${e.id} where id = ${e.actionCycleId} and risk_evaluation_id is null returning id`;
    if (updated.length === 0) throw new Error(`cycle ${e.actionCycleId} already evaluated`);
  });
}

export async function createIntent(sql: Sql, i: TradeIntent, lifecycle: 'CREATED' | 'AUTHORIZED'): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`
      insert into trading.intents (id, idempotency_key, account_id, strategy_version_id, sleeve_id, asset_id, action, side, exposure_effect, input_mint, output_mint, max_input_amount, risk_evaluation_id, action_cycle_id, cleared_cutoff_version, constraints, protection_policy_ref, target_lot_ids, approval_required, lifecycle_state, created_at, expires_at)
      values (${i.id}, ${i.idempotencyKey}, ${i.accountId}, ${i.strategyVersionId}, ${i.sleeveId}, ${i.assetId}, ${i.action}, ${i.side}, ${i.exposureEffect}, ${i.inputMint}, ${i.outputMint}, ${i.maxInputAmount}, ${i.riskEvaluationId}, ${i.actionCycleId}, ${i.clearedCutoffVersion}, ${t.json(asJson(i.constraints))}, ${i.protectionPolicyRef}, ${i.targetLotIds}, ${i.approvalRequired}, ${lifecycle}, ${i.createdAt}, ${i.expiresAt})`;
    await t`update agents.action_cycles set intent_id = ${i.id} where id = ${i.actionCycleId}`;
  });
}

export async function setIntentState(sql: Sql, intentId: Uuid, state: TradeIntentState): Promise<void> {
  await sql`update trading.intents set lifecycle_state = ${state} where id = ${intentId}`;
}
export type TradeIntentState = 'CREATED' | 'AUTHORIZED' | 'APPROVED' | 'EXECUTING' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED' | 'FAILED';

/** The signed-not-submitted journal write (D12): order and attempt exist before any (modelled) submission. */
export async function journalAttempt(sql: Sql, order: Order, a: OrderAttempt): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`
      insert into trading.orders (id, intent_id, authorization_hash, execution_path, transaction_class, created_at)
      values (${order.id}, ${order.intentId}, ${order.authorizationHash}, ${order.executionPath}, ${order.transactionClass}, ${order.createdAt})
      on conflict (id) do nothing`;
    await t`
      insert into trading.order_attempts (id, order_id, intent_id, authorization_hash, attempt_number, state, jupiter_request_id, router, signed_tx_hash, wallet_signature, expected_tx_signature, blockhash, last_valid_block_height, quote_expires_at, signed_at, submitted_at, submissions, confirmed_at, confirmed_slot, finalized_at, finalized_slot, reorg_detected_at, not_landed_reason, reconciliation_outcome, created_at)
      values (${a.id}, ${a.orderId}, ${a.intentId}, ${a.authorizationHash}, ${a.attemptNumber}, ${a.state}, ${a.jupiterRequestId}, ${a.router}, ${a.signedTxHash}, ${a.walletSignature}, ${a.expectedTxSignature}, ${a.blockhash}, ${a.lastValidBlockHeight}, ${a.quoteExpiresAt}, ${a.signedAt}, ${a.submittedAt}, ${t.json(asJson(a.submissions))}, ${a.confirmedAt}, ${a.confirmedSlot}, ${a.finalizedAt}, ${a.finalizedSlot}, ${a.reorgDetectedAt}, ${a.notLandedReason}, ${a.reconciliationOutcome}, ${a.createdAt})`;
  });
}

/** Terminal attempt state plus its fill, atomically. A pre-submit rejection has no journaled row; it is inserted here so the refusal is visible. */
export async function finishAttempt(sql: Sql, order: Order, a: OrderAttempt, fill: Fill | null): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`insert into trading.orders (id, intent_id, authorization_hash, execution_path, transaction_class, created_at) values (${order.id}, ${order.intentId}, ${order.authorizationHash}, ${order.executionPath}, ${order.transactionClass}, ${order.createdAt}) on conflict (id) do nothing`;
    await t`
      insert into trading.order_attempts (id, order_id, intent_id, authorization_hash, attempt_number, state, jupiter_request_id, router, signed_tx_hash, wallet_signature, expected_tx_signature, blockhash, last_valid_block_height, quote_expires_at, signed_at, submitted_at, submissions, confirmed_at, confirmed_slot, finalized_at, finalized_slot, reorg_detected_at, not_landed_reason, reconciliation_outcome, created_at)
      values (${a.id}, ${a.orderId}, ${a.intentId}, ${a.authorizationHash}, ${a.attemptNumber}, ${a.state}, ${a.jupiterRequestId}, ${a.router}, ${a.signedTxHash}, ${a.walletSignature}, ${a.expectedTxSignature}, ${a.blockhash}, ${a.lastValidBlockHeight}, ${a.quoteExpiresAt}, ${a.signedAt}, ${a.submittedAt}, ${t.json(asJson(a.submissions))}, ${a.confirmedAt}, ${a.confirmedSlot}, ${a.finalizedAt}, ${a.finalizedSlot}, ${a.reorgDetectedAt}, ${a.notLandedReason}, ${a.reconciliationOutcome}, ${a.createdAt})
      on conflict (id) do update set state = excluded.state, submitted_at = excluded.submitted_at, submissions = excluded.submissions, confirmed_at = excluded.confirmed_at, confirmed_slot = excluded.confirmed_slot,
        finalized_at = excluded.finalized_at, finalized_slot = excluded.finalized_slot, reorg_detected_at = excluded.reorg_detected_at, not_landed_reason = excluded.not_landed_reason, reconciliation_outcome = excluded.reconciliation_outcome`;
    if (fill) {
      await t`
        insert into trading.fills (id, order_attempt_id, tx_signature, commitment, slot, input_mint, output_mint, input_amount, output_amount, fees, execution_shortfall_bps, execution_path, lot_allocations, filled_at)
        values (${fill.id}, ${fill.orderAttemptId}, ${fill.txSignature}, ${fill.commitment}, ${fill.slot}, ${fill.inputMint}, ${fill.outputMint}, ${fill.inputAmount}, ${fill.outputAmount}, ${t.json(asJson(fill.fees))}, ${fill.executionShortfallBps}, ${fill.executionPath}, ${t.json(asJson(fill.lotAllocations))}, ${fill.filledAt})`;
    }
  });
}

/** Opens the position with its first lot and commits the sleeve, atomically (D24, D44). */
export async function openPosition(sql: Sql, p: Position, lot: PositionLot): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`
      insert into trading.positions (id, account_id, asset_id, mint, quantity, average_entry_price, cost_basis_base_units, realized_pnl_base_units, unrealized_pnl_base_units, stop, target, unreviewed_stop, custody_split, status, review_state, review_state_reason, review_state_since, last_reviewed_cycle_id, next_reassessment_at, safety_state, opened_at, closed_at)
      values (${p.id}, ${p.accountId}, ${p.assetId}, ${p.mint}, ${p.quantity}, ${p.averageEntryPrice}, ${p.costBasisBaseUnits}, ${p.realizedPnlBaseUnits}, ${p.unrealizedPnlBaseUnits}, ${p.stop ? t.json(asJson(p.stop)) : null}, ${p.target ? t.json(asJson(p.target)) : null}, ${p.unreviewedStop}, ${t.json(asJson(p.custodySplit))}, ${p.status}, ${p.reviewState}, ${p.reviewStateReason}, ${p.reviewStateSince}, ${p.lastReviewedCycleId}, ${p.nextReassessmentAt}, ${p.safetyState}, ${p.openedAt}, ${p.closedAt})`;
    await t`
      insert into trading.position_lots (id, position_id, sleeve_id, strategy_version_id, asset_id, mint, quantity, cost_basis_base_units, entry_intent_id, entry_fill_ids, exit_fill_ids, realized_pnl_base_units, protection_mode, provider_order_id, reserved_for_protection, status, opened_at, closed_at)
      values (${lot.id}, ${lot.positionId}, ${lot.sleeveId}, ${lot.strategyVersionId}, ${lot.assetId}, ${lot.mint}, ${lot.quantity}, ${lot.costBasisBaseUnits}, ${lot.entryIntentId}, ${lot.entryFillIds}, ${lot.exitFillIds}, ${lot.realizedPnlBaseUnits}, ${lot.protectionMode}, ${lot.providerOrderId}, ${lot.reservedForProtection}, ${lot.status}, ${lot.openedAt}, ${lot.closedAt})`;
    await t`update trading.strategy_sleeves set committed_base_units = committed_base_units + ${lot.costBasisBaseUnits}::core.amount where id = ${lot.sleeveId}`;
  });
}

export async function insertPortfolioSnapshot(sql: Sql, s: PortfolioSnapshot): Promise<void> {
  await sql`
    insert into trading.portfolio_snapshots (id, account_id, as_of, settlement_mint, equity_base_units, equity_usd, exposure_base_units, exposure_fraction, per_sleeve, per_cohort, drawdown, created_at)
    values (${s.id}, ${s.accountId}, ${s.asOf}, ${s.settlementMint}, ${s.equityBaseUnits}, ${s.equityUsd}, ${s.exposureBaseUnits}, ${s.exposureFraction}, ${sql.json(asJson(s.perSleeve))}, ${sql.json(asJson(s.perCohort))}, ${sql.json(asJson(s.drawdown))}, ${s.createdAt})`;
}

function iso(v: unknown): Instant {
  return new Date(v as string).toISOString() as Instant;
}
