import { toInstant, type AssetEligibility, type Instant, type IntelligenceEvent, type QuoteProbe, type ReplayDecision, type ReplayResults, type ReplayRun, type Sha256Hex, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { asJson, type Sql } from './sql.js';

/**
 * Replay run storage (blueprint §18.5, P9; execution plan M10). Runs, their decisions and their
 * closed trades are research rows: written by the worker's replay role, read by the Replay Lab
 * under RLS. A completed run is immutable; re-running the same inputs is a new run whose digest
 * either matches or does not.
 */

const iso = (v: unknown): Instant => toInstant(new Date(v as string));

export async function insertReplayRun(sql: Sql, run: ReplayRun, extra: { controlRequestId: Uuid | null; assetIds: Uuid[] | null }): Promise<void> {
  await sql`
    insert into research.replay_runs (id, name, fidelity, status, requested_by, control_request_id, window_from, window_to, dataset_cutoff, in_sample_until, strategy_version_ids, baseline_strategy_version_id, versions, models, seed, latency_matched_baseline, proposer_only_shadow, calibration_target, asset_ids, created_at)
    values (${run.id}, ${run.name}, ${run.fidelity}, ${run.status}, ${run.requestedBy}, ${extra.controlRequestId}, ${run.window.from}, ${run.window.to}, ${run.window.datasetCutoff}, ${run.window.inSampleUntil}, ${run.strategyVersionIds as string[]}::core.version_id[], ${run.baselineStrategyVersionId}, ${sql.json(asJson(run.versions))}, ${sql.json(asJson(run.models))}, ${run.seed}, ${run.latencyMatchedBaseline}, ${run.proposerOnlyShadow}, ${sql.json(asJson(run.calibrationTarget))}, ${extra.assetIds === null ? null : (extra.assetIds as string[])}::uuid[], ${run.createdAt})`;
}

export interface ReplayRunRow {
  run: ReplayRun;
  assetIds: Uuid[] | null;
  controlRequestId: Uuid | null;
  results: ReplayResults | null;
}

function rowToRun(r: Record<string, unknown>): ReplayRunRow {
  return {
    run: {
      id: r['id'] as Uuid,
      name: r['name'] as string,
      fidelity: r['fidelity'] as ReplayRun['fidelity'],
      status: r['status'] as ReplayRun['status'],
      requestedBy: (r['requested_by'] as Uuid | null) ?? null,
      window: { from: iso(r['window_from']), to: iso(r['window_to']), datasetCutoff: iso(r['dataset_cutoff']), inSampleUntil: r['in_sample_until'] ? iso(r['in_sample_until']) : null },
      strategyVersionIds: r['strategy_version_ids'] as VersionId[],
      baselineStrategyVersionId: r['baseline_strategy_version_id'] as VersionId,
      versions: r['versions'] as ReplayRun['versions'],
      models: r['models'] as ReplayRun['models'],
      seed: Number(r['seed']),
      latencyMatchedBaseline: r['latency_matched_baseline'] as boolean,
      proposerOnlyShadow: r['proposer_only_shadow'] as boolean,
      calibrationTarget: r['calibration_target'] as ReplayRun['calibrationTarget'],
      createdAt: iso(r['created_at']),
      startedAt: r['started_at'] ? iso(r['started_at']) : null,
      completedAt: r['completed_at'] ? iso(r['completed_at']) : null,
      decisionsDigest: (r['decisions_digest'] as Sha256Hex | null) ?? null,
      resultsDigest: (r['results_digest'] as Sha256Hex | null) ?? null,
      error: (r['error'] as string | null) ?? null,
    },
    assetIds: (r['asset_ids'] as Uuid[] | null) ?? null,
    controlRequestId: (r['control_request_id'] as Uuid | null) ?? null,
    results: (r['results'] as ReplayResults | null) ?? null,
  };
}

/** The oldest queued run, claimed as RUNNING in the same statement so two workers never run it twice. */
export async function claimQueuedReplayRun(sql: Sql, now: Instant): Promise<ReplayRunRow | null> {
  const [r] = await sql<Record<string, unknown>[]>`
    update research.replay_runs set status = 'RUNNING', started_at = ${now}
    where id = (select id from research.replay_runs where status = 'QUEUED' order by created_at asc limit 1 for update skip locked)
    returning *`;
  return r ? rowToRun(r) : null;
}

export async function completeReplayRun(sql: Sql, id: Uuid, done: { decisionsDigest: Sha256Hex; resultsDigest: Sha256Hex; results: ReplayResults; models: ReplayRun['models']; completedAt: Instant }): Promise<void> {
  await sql`update research.replay_runs set status = 'COMPLETED', completed_at = ${done.completedAt}, decisions_digest = ${done.decisionsDigest}, results_digest = ${done.resultsDigest}, results = ${sql.json(asJson(done.results))}, models = ${sql.json(asJson(done.models))} where id = ${id} and status = 'RUNNING'`;
}

export async function failReplayRun(sql: Sql, id: Uuid, error: string, at: Instant): Promise<void> {
  await sql`update research.replay_runs set status = 'FAILED', completed_at = ${at}, error = ${error.slice(0, 2000)} where id = ${id} and status = 'RUNNING'`;
}

export async function insertReplayDecisions(sql: Sql, rows: readonly ReplayDecision[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((d) => ({
      id: d.id,
      run_id: d.runId,
      strategy_version_id: d.strategyVersionId,
      variant: d.variant,
      at: d.at,
      candidate_id: d.candidateId,
      asset_id: d.assetId,
      sample: d.sample,
      cycle_state: d.cycleState,
      action: d.action,
      proposer_confidence: d.proposerConfidence,
      adversary_verdict: d.adversaryVerdict,
      reason_codes: d.reasonCodes,
      decision_latency_ms: d.decisionLatencyMs,
      rejection: d.rejection,
      fill: d.fill === null ? null : sql.json(asJson(d.fill)),
      outcome: d.outcome === null ? null : sql.json(asJson(d.outcome)),
    }));
    const inserted = await sql`insert into research.replay_decisions ${sql(chunk as never[])} returning id`;
    n += inserted.length;
  }
  return n;
}

export interface ReplayTradeRow {
  id: Uuid;
  runId: Uuid;
  strategyVersionId: VersionId;
  variant: 'FULL' | 'PROPOSER_ONLY' | 'LATENCY_MATCHED';
  sample: 'IN_SAMPLE' | 'HOLD_OUT';
  assetId: Uuid;
  candidateId: Uuid | null;
  openedAt: Instant;
  closedAt: Instant;
  cost: number;
  proceeds: number;
  fees: number;
  slippageCost: number;
  executionShortfallBps: number | null;
  executionPath: string;
  exitReason: string;
  decisionToFillMs: number | null;
  attributes: Record<string, unknown>;
}

export async function insertReplayTrades(sql: Sql, rows: readonly ReplayTradeRow[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((t) => ({
      id: t.id,
      run_id: t.runId,
      strategy_version_id: t.strategyVersionId,
      variant: t.variant,
      sample: t.sample,
      asset_id: t.assetId,
      candidate_id: t.candidateId,
      opened_at: t.openedAt,
      closed_at: t.closedAt,
      cost: t.cost,
      proceeds: t.proceeds,
      fees: t.fees,
      slippage_cost: t.slippageCost,
      execution_shortfall_bps: t.executionShortfallBps,
      execution_path: t.executionPath,
      exit_reason: t.exitReason,
      decision_to_fill_ms: t.decisionToFillMs,
      attributes: sql.json(asJson(t.attributes)),
    }));
    const inserted = await sql`insert into research.replay_trades ${sql(chunk as never[])} returning id`;
    n += inserted.length;
  }
  return n;
}

export async function listReplayRuns(sql: Sql, limit = 50): Promise<ReplayRunRow[]> {
  const rows = await sql<Record<string, unknown>[]>`select * from research.replay_runs order by created_at desc limit ${limit}`;
  return rows.map(rowToRun);
}

export async function loadReplayRun(sql: Sql, id: Uuid): Promise<ReplayRunRow | null> {
  const [r] = await sql<Record<string, unknown>[]>`select * from research.replay_runs where id = ${id}`;
  return r ? rowToRun(r) : null;
}

// --- dataset loaders (Level A/B inputs for one window) -------------------------------------------

export interface ReplayAssetRow {
  id: Uuid;
  mint: string;
  symbol: string;
  decimals: number;
  tokenProgram: 'TOKEN' | 'TOKEN_2022' | 'UNKNOWN';
}

/** Assets with at least one 1m candle in the window, or the requested subset of them. */
export async function listReplayAssets(sql: Sql, from: Instant, to: Instant, assetIds: readonly Uuid[] | null, limit = 200): Promise<ReplayAssetRow[]> {
  const rows = await sql<{ id: Uuid; mint_address: string; symbol: string; decimals: number; token_program: string | null }[]>`
    select a.id, a.mint_address, a.symbol, a.decimals, a.token_program
    from core.assets a
    where exists (select 1 from market.candles c where c.asset_id = a.id and c.resolution = '1m' and c.bucket_time >= ${from} and c.bucket_time < ${to})
      and (${assetIds === null} or a.id = any(${(assetIds ?? []) as unknown as string[]}::uuid[]))
    order by a.symbol limit ${limit}`;
  return rows.map((r) => ({ id: r.id, mint: r.mint_address, symbol: r.symbol, decimals: r.decimals, tokenProgram: r.token_program === 'TOKEN_2022' ? 'TOKEN_2022' : r.token_program === 'TOKEN' ? 'TOKEN' : 'UNKNOWN' }));
}

export async function listEligibilityBetween(sql: Sql, assetId: Uuid, from: Instant, to: Instant): Promise<AssetEligibility[]> {
  const rows = await sql<Record<string, unknown>[]>`select * from core.asset_eligibility where asset_id = ${assetId} and evaluated_at >= ${from} and evaluated_at <= ${to} order by evaluated_at asc`;
  return rows.map((r) => {
    const freshness = r['freshness'] as { securityProviderAt: string | null; chainReadAt: string; chainSlot: number };
    return {
      id: r['id'] as Uuid,
      assetId: r['asset_id'] as Uuid,
      evaluatedAt: iso(r['evaluated_at']),
      policyVersion: r['policy_version'] as AssetEligibility['policyVersion'],
      eligible: r['eligible'] as boolean,
      hardReject: r['hard_reject'] as boolean,
      rejectionReasons: r['rejection_reasons'] as AssetEligibility['rejectionReasons'],
      grade: r['grade'] as number | null,
      liquidityUsd: r['liquidity_usd'] as number | null,
      volume24hUsd: r['volume_24h_usd'] as number | null,
      holderCount: r['holder_count'] as number | null,
      concentration: r['concentration'] as AssetEligibility['concentration'],
      mintAuthority: r['mint_authority'] as AssetEligibility['mintAuthority'],
      freezeAuthority: r['freeze_authority'] as AssetEligibility['freezeAuthority'],
      token2022: r['token2022'] as AssetEligibility['token2022'],
      securityFlags: r['security_flags'] as AssetEligibility['securityFlags'],
      transferRestrictions: r['transfer_restrictions'] as AssetEligibility['transferRestrictions'],
      jupiterRouteAvailable: r['jupiter_route_available'] as boolean,
      settlementRouteConfirmed: r['settlement_route_confirmed'] as boolean,
      priceImpactProbes: r['price_impact_probes'] as AssetEligibility['priceImpactProbes'],
      insiderMetrics: r['insider_metrics'] as AssetEligibility['insiderMetrics'],
      emergencyExitRouteSnapshotId: r['emergency_exit_route_snapshot_id'] as Uuid | null,
      freshness: { securityProviderAt: freshness.securityProviderAt, chainReadAt: freshness.chainReadAt, chainSlot: freshness.chainSlot } as AssetEligibility['freshness'],
    };
  });
}

export async function listQuoteProbesBetween(sql: Sql, assetId: Uuid, from: Instant, to: Instant): Promise<QuoteProbe[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select id, asset_id, provider, purpose, input_mint, output_mint, input_amount::text as input_amount, expected_output_amount::text as expected_output_amount, min_output_amount::text as min_output_amount, price_impact_bps, slippage_bps, router_label, route_program_ids, uses_address_lookup_tables, quoted_at, observed_at, action_cycle_id, intent_id, position_id, order_attempt_id
    from market.quote_probes where asset_id = ${assetId} and quoted_at >= ${from} and quoted_at <= ${to} order by quoted_at asc`;
  return rows.map((r) => ({
    id: r['id'] as Uuid,
    assetId: (r['asset_id'] as Uuid | null) ?? null,
    provider: r['provider'] as QuoteProbe['provider'],
    purpose: r['purpose'] as QuoteProbe['purpose'],
    inputMint: r['input_mint'] as QuoteProbe['inputMint'],
    outputMint: r['output_mint'] as QuoteProbe['outputMint'],
    inputAmount: r['input_amount'] as QuoteProbe['inputAmount'],
    expectedOutputAmount: r['expected_output_amount'] as QuoteProbe['expectedOutputAmount'],
    minOutputAmount: r['min_output_amount'] as QuoteProbe['minOutputAmount'],
    priceImpactBps: r['price_impact_bps'] as QuoteProbe['priceImpactBps'],
    slippageBps: r['slippage_bps'] as QuoteProbe['slippageBps'],
    routerLabel: (r['router_label'] as string | null) ?? null,
    routeProgramIds: (r['route_program_ids'] as QuoteProbe['routeProgramIds']) ?? [],
    usesAddressLookupTables: r['uses_address_lookup_tables'] as boolean,
    quotedAt: iso(r['quoted_at']),
    observedAt: iso(r['observed_at']),
    actionCycleId: (r['action_cycle_id'] as Uuid | null) ?? null,
    intentId: (r['intent_id'] as Uuid | null) ?? null,
    positionId: (r['position_id'] as Uuid | null) ?? null,
    orderAttemptId: (r['order_attempt_id'] as Uuid | null) ?? null,
  }));
}

/** Events first seen inside the window (plus a lookback), as the intelligence layer stored them. */
export async function listEventsBetween(sql: Sql, from: Instant, to: Instant, limit = 5000): Promise<IntelligenceEvent[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select e.*, (select array_remove(array_agg(x.asset_id), null) from intelligence.event_assets x where x.event_id = e.id) as asset_ids
    from intelligence.events e where e.first_seen_at >= ${from} and e.first_seen_at <= ${to} order by e.first_seen_at asc limit ${limit}`;
  return rows.map((r) => ({
    id: r['id'] as Uuid,
    kind: r['kind'] as IntelligenceEvent['kind'],
    sourceProvider: r['source_provider'] as string,
    sourceId: r['source_id'] as string,
    sourceUrlHash: (r['source_url_hash'] as IntelligenceEvent['sourceUrlHash']) ?? null,
    sourcePublishedAt: r['source_published_at'] ? iso(r['source_published_at']) : null,
    sourceTimeConfidence: r['source_time_confidence'] as IntelligenceEvent['sourceTimeConfidence'],
    firstSeenAt: iso(r['first_seen_at']),
    lastSeenAt: iso(r['last_seen_at']),
    assetIds: (r['asset_ids'] as Uuid[]) ?? [],
    title: (r['title'] as string | null) ?? null,
    summary: (r['summary'] as string | null) ?? null,
    sourceQuality: r['source_quality'] as IntelligenceEvent['sourceQuality'],
    noveltyScore: (r['novelty_score'] as number | null) ?? null,
    sentiment: (r['sentiment'] as IntelligenceEvent['sentiment']) ?? null,
    classification: (r['classification'] as string | null) ?? null,
    clusterId: (r['cluster_id'] as Uuid | null) ?? null,
    corroboratesEventId: (r['corroborates_event_id'] as Uuid | null) ?? null,
    payloadHash: r['payload_hash'] as IntelligenceEvent['payloadHash'],
    rawPayloadRef: (r['raw_payload_ref'] as string | null) ?? null,
  }) as IntelligenceEvent);
}

export interface RecordedDecisionRow {
  candidateId: Uuid;
  strategyVersionId: VersionId;
  cycle: { id: Uuid; state: string; startedAt: Instant; verdict: string | null; reasonCodes: string[] };
  proposal: { proposal: Record<string, unknown>; expiresAt: Instant } | null;
  review: { verdict: string; objections: { code: string }[]; confidence: number | null } | null;
  decidedAt: Instant;
}

/** Level B: the live worker's candidate cycles inside the window with their proposal and blocking review, for the recorded-S1 strategy. */
export async function listRecordedDecisionsBetween(sql: Sql, strategyVersionIds: readonly VersionId[], from: Instant, to: Instant, limit = 5000): Promise<RecordedDecisionRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select c.id, c.candidate_id, c.strategy_version_id, c.state, c.started_at, c.terminal_at, c.updated_at, c.verdict, c.reason_codes,
      (select jsonb_build_object('proposal', p.proposal, 'expires_at', p.expires_at) from trading.proposals p where p.action_cycle_id = c.id order by p.created_at desc limit 1) as proposal,
      (select jsonb_build_object('verdict', v.verdict, 'objections', v.objections, 'confidence', v.confidence) from agents.adversarial_reviews v where v.action_cycle_id = c.id and v.blocking order by v.created_at desc limit 1) as review
    from agents.action_cycles c
    where c.candidate_id is not null and c.strategy_version_id = any(${strategyVersionIds as unknown as string[]}::core.version_id[]) and c.started_at >= ${from} and c.started_at <= ${to}
    order by c.started_at asc limit ${limit}`;
  return rows.map((r) => {
    const proposal = r['proposal'] as { proposal: Record<string, unknown>; expires_at: string } | null;
    const review = r['review'] as { verdict: string; objections: { code: string }[]; confidence: number | null } | null;
    return {
      candidateId: r['candidate_id'] as Uuid,
      strategyVersionId: r['strategy_version_id'] as VersionId,
      cycle: { id: r['id'] as Uuid, state: r['state'] as string, startedAt: iso(r['started_at']), verdict: (r['verdict'] as string | null) ?? null, reasonCodes: (r['reason_codes'] as string[]) ?? [] },
      proposal: proposal ? { proposal: proposal.proposal, expiresAt: iso(proposal.expires_at) } : null,
      review: review ? { verdict: review.verdict, objections: review.objections ?? [], confidence: review.confidence ?? null } : null,
      decidedAt: iso(r['terminal_at'] ?? r['updated_at']),
    };
  });
}

/** A feature's value series for one mint (the SOL reference 1h return for relative strength), keyed by as_of. */
export async function listFeatureValuesByMint(sql: Sql, mint: string, feature: string, from: Instant, to: Instant): Promise<{ asOf: Instant; value: number }[]> {
  const rows = await sql<{ as_of: string; value: number | null }[]>`
    select s.as_of, (s.features ->> ${feature})::double precision as value
    from signals.feature_snapshots s join core.assets a on a.id = s.asset_id
    where a.mint_address = ${mint} and s.as_of >= ${from} and s.as_of <= ${to} order by s.as_of asc`;
  return rows.filter((r) => r.value !== null).map((r) => ({ asOf: iso(r.as_of), value: r.value as number }));
}

/** Direct model cost per strategy version inside a window (D37 layer 2): every agents.runs row joined to its cycle's strategy. */
export async function modelCostByStrategyBetween(sql: Sql, from: Instant, to: Instant): Promise<Record<string, { modelUsd: number; runs: number }>> {
  const rows = await sql<{ strategy_version_id: string; model_usd: number; runs: number }[]>`
    select c.strategy_version_id, coalesce(sum(r.cost_usd), 0)::double precision as model_usd, count(*)::int as runs
    from agents.runs r join agents.action_cycles c on c.id = r.action_cycle_id
    where r.created_at >= ${from} and r.created_at <= ${to}
    group by c.strategy_version_id`;
  return Object.fromEntries(rows.map((r) => [r.strategy_version_id, { modelUsd: Number(r.model_usd), runs: Number(r.runs) }]));
}
