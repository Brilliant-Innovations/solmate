import { DEFAULT_AUTOMATION_SET, DEFAULT_DISCRETIONARY_CYCLE_POLICY, DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_RISK_POLICY, FEATURE_ENGINE_V2, MODEL_POLICY_V1, S1_STRATEGY_VERSION_ID, S1_STRATEGY_VERSION_UUID, TRADING_SKILL_V1_BINDINGS, TRADING_SKILL_VERSION_ID, type GitSha, type Instant, type StrategyVersion } from '@sol-agent-trader/contracts';

/**
 * S1 contextual momentum (blueprint §12.1, §11.1, D30, D32). Starts from the same quantitative
 * momentum candidate S0 sees (research validity: the baseline gets the same opportunity set) and
 * asks the Trading Skill whether context supports continuation. T2_CONTEXTUAL: full proposer +
 * independent adversary inside the decision budget; a cycle that cannot clear in time expires.
 * PAPER only until adversarial review #2 and the P5 acceptance (execution plan M6).
 */
export function s1StrategyVersion(gitSha: string, activeFrom: Instant, models: { proposer: string; adversary: string }): StrategyVersion {
  return {
    id: S1_STRATEGY_VERSION_UUID,
    strategyId: 'S1',
    versionId: S1_STRATEGY_VERSION_ID,
    variant: 'research',
    gitSha: gitSha as GitSha,
    featureVersion: FEATURE_ENGINE_V2.version,
    promptVersions: { proposer: 'proposer@1' as StrategyVersion['promptVersions'][string], adversary: 'adversary@1' as StrategyVersion['promptVersions'][string] },
    modelSelections: { proposer: models.proposer, adversary: models.adversary },
    thresholds: { triggers: { MOMENTUM_CONTINUATION: DEFAULT_MOMENTUM_TRIGGER_POLICY.version }, families: ['MOMENTUM_CONTINUATION'], cyclePolicy: DEFAULT_DISCRETIONARY_CYCLE_POLICY.version, modelPolicy: MODEL_POLICY_V1.version, minConfidence: DEFAULT_DISCRETIONARY_CYCLE_POLICY.minConfidence },
    riskPolicyVersion: DEFAULT_RISK_POLICY.version,
    skillVersionId: TRADING_SKILL_VERSION_ID,
    guidelineVersionId: TRADING_SKILL_V1_BINDINGS.guidelineVersion,
    automationSetVersionId: DEFAULT_AUTOMATION_SET.version,
    speedTier: 'T2_CONTEXTUAL',
    maxDecisionLatencyMs: 180_000,
    maxCandidateAgeMs: 20 * 60_000,
    maxQuoteAgeMs: DEFAULT_RISK_POLICY.maxQuoteAgeMs,
    chaseToleranceBps: DEFAULT_RISK_POLICY.chaseToleranceBps,
    allowedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION'],
    reassessmentPolicy: { heartbeatMs: DEFAULT_AUTOMATION_SET.heartbeatMsByTier['T2_CONTEXTUAL'] ?? 1_800_000, automationSet: DEFAULT_AUTOMATION_SET.version },
    adversaryPolicy: { proposerModel: models.proposer, adversaryModel: models.adversary, deterministicGate: false },
    sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] },
    regimeConditions: {},
    outsideWindowBehavior: 'WATCH',
    warmup: { minBarsByResolution: { '1m': Math.max(0, ...Object.values(FEATURE_ENGINE_V2.lookbackBuckets)) }, baselineWindowMs: 0 },
    eventWindowPolicy: { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null },
    offlineProtection: { permitted: false, maxOfflineMs: null },
    attendedPresenceRequiredProfiles: ['P1A'],
    humanReactionFloorMs: 30_000,
    liveIntentExpiryMs: 60_000,
    eligibleCapitalAuthorities: ['OBSERVE', 'PAPER'],
    status: 'PAPER',
    activeFrom,
    activeTo: null,
  };
}
