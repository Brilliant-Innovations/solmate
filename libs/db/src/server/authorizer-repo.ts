import { SignedRiskStateProjection, type ActionCycle, type Amount, type Instant, type MintAddress, type Nonce, type Proposal, type Release, type ReleaseAttestation, type RiskEvaluation, type Sequence, type Sha256Hex, type SignedRiskAuthorizedIntent, type SolanaAddress, type SolanaCluster, type TradeIntent, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { writeAuditEvent } from './audit.js';
import { createIntent, recordRiskEvaluation } from './paper-repo.js';
import { asJson, type Sql } from './sql.js';

/**
 * The risk-authorizer's database reads and its two writes (blueprint §13.7, §15.5, D21, D52).
 * Reads hand back immutable rows the authorizer verifies (signatures, digests, sequences) and
 * never trusts as authority; the only writes are the evaluation + intent + stored envelope after
 * a signature, and an audit line for a denial.
 */

const iso = (v: unknown): Instant => new Date(v as string).toISOString() as Instant;
const isoOrNull = (v: unknown): Instant | null => (v === null || v === undefined ? null : iso(v));

export async function loadActionCycle(sql: Sql, id: Uuid): Promise<ActionCycle | null> {
  const rows = await sql<Record<string, unknown>[]>`select * from agents.action_cycles where id = ${id}`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r['id'] as Uuid,
    automationRunId: (r['automation_run_id'] as Uuid | null) ?? null,
    triggerId: r['trigger_id'] as Uuid,
    candidateId: (r['candidate_id'] as Uuid | null) ?? null,
    positionId: (r['position_id'] as Uuid | null) ?? null,
    strategyVersionId: r['strategy_version_id'] as VersionId,
    skillVersionId: (r['skill_version_id'] as VersionId | null) ?? null,
    guidelineVersionId: (r['guideline_version_id'] as VersionId | null) ?? null,
    speedTier: r['speed_tier'] as ActionCycle['speedTier'],
    decisionBudgetMs: r['decision_budget_ms'] as number,
    proposedAction: (r['proposed_action'] as ActionCycle['proposedAction']) ?? null,
    proposalId: (r['proposal_id'] as Uuid | null) ?? null,
    proposerRunIds: (r['proposer_run_ids'] as Uuid[]) ?? [],
    adversaryRunIds: (r['adversary_run_ids'] as Uuid[]) ?? [],
    verdict: (r['verdict'] as ActionCycle['verdict']) ?? null,
    reasonCodes: (r['reason_codes'] as ActionCycle['reasonCodes']) ?? [],
    revisionRound: r['revision_round'] as number,
    state: r['state'] as ActionCycle['state'],
    unresolvedReason: (r['unresolved_reason'] as ActionCycle['unresolvedReason']) ?? null,
    cutoffs: r['cutoffs'] as ActionCycle['cutoffs'],
    clearedCutoffVersion: (r['cleared_cutoff_version'] as number | null) ?? null,
    riskEvaluationId: (r['risk_evaluation_id'] as Uuid | null) ?? null,
    intentId: (r['intent_id'] as Uuid | null) ?? null,
    startedAt: iso(r['started_at']),
    terminalAt: isoOrNull(r['terminal_at']),
  };
}

export async function loadProposal(sql: Sql, id: Uuid): Promise<Proposal | null> {
  const rows = await sql<Record<string, unknown>[]>`select * from trading.proposals where id = ${id}`;
  const r = rows[0];
  if (!r) return null;
  return { id: r['id'] as Uuid, actionCycleId: r['action_cycle_id'] as Uuid, candidateId: (r['candidate_id'] as Uuid | null) ?? null, positionId: (r['position_id'] as Uuid | null) ?? null, strategyVersionId: r['strategy_version_id'] as VersionId, source: r['source'] as Proposal['source'], proposal: r['proposal'] as Proposal['proposal'], createdAt: iso(r['created_at']), expiresAt: iso(r['expires_at']) };
}

export interface CandidateAssetRow {
  asset: { id: Uuid; mint: MintAddress; decimals: number; tokenProgram: 'TOKEN' | 'TOKEN_2022' | 'UNKNOWN'; settlementRouteConfirmed: boolean };
  eligibility: { id: Uuid; liquidityUsd: number | null } | null;
  features: Record<string, number | null>;
  featuresAsOf: Instant;
}

