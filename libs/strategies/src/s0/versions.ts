import { DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY, DEFAULT_MOMENTUM_TRIGGER_POLICY, S0_TRIGGER_FAMILIES, DEFAULT_RISK_POLICY, DEFAULT_S0_SAFETY_GATE_POLICY, FEATURE_ENGINE_V2, S0_STRATEGY_VERSION_IDS, S0_TINY_LIVE_VERSION_ID, type GitSha, type Instant, type S0Variant, type StrategyVersion, type Uuid } from '@sol-agent-trader/contracts';

/**
 * The two S0 strategy versions (blueprint §12.1, §6.21; D7 immutable). Parameters are the
 * versioned policies they reference, so a version row pins trigger, gate, feature engine and
 * risk policy versions together. S0_RAW is eligible for OBSERVE/PAPER only: it never holds live
 * authority (§12.1), and the risk-authorizer checks `eligibleCapitalAuthorities` in M7.
 */

export const S0_STRATEGY_VERSION_UUIDS: Record<S0Variant, Uuid> = {
  RAW: '50000000-0000-4000-8000-000000000005' as Uuid,
  SAFE: '50000000-0000-4000-8000-000000000006' as Uuid,
};

export function s0StrategyVersion(variant: S0Variant, gitSha: string, activeFrom: Instant): StrategyVersion {
  const safe = variant === 'SAFE';
  return {
    id: S0_STRATEGY_VERSION_UUIDS[variant],
    strategyId: safe ? 'S0_SAFE' : 'S0_RAW',
    versionId: S0_STRATEGY_VERSION_IDS[variant],
    variant: 'research',
    gitSha: gitSha as GitSha,
    featureVersion: FEATURE_ENGINE_V2.version,
    promptVersions: {},
    modelSelections: {},
    thresholds: { triggers: { MOMENTUM_CONTINUATION: DEFAULT_MOMENTUM_TRIGGER_POLICY.version, EARLY_ACCELERATION: DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY.version }, families: [...S0_TRIGGER_FAMILIES], gate: safe ? DEFAULT_S0_SAFETY_GATE_POLICY.version : null },
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
    warmup: { minBarsByResolution: { '1m': Math.max(0, ...Object.values(FEATURE_ENGINE_V2.lookbackBuckets)) }, baselineWindowMs: 0 },
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

export const S0_TINY_LIVE_VERSION_UUID = '50000000-0000-4000-8000-000000000007' as Uuid;

/**
 * ADR-0004 tiny-live variant: the same deterministic rule and the same deterministic second-look
 * gate as S0_SAFE, with a T1 tier and a live intent expiry above `humanReactionFloorMs`, so it can
 * bind to a LIVE_APPROVAL Release. LIVE_AUTO is not among its authorities (Profile 2 is attended).
 */
export function s0TinyLiveVersion(gitSha: string, activeFrom: Instant): StrategyVersion {
  const safe = s0StrategyVersion('SAFE', gitSha, activeFrom);
  return {
    ...safe,
    id: S0_TINY_LIVE_VERSION_UUID,
    versionId: S0_TINY_LIVE_VERSION_ID,
    variant: 'tiny-live',
    speedTier: 'T1_MOMENTUM',
    maxDecisionLatencyMs: 60_000,
    humanReactionFloorMs: 30_000,
    liveIntentExpiryMs: 120_000,
    attendedPresenceRequiredProfiles: ['P1A', 'P2'],
    eligibleCapitalAuthorities: ['OBSERVE', 'PAPER', 'LIVE_APPROVAL'],
  };
}
