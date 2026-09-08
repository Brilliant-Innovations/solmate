import { canonicalHash, DEFAULT_COHORT_TAXONOMY, DEFAULT_FRESHNESS_REQUIREMENTS, type Instant, type Release, type ReleaseBinding, type Sha256Hex, type StrategyVersion, type Uuid, type VersionId } from '@sol-agent-trader/contracts';

/**
 * A Release is the immutable binding of every version a strategy runs with (blueprint §11.1, §15.9,
 * D50, D56): its digest is what attestations, projections and authorizations bind to. The id is
 * derived from the digest so the same binding always names the same Release row, whichever
 * process registers it first. Status starts DRAFT; promotion and arming are operator steps.
 */

export interface ReleaseContext {
  contractSetDigest: Sha256Hex;
  cohortPolicyVersion?: VersionId;
  freshnessPolicyVersion?: VersionId;
  executorPolicyRef?: VersionId;
}

export function releaseBindingFor(strategy: StrategyVersion, ctx: ReleaseContext): ReleaseBinding {
  return {
    strategyVersionId: strategy.versionId,
    skillVersionId: strategy.skillVersionId,
    guidelineVersionId: strategy.guidelineVersionId,
    automationSetVersionId: strategy.automationSetVersionId,
    proposerModelPolicyVersion: strategy.adversaryPolicy.proposerModel ? ('model-v1' as VersionId) : null,
    adversaryModelPolicyVersion: strategy.adversaryPolicy.deterministicGate ? ('deterministic-gate-v1' as VersionId) : ('model-v1' as VersionId),
    riskPolicyVersion: strategy.riskPolicyVersion,
    cohortPolicyVersion: ctx.cohortPolicyVersion ?? DEFAULT_COHORT_TAXONOMY.version,
    freshnessPolicyVersion: ctx.freshnessPolicyVersion ?? ('freshness-v1' as VersionId),
    executorPolicyRef: ctx.executorPolicyRef ?? ('executor-policy-v1' as VersionId),
    contractSetDigest: ctx.contractSetDigest,
  };
}

/** Deterministic UUID (version 4 layout, variant 10) from the first 128 bits of the digest. */
export function releaseIdFromDigest(digest: Sha256Hex): Uuid {
  const h = digest.slice(0, 32).split('');
  h[12] = '4';
  h[16] = '8';
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}` as Uuid;
}

export async function releaseFor(strategy: StrategyVersion, ctx: ReleaseContext, createdAt: Instant): Promise<Release> {
  const binding = releaseBindingFor(strategy, ctx);
  const digest = await canonicalHash(binding);
  return { id: releaseIdFromDigest(digest), digest, binding, status: 'DRAFT', createdAt, promotedAt: null, retiredAt: null };
}

export { DEFAULT_FRESHNESS_REQUIREMENTS as RELEASE_FRESHNESS_REQUIREMENTS };
