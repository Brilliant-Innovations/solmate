import { SignedApprovalGrant, type ActivityState, type Amount, type Bps, type CapitalAuthority, type Fill, type Instant, type MintAddress, type Order, type OrderAttempt, type Quote, type SolanaAddress, type TradeIntent, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { Sql } from './sql.js';
import { finishAttempt, journalAttempt, setIntentState, type TradeIntentState } from './paper-repo.js';

/**
 * The executor's database reads and its reconciliation writes (blueprint §15.3 step 1, §15.10,
 * §21.3). Reads return the immutable rows the executor verifies against the signed envelope; it
 * never treats them as authority. Writes are best effort after the executor journal already
 * holds the truth: a failed write leaves the journal line to be reconciled later.
 */

const iso = (v: unknown): Instant => new Date(v as string).toISOString() as Instant;

export async function loadTradeIntent(sql: Sql, id: Uuid): Promise<TradeIntent | null> {
  const rows = await sql<Record<string, unknown>[]>`
    select id, idempotency_key, account_id, strategy_version_id, sleeve_id, asset_id, action, side, exposure_effect, input_mint, output_mint, max_input_amount::text as max_input_amount,
           risk_evaluation_id, action_cycle_id, cleared_cutoff_version, constraints, protection_policy_ref, target_lot_ids, approval_required, created_at, expires_at
    from trading.intents where id = ${id}`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r['id'] as Uuid,
    idempotencyKey: r['idempotency_key'] as TradeIntent['idempotencyKey'],
    accountId: r['account_id'] as Uuid,
    strategyVersionId: r['strategy_version_id'] as VersionId,
    sleeveId: (r['sleeve_id'] as Uuid | null) ?? null,
    assetId: r['asset_id'] as Uuid,
    action: r['action'] as TradeIntent['action'],
    side: r['side'] as TradeIntent['side'],
    exposureEffect: r['exposure_effect'] as TradeIntent['exposureEffect'],
    inputMint: r['input_mint'] as MintAddress,
    outputMint: r['output_mint'] as MintAddress,
    maxInputAmount: r['max_input_amount'] as Amount,
    riskEvaluationId: r['risk_evaluation_id'] as Uuid,
    actionCycleId: r['action_cycle_id'] as Uuid,
    clearedCutoffVersion: r['cleared_cutoff_version'] as number,
    constraints: r['constraints'] as TradeIntent['constraints'],
    protectionPolicyRef: (r['protection_policy_ref'] as VersionId | null) ?? null,
    targetLotIds: (r['target_lot_ids'] as Uuid[]) ?? [],
    approvalRequired: r['approval_required'] as boolean,
    createdAt: iso(r['created_at']),
    expiresAt: iso(r['expires_at']),
  };
}

/** The newest unrevoked approval envelope for an intent; the executor verifies its signature and binding itself. */
export async function loadApprovalGrant(sql: Sql, intentId: Uuid): Promise<SignedApprovalGrant | null> {
  const rows = await sql<{ envelope: unknown }[]>`select envelope from trading.approvals where intent_id = ${intentId} and revoked_at is null order by granted_at desc limit 1`;
  const r = rows[0];
  if (!r) return null;
  const parsed = SignedApprovalGrant.safeParse(r.envelope);
  return parsed.success ? parsed.data : null;
}

export interface ExecutorModeRow {
  sessionId: Uuid | null;
  activity: ActivityState;
  authority: CapitalAuthority;
  paused: boolean;
}

/** The open runtime session's gate facts (§6.22A). No open session reads as OFF/OBSERVE/paused: entries stop. */
export async function executorModeFacts(sql: Sql): Promise<ExecutorModeRow> {
  const rows = await sql<{ id: Uuid; activity_state: ActivityState; capital_authority: CapitalAuthority; paused: { active: boolean } }[]>`
    select id, activity_state, capital_authority, paused from ops.runtime_sessions where activity_state <> 'OFF' order by updated_at desc limit 1`;
  const r = rows[0];
  if (!r) return { sessionId: null, activity: 'OFF', authority: 'OBSERVE', paused: true };
  return { sessionId: r.id, activity: r.activity_state, authority: r.capital_authority, paused: r.paused.active === true };
}

/** The DECISION quote captured for a cycle (§18.1 Level B): the reference for the executor's chase check. */
export async function decisionQuoteForCycle(sql: Sql, actionCycleId: Uuid): Promise<Quote | null> {
  const rows = await sql<Record<string, unknown>[]>`
    select provider, input_mint, output_mint, input_amount::text as input_amount, expected_output_amount::text as expected_output_amount, min_output_amount::text as min_output_amount,
           price_impact_bps, slippage_bps, router_label, route_program_ids, uses_address_lookup_tables, quoted_at
    from market.quote_probes where action_cycle_id = ${actionCycleId} and purpose = 'DECISION' order by quoted_at desc limit 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    provider: r['provider'] as Quote['provider'],
    providerRequestId: null,
    routerLabel: (r['router_label'] as string | null) ?? null,
    inputMint: r['input_mint'] as MintAddress,
    outputMint: r['output_mint'] as MintAddress,
    inputAmount: r['input_amount'] as Amount,
    expectedOutputAmount: r['expected_output_amount'] as Amount,
    minOutputAmount: r['min_output_amount'] as Amount,
    priceImpactBps: (r['price_impact_bps'] as Bps | null) ?? null,
    slippageBps: r['slippage_bps'] as Bps,
    routeProgramIds: ((r['route_program_ids'] as string[]) ?? []) as SolanaAddress[],
    usesAddressLookupTables: r['uses_address_lookup_tables'] as boolean,
    quotedAt: iso(r['quoted_at']),
    expiresAt: null,
    lastValidBlockHeight: null,
  };
}

/** Executor → Postgres reconciliation of one attempt (§15.10 "reconciled into Postgres when service returns"). */
export async function persistExecution(sql: Sql, order: Order, attempt: OrderAttempt, fill: Fill | null, lifecycle: TradeIntentState | null): Promise<void> {
  if (attempt.state === 'SIGNED_NOT_SUBMITTED' || attempt.state === 'SUBMITTED') await journalAttempt(sql, order, attempt);
  else await finishAttempt(sql, order, attempt, fill);
  if (lifecycle) await setIntentState(sql, order.intentId, lifecycle);
}
