import { DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_RISK_POLICY, DEFAULT_S0_SAFETY_GATE_POLICY, FEATURE_ENGINE_V1, S0_STRATEGY_VERSION_IDS, type GitSha, type Instant, type S0Variant, type StrategyVersion, type Uuid } from '@sol-agent-trader/contracts';

/**
 * The two S0 strategy versions (blueprint §12.1, §6.21; D7 immutable). Parameters are the
 * versioned policies they reference, so a version row pins trigger, gate, feature engine and
 * risk policy versions together. S0_RAW is eligible for OBSERVE/PAPER only: it never holds live
 * authority (§12.1), and the risk-authorizer checks `eligibleCapitalAuthorities` in M7.
 */

export const S0_STRATEGY_VERSION_UUIDS: Record<S0Variant, Uuid> = {
  RAW: '50000000-0000-4000-8000-000000000001' as Uuid,
  SAFE: '50000000-0000-4000-8000-000000000002' as Uuid,
};

export function s0StrategyVersion(variant: S0Variant, gitSha: string, activeFrom: Instant): StrategyVersion {
  const safe = variant === 'SAFE';
  return {
    id: S0_STRATEGY_VERSION_UUIDS[variant],
    strategyId: safe ? 'S0_SAFE' : 'S0_RAW',
    versionId: S0_STRATEGY_VERSION_IDS[variant],
    variant: 'research',
    gitSha: gitSha as GitSha,
    featureVersion: FEATURE_ENGINE_V1.version,
    promptVersions: {},
    modelSelections: {},
    thresholds: { trigger: DEFAULT_MOMENTUM_TRIGGER_POLICY.version, gate: safe ? DEFAULT_S0_SAFETY_GATE_POLICY.version : null },
    riskPolicyVersion: DEFAULT_RISK_POLICY.version,
    skillVersionId: null,
    guidelineVersionId: null,
    automationSetVersionId: null,
    speedTier: 'T0_FAST',
    maxDecisionLatencyMs: 30_000,
    maxCandidateAgeMs: DEFAULT_S0_SAFETY_GATE_POLICY.maxCandidateAgeMs,
    maxQuoteAgeMs: DEFAULT_RISK_POLICY.maxQuoteAgeMs,
    chaseToleranceBps: DEFAULT_RISK_POLICY.chaseToleranceBps,
    allowedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION'],
    reassessmentPolicy: { intervalMs: 60_000 },
    adversaryPolicy: { proposerModel: null, adversaryModel: null, deterministicGate: safe },
    sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] },
    regimeConditions: {},
    outsideWindowBehavior: 'WATCH',
    warmup: { minBarsByResolution: { '1m': Math.max(0, ...Object.values(FEATURE_ENGINE_V1.lookbackBuckets)) }, baselineWindowMs: 0 },
    eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null },
    offlineProtection: { permitted: false, maxOfflineMs: null },
    attendedPresenceRequiredProfiles: ['P1A'],
    humanReactionFloorMs: 30_000,
    liveIntentExpiryMs: 60_000,
    eligibleCapitalAuthorities: safe ? ['OBSERVE', 'PAPER', 'LIVE_APPROVAL', 'LIVE_AUTO'] : ['OBSERVE', 'PAPER'],
    status: 'PAPER',
    activeFrom,
    activeTo: null,
  };
}