/** The candidate's asset, its eligibility record and the feature snapshot the trigger was evaluated on. */
export async function loadCandidateAsset(sql: Sql, candidateId: Uuid): Promise<CandidateAssetRow | null> {
  const rows = await sql<Record<string, unknown>[]>`
    select a.id as a_id, a.mint_address, a.decimals, a.token_program, e.id as e_id, e.settlement_route_confirmed, e.liquidity_usd, f.as_of as f_as_of, f.features as f_features
    from signals.candidates k
    join core.assets a on a.id = k.asset_id
    join signals.feature_snapshots f on f.id = k.feature_snapshot_id
    left join core.asset_eligibility e on e.id = k.eligibility_evaluation_id
    where k.id = ${candidateId}`;
  const r = rows[0];
  if (!r) return null;
  return {
    asset: { id: r['a_id'] as Uuid, mint: r['mint_address'] as MintAddress, decimals: r['decimals'] as number, tokenProgram: r['token_program'] as CandidateAssetRow['asset']['tokenProgram'], settlementRouteConfirmed: (r['settlement_route_confirmed'] as boolean | null) ?? false },
    eligibility: r['e_id'] ? { id: r['e_id'] as Uuid, liquidityUsd: (r['liquidity_usd'] as number | null) ?? null } : null,
    features: (r['f_features'] as Record<string, number | null>) ?? {},
    featuresAsOf: iso(r['f_as_of']),
  };
}

export interface AccountRow {
  id: Uuid;
  cluster: SolanaCluster;
  tradingWallet: SolanaAddress;
  settlementMint: MintAddress;
  settlementDecimals: number | null;
  mode: 'LIVE' | 'PAPER';
}

export async function loadAccount(sql: Sql, id: Uuid): Promise<AccountRow | null> {
  const rows = await sql<Record<string, unknown>[]>`
    select t.id, t.cluster, t.trading_wallet, t.settlement_mint, t.mode, s.decimals as settlement_decimals
    from trading.accounts t left join core.assets s on s.mint_address = t.settlement_mint where t.id = ${id}`;
  const r = rows[0];
  if (!r) return null;
  return { id: r['id'] as Uuid, cluster: r['cluster'] as SolanaCluster, tradingWallet: r['trading_wallet'] as SolanaAddress, settlementMint: r['settlement_mint'] as MintAddress, settlementDecimals: (r['settlement_decimals'] as number | null) ?? null, mode: r['mode'] as AccountRow['mode'] };
}

export async function loadCustodyAccounts(sql: Sql, accountId: Uuid): Promise<{ id: Uuid; address: SolanaAddress; mint: MintAddress | null; kind: string }[]> {
  const rows = await sql<{ id: Uuid; address: SolanaAddress; mint: MintAddress | null; kind: string }[]>`
    select id, address, mint, kind from trading.custody_accounts where account_id = ${accountId} and verification_state = 'VERIFIED' and active_to is null`;
  return rows.map((r) => ({ id: r.id, address: r.address, mint: r.mint ?? null, kind: r.kind }));
}

/** The newest release binding this strategy version; the authorizer verifies its digest and status. */
export async function loadReleaseForStrategy(sql: Sql, strategyVersionId: VersionId): Promise<Release | null> {
  const rows = await sql<Record<string, unknown>[]>`
    select id, digest, binding, status, created_at, promoted_at, retired_at from research.releases
    where binding->>'strategyVersionId' = ${strategyVersionId} order by created_at desc limit 1`;
  const r = rows[0];
  if (!r) return null;
  return { id: r['id'] as Uuid, digest: r['digest'] as Sha256Hex, binding: r['binding'] as Release['binding'], status: r['status'] as Release['status'], createdAt: iso(r['created_at']), promotedAt: isoOrNull(r['promoted_at']), retiredAt: isoOrNull(r['retired_at']) };
}

