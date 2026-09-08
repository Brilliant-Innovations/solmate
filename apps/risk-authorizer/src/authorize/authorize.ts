import { addMs, canonicalHash, compareAmounts, instantToMs, signPayload, subAmounts, type ActionCycle, type Amount, type AuthorizationDenial, type Bps, type CapitalAuthority, type Instant, type MintAddress, type Nonce, type Proposal, type Release, type ReleaseAttestation, type RiskAuthorizedIntent, type RiskPolicy, type Sequence, type Sha256Hex, type SignedRiskAuthorizedIntent, type SignedRiskStateProjection, type SigningKeyPair, type SolanaCluster, type Uuid, type VerificationKey } from '@sol-agent-trader/contracts';
import { capitalAttestationVerdict, evaluateEntry, type PortfolioState } from '@sol-agent-trader/risk';
import { verifyProjection, type IndependentChainReads } from '../projection/verify.js';
import { verifyRelease } from '../release/verify.js';
import type { AuthorizationLedger } from './ledger.js';

/**
 * Entry authorization (blueprint D21, D45, D52, §13.7, §15.3, §15.5; INV-02, INV-03, INV-07,
 * INV-14, INV-18, INV-28; ADR-0009 P1). One pure-ish function from immutable records and
 * independent chain reads to either a signed RiskAuthorizedIntent envelope or a typed denial.
 * Nothing here trusts a worker-computed risk evaluation: the maximum amount is recomputed from the
 * verified projection by the same deterministic risk core, with the authorizer's own ledger
 * supplying pending exposure. The order is fixed and every refusal stops before signing.
 */

export interface MintHardState {
  isInitialized: boolean;
  mintAuthority: 'NONE' | 'PRESENT' | 'UNKNOWN';
  freezeAuthority: 'NONE' | 'PRESENT' | 'UNKNOWN';
  readSlot: number;
}

export interface AuthorizeEntryInput {
  now: Instant;
  cycle: ActionCycle;
  proposal: Proposal;
  asset: { id: Uuid; mint: MintAddress; decimals: number; tokenProgram: 'TOKEN' | 'TOKEN_2022' | 'UNKNOWN'; settlementRouteConfirmed: boolean };
  /** Executable quote the worker took for the proposal, re-validated here by age and impact only; price comes from it. */
  quote: { ageMs: number; impactBps: Bps | null; slippageBps: Bps; priceUsd: number; atrPct: number | null; liquidityUsd: number | null } | null;
  release: Release;
  attestation: ReleaseAttestation | null;
  projection: SignedRiskStateProjection;
  chain: IndependentChainReads | null;
  mint: MintHardState | null;
  /** The authorizer's own read of the runtime session gate (D60), never the worker's claim. */
  sessionAllowsEntries: boolean;
  account: { id: Uuid; cluster: SolanaCluster; capitalAuthority: CapitalAuthority; settlementDecimals: number };
  policy: RiskPolicy;
  keys: { signing: SigningKeyPair; projection: readonly VerificationKey[]; trustedAttestationFingerprints: readonly Sha256Hex[] };
  ledger: AuthorizationLedger;
  lastProjectionSequence: Sequence | null;
  config: { projectionMaxAgeMs: number; intentExpiryMs: number; balanceToleranceBps: number; maxSlotLag: number };
  newNonce: () => Nonce;
  newIntentId: () => Uuid;
}

export type AuthorizeOutcome =
  | { kind: 'AUTHORIZED'; envelope: SignedRiskAuthorizedIntent; projectionSequence: Sequence }
  | { kind: 'DENIED'; denial: AuthorizationDenial };

const DISCRETIONARY_ENTRY = new Set(['ENTER', 'ADD']);
const LIVE = new Set<CapitalAuthority>(['LIVE_APPROVAL', 'LIVE_AUTO']);