/** The newest attestation for a Release, optionally of one purpose; the lifecycle decides whether it is still valid. */
export async function loadLatestAttestation(sql: Sql, releaseId: Uuid, purpose: ReleaseAttestation['purpose'] | null = null): Promise<ReleaseAttestation | null> {
  const rows = await sql<Record<string, unknown>[]>`select * from research.release_attestations where release_id = ${releaseId} and (${purpose}::text is null or purpose = ${purpose}) order by attested_at desc limit 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r['id'] as Uuid, releaseId: r['release_id'] as Uuid, releaseDigest: r['release_digest'] as Sha256Hex, purpose: r['purpose'] as ReleaseAttestation['purpose'], operatorId: r['operator_id'] as Uuid, operatorRole: 'admin',
    credentialId: r['credential_id'] as string, credentialFingerprint: r['credential_fingerprint'] as Sha256Hex, challenge: r['challenge'] as string, verificationResult: r['verification_result'] as boolean, attestedAt: iso(r['attested_at']), expiresAt: isoOrNull(r['expires_at']),
  };
}

/** The newest signed projection for an account; the authorizer verifies signature, sequence and freshness itself. */
export async function loadLatestProjection(sql: Sql, accountId: Uuid): Promise<{ envelope: SignedRiskStateProjection; sequence: Sequence } | null> {
  const rows = await sql<{ envelope: unknown; sequence: string | number }[]>`select envelope, sequence from risk.state_projections where account_id = ${accountId} order by sequence desc limit 1`;
  const r = rows[0];
  if (!r) return null;
  const parsed = SignedRiskStateProjection.safeParse(r.envelope);
  return parsed.success ? { envelope: parsed.data, sequence: Number(r.sequence) as Sequence } : null;
}

export interface OpenAuthorizationRow {
  nonce: Nonce;
  intentId: Uuid;
  actionCycleId: Uuid;
  sleeveId: Uuid | null;
  exposureEffect: TradeIntent['exposureEffect'];
  maxInputAmount: Amount;
  issuedAt: Instant;
  expiresAt: Instant;
}

/** Authorizations whose intents are not terminal: what the authorizer's ledger holds after a restart (P1). */
export async function listOpenAuthorizations(sql: Sql): Promise<OpenAuthorizationRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select a.nonce, a.intent_id, a.created_at, a.expires_at, i.action_cycle_id, i.sleeve_id, i.exposure_effect, i.max_input_amount::text as max_input_amount
    from trading.risk_authorizations a join trading.intents i on i.id = a.intent_id
    where i.lifecycle_state not in ('COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED')`;
  return rows.map((r) => ({ nonce: r['nonce'] as Nonce, intentId: r['intent_id'] as Uuid, actionCycleId: r['action_cycle_id'] as Uuid, sleeveId: (r['sleeve_id'] as Uuid | null) ?? null, exposureEffect: r['exposure_effect'] as TradeIntent['exposureEffect'], maxInputAmount: r['max_input_amount'] as Amount, issuedAt: iso(r['created_at']), expiresAt: iso(r['expires_at']) }));
}

/** Evaluation, intent and stored envelope for one signature; the cycle is linked to both. */
export async function recordAuthorization(sql: Sql, input: { evaluation: RiskEvaluation; intent: TradeIntent; envelope: SignedRiskAuthorizedIntent; authorizationHash: Sha256Hex }): Promise<void> {
  await recordRiskEvaluation(sql, input.evaluation);
  await createIntent(sql, input.intent, 'AUTHORIZED');
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`
      insert into trading.risk_authorizations (intent_id, authorization_hash, envelope, key_id, nonce, expires_at)
      values (${input.intent.id}, ${input.authorizationHash}, ${t.json(asJson(input.envelope))}, ${input.envelope.keyId}, ${input.envelope.payload.nonce}, ${input.envelope.payload.expiresAt})`;
    await t`update agents.action_cycles set risk_evaluation_id = ${input.evaluation.id} where id = ${input.intent.actionCycleId}`;
  });
}

export async function recordDenial(sql: Sql, denial: { actionCycleId: Uuid; reasonCodes: string[]; detail: string | null; deniedAt: Instant }, actorRef: string): Promise<void> {
  await writeAuditEvent(sql, {
    actor: 'RISK_AUTHORIZER',
    actorRef,
    actionClass: 'RISK_AUTHORIZATION_DENIED',
    entity: { type: 'action_cycle', id: denial.actionCycleId },
    afterSummary: { reasonCodes: denial.reasonCodes, detail: denial.detail, deniedAt: denial.deniedAt },
    liveImpacting: false,
  });
}