export async function authorizeEntry(input: AuthorizeEntryInput): Promise<AuthorizeOutcome> {
  const { cycle, proposal, now } = input;
  const deny = (reasonCodes: string[], detail: string | null = null): AuthorizeOutcome => ({ kind: 'DENIED', denial: { intentId: null, actionCycleId: cycle.id, deniedAt: now, reasonCodes, detail } });

  // 1. Release and attestation (INV-18, INV-17).
  const release = await verifyRelease({ release: input.release, attestation: input.attestation, capitalAuthority: input.account.capitalAuthority, trustedFingerprints: input.keys.trustedAttestationFingerprints, now });
  if (!release.ok) return deny(release.reasons);
  if (input.release.binding.strategyVersionId !== cycle.strategyVersionId || input.release.binding.riskPolicyVersion !== input.policy.version) return deny(['RELEASE_BINDING_MISMATCH'], `release binds ${input.release.binding.strategyVersionId}/${input.release.binding.riskPolicyVersion}, cycle ${cycle.strategyVersionId}, policy ${input.policy.version}`);

  // 2. Signed projection, fresh, sequenced, and agreeing with independent chain reads (INV-07).
  const live = LIVE.has(input.account.capitalAuthority);
  if (live && !input.chain) return deny(['CHAIN_READS_REQUIRED']);
  const projection = await verifyProjection({ envelope: input.projection, acceptedKeys: input.keys.projection, lastSequence: input.lastProjectionSequence, now, maxAgeMs: input.config.projectionMaxAgeMs, expected: { releaseId: input.release.id, releaseDigest: release.digest, policyVersion: input.policy.version }, chain: input.chain, tolerance: { balanceBps: input.config.balanceToleranceBps, maxSlotLag: input.config.maxSlotLag } });
  if (!projection.ok) return deny(projection.reasons, projection.detail.join('; ') || null);
  const p = projection.projection;

  // 3. Cleared adversarial cycle at the latest cutoff, proposing exposure (INV-14).
  const latestCutoff = cycle.cutoffs.reduce((m, c) => Math.max(m, c.version), 0);
  if (cycle.state !== 'CLEARED' || cycle.verdict !== 'CONFIRM') return deny(['CYCLE_NOT_CLEARED'], `state ${cycle.state}, verdict ${cycle.verdict ?? 'none'}`);
  if (cycle.clearedCutoffVersion === null || cycle.clearedCutoffVersion !== latestCutoff) return deny(['CYCLE_CUTOFF_STALE'], `cleared at ${cycle.clearedCutoffVersion ?? 'none'}, latest ${latestCutoff}`);
  if (cycle.proposedAction === null || !DISCRETIONARY_ENTRY.has(cycle.proposedAction)) return deny(['CYCLE_ACTION_NOT_ENTRY'], `proposed ${cycle.proposedAction ?? 'none'}`);
  if (cycle.proposalId !== proposal.id || proposal.actionCycleId !== cycle.id || proposal.proposal.actionType !== cycle.proposedAction || proposal.strategyVersionId !== cycle.strategyVersionId) return deny(['PROPOSAL_CYCLE_MISMATCH']);
  if (proposal.proposal.candidateId !== cycle.candidateId || (proposal.proposal.candidateId !== null && cycle.candidateId === null)) return deny(['PROPOSAL_TARGET_MISMATCH']);
  if (instantToMs(proposal.expiresAt) <= instantToMs(now)) return deny(['PROPOSAL_EXPIRED']);
  const existing = input.ledger.nonceForCycle(cycle.id);
  if (existing !== null) return deny(['CYCLE_ALREADY_AUTHORIZED'], `nonce ${existing}`);

  // 4. Eligibility from the signed projection, for exactly this asset (INV-03).
  const eligibility = p.eligibilitySummary.find((e) => e.assetId === input.asset.id) ?? null;
  const eligible = eligibility !== null && eligibility.eligible;

  // 5. Capital attestation ceiling (INV-28) and independent D45 hard state for live authority.
  const attestation = capitalAttestationVerdict(p.capitalAttestation);
  if (live && !attestation.allowsNewExposure) return deny([attestation.reason]);
  if (live) {
    const m = input.mint;
    if (!m) return deny(['CHAIN_MINT_READ_REQUIRED']);
    if (!m.isInitialized) return deny(['CHAIN_MINT_NOT_INITIALIZED']);
    if (m.mintAuthority !== 'NONE') return deny([m.mintAuthority === 'PRESENT' ? 'CHAIN_MINT_AUTHORITY_PRESENT' : 'CHAIN_MINT_AUTHORITY_UNKNOWN']);
    if (m.freezeAuthority !== 'NONE') return deny([m.freezeAuthority === 'PRESENT' ? 'CHAIN_FREEZE_AUTHORITY_PRESENT' : 'CHAIN_FREEZE_AUTHORITY_UNKNOWN']);
  }

  // 6. Deterministic risk evaluation from the verified projection and the authorizer's own ledger (INV-02, P1).
  const sleeve = p.sleeves.find((s) => s.strategyVersionId === cycle.strategyVersionId) ?? null;
  const assetExposure = p.openLots.filter((l) => l.assetId === input.asset.id).reduce((acc, l) => sumAmounts(acc, l.costBasisBaseUnits), '0' as Amount);
  const pending = input.ledger.pendingExposure(now);
  const cohort = p.cohortCapacity[0] ?? null;
  const cluster = p.clusterCapacity[0] ?? null;
  const state: PortfolioState = {
    settlementMint: p.settlementMint,
    settlementDecimals: input.account.settlementDecimals,
    equityBaseUnits: sumAmounts(p.settlementAvailableBaseUnits, p.aggregateNonSettlementExposureBaseUnits),
    exposureBaseUnits: p.aggregateNonSettlementExposureBaseUnits,
    pendingExposureBaseUnits: pending,
    inFlightExposureIncreasing: input.ledger.inFlightIncreasing(now),
    openPositions: new Set(p.openLots.map((l) => l.positionId)).size,
    assetExposureBaseUnits: assetExposure,
    settlementAvailableBaseUnits: p.settlementAvailableBaseUnits,
    gasReserveLamports: p.gasReserveLamports,
    sleeve: sleeve ? { id: sleeve.sleeveId, active: true, capRemainingBaseUnits: compareAmounts(sleeve.capBaseUnits, sleeve.committedBaseUnits) > 0 ? subAmounts(sleeve.capBaseUnits, sleeve.committedBaseUnits) : ('0' as Amount), riskRemainingBaseUnits: sleeve.riskRemainingBaseUnits } : null,
    cohort: cohort ? { id: cohort.id, usedFraction: cohort.usedFraction } : null,
    cluster: cluster ? { id: cluster.id, usedFraction: cluster.usedFraction } : null,
    drawdown: { dailyFraction: p.drawdown.dailyFraction, rollingFraction: p.drawdown.rollingFraction, consecutiveLosses: p.drawdown.consecutiveLosses, circuitBreakerTripped: p.drawdown.circuitBreakerTripped, breakerTrippedAt: null },
    health: {
      feedsBlockEntries: p.freshnessSummary.some((f) => !f.fresh),
      staleDataClasses: p.freshnessSummary.map((f) => ({ dataClass: f.dataClass, ageMs: f.ageMs, limitMs: f.fresh ? Number.MAX_SAFE_INTEGER : 0 })),
      reconciliationClean: true,
      dbAvailable: true,
      executionAnomalies: 0,
      providerAuthFailure: false,
      clockDriftMs: 0,
      operatorKill: false,
      sessionAllowsEntries: input.sessionAllowsEntries,
    },
  };
  const q = input.quote;
  const evaluation = evaluateEntry(
    input.policy,
    state,
    {
      id: input.newIntentId(),
      proposalId: proposal.id,
      actionCycleId: cycle.id,
      assetId: input.asset.id,
      eligibility: eligible ? { allowed: true } : { allowed: false, reason: eligibility ? 'NOT_ELIGIBLE' : 'NO_ELIGIBILITY_RECORD' },
      eligibilityEvaluationId: eligibility?.evaluationId ?? null,
      proposalExpiresAt: proposal.expiresAt,
      proposalPriceUsd: q?.priceUsd ?? 0,
      quote: q ? { ageMs: q.ageMs, impactBps: q.impactBps, slippageBps: q.slippageBps, priceUsd: q.priceUsd } : null,
      token2022Compatible: input.asset.tokenProgram === 'TOKEN' || input.asset.settlementRouteConfirmed,
      duplicateIntent: false,
      liquidityUsd: q?.liquidityUsd ?? null,
      atrPct: q?.atrPct ?? null,
      structureLowPriceUsd: null,
      expectedRewardFraction: null,
    },
    now,
  );
  if (!evaluation.record.allowed || evaluation.record.computedPositionAmount === null) return deny(evaluation.record.reasonCodes.length ? evaluation.record.reasonCodes : ['SIZE_ZERO']);

  // 7. Sign exactly the bound action (D21).
  const intentId = input.newIntentId();
  const nonce = input.newNonce();
  if (input.ledger.hasNonce(nonce)) return deny(['NONCE_REUSED']);
  const expiresAt = minInstant(addMs(now, input.config.intentExpiryMs), proposal.expiresAt);
  const policyHash = await canonicalHash(input.policy);
  const body = {
    intentId,
    actionCycleId: cycle.id,
    clearedCutoffVersion: cycle.clearedCutoffVersion,
    releaseId: input.release.id,
    releaseDigest: release.digest,
    attestationId: release.attestationId,
    policyVersion: input.policy.version,
    policyHash,
    strategyVersionId: cycle.strategyVersionId,
    sleeveId: sleeve?.sleeveId ?? null,
    accountId: input.account.id,
    assetId: input.asset.id,
    cluster: input.account.cluster,
    capitalAuthority: input.account.capitalAuthority,
    action: cycle.proposedAction as 'ENTER' | 'ADD',
    side: 'BUY' as const,
    exposureEffect: 'INCREASE' as const,
    inputMint: p.settlementMint,
    outputMint: input.asset.mint,
    maxInputAmount: evaluation.record.computedPositionAmount,
    maxSlippageBps: input.policy.maxSlippageBps,
    maxPriceImpactBps: input.policy.maxImpactBps,
    chaseToleranceBps: input.policy.chaseToleranceBps,
    maxQuoteAgeMs: input.policy.maxQuoteAgeMs,
    allowedProtectionMode: 'MONITORED_EXIT' as const,
    targetLotIds: [] as Uuid[],
    approvalRequired: input.account.capitalAuthority === 'LIVE_APPROVAL',
    projectionSequence: projection.sequence,
    projectionHash: projection.payloadHash,
    issuedAt: now,
    expiresAt,
    nonce,
  };
  const intentHash = await canonicalHash(body);
  const payload: RiskAuthorizedIntent = { ...body, intentHash };
  const envelope = (await signPayload(payload, input.keys.signing, now)) as SignedRiskAuthorizedIntent;
  input.ledger.issue({ nonce, intentId, actionCycleId: cycle.id, sleeveId: body.sleeveId, exposureEffect: 'INCREASE', maxInputAmount: body.maxInputAmount, issuedAt: now, expiresAt, consumedAt: null });
  return { kind: 'AUTHORIZED', envelope, projectionSequence: projection.sequence };
}

function sumAmounts(a: Amount, b: Amount): Amount {
  return (BigInt(a) + BigInt(b)).toString() as Amount;
}
function minInstant(a: Instant, b: Instant): Instant {
  return instantToMs(a) <= instantToMs(b) ? a : b;
}
