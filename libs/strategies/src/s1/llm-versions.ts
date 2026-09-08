import { DEFAULT_AUTOMATION_SET, DEFAULT_CATALYST_TRIGGER_POLICY, DEFAULT_DISCRETIONARY_CYCLE_POLICY, DEFAULT_EVENT_WINDOW_CAP_POLICY, DEFAULT_HYBRID_TRIGGER_POLICY, DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_RISK_POLICY, DEFAULT_SMART_MONEY_TRIGGER_POLICY, FEATURE_ENGINE_V2, MODEL_POLICY_V1, S1_STRATEGY_VERSION_ID, S1_STRATEGY_VERSION_UUID, S2_STRATEGY_VERSION_ID, S2_STRATEGY_VERSION_UUID, S3_STRATEGY_VERSION_ID, S3_STRATEGY_VERSION_UUID, S4_STRATEGY_VERSION_ID, S4_STRATEGY_VERSION_UUID, TRADING_SKILL_V1_BINDINGS, TRADING_SKILL_VERSION_ID, type GitSha, type Instant, type StrategyVersion, type TriggerFamily, type Uuid, type VersionId } from '@sol-agent-trader/contracts';

/**
 * The four LLM strategies of blueprint §12.1 as immutable version rows (§11.1 bindings, D7, D30,
 * D32). They differ only in the candidate family they start from, their speed tier and decision
 * budget, and the triggers/policies pinned in `thresholds`; every one binds Trading Skill v1, the
 * guidelines, the automation set and the cycle policy, is PAPER/OBSERVE only, and runs the same
 * proposer + independent adversary. S4 requires aligned evidence across two independent families.
 */

export interface LlmStrategySpec {
  strategyId: 'S1' | 'S2' | 'S3' | 'S4';
  id: Uuid;
  versionId: VersionId;
  families: readonly TriggerFamily[];
  speedTier: StrategyVersion['speedTier'];
  maxDecisionLatencyMs: number;
  maxCandidateAgeMs: number;
  triggers: Record<string, string>;
  description: string;
}

export const LLM_STRATEGY_SPECS: readonly LlmStrategySpec[] = [
  { strategyId: 'S1', id: S1_STRATEGY_VERSION_UUID, versionId: S1_STRATEGY_VERSION_ID, families: ['MOMENTUM_CONTINUATION'], speedTier: 'T2_CONTEXTUAL', maxDecisionLatencyMs: 180_000, maxCandidateAgeMs: 20 * 60_000, triggers: { MOMENTUM_CONTINUATION: DEFAULT_MOMENTUM_TRIGGER_POLICY.version }, description: 'Contextual momentum: starts from the quantitative momentum candidate; AI judges whether context supports continuation.' },
  { strategyId: 'S2', id: S2_STRATEGY_VERSION_UUID, versionId: S2_STRATEGY_VERSION_ID, families: ['CATALYST_RESPONSE'], speedTier: 'T3_CATALYST', maxDecisionLatencyMs: 300_000, maxCandidateAgeMs: 45 * 60_000, triggers: { CATALYST_RESPONSE: DEFAULT_CATALYST_TRIGGER_POLICY.version, eventWindow: DEFAULT_EVENT_WINDOW_CAP_POLICY.version }, description: 'Catalyst: starts from a fresh news/project/on-chain catalyst and requires market confirmation.' },
  { strategyId: 'S3', id: S3_STRATEGY_VERSION_UUID, versionId: S3_STRATEGY_VERSION_ID, families: ['SMART_MONEY_ACCUMULATION'], speedTier: 'T2_CONTEXTUAL', maxDecisionLatencyMs: 180_000, maxCandidateAgeMs: 45 * 60_000, triggers: { SMART_MONEY_ACCUMULATION: DEFAULT_SMART_MONEY_TRIGGER_POLICY.version }, description: 'Smart money: starts from independently successful wallet accumulation and checks market/liquidity context.' },
  { strategyId: 'S4', id: S4_STRATEGY_VERSION_UUID, versionId: S4_STRATEGY_VERSION_ID, families: ['HOLDER_LIQUIDITY_EXPANSION'], speedTier: 'T2_CONTEXTUAL', maxDecisionLatencyMs: 180_000, maxCandidateAgeMs: 30 * 60_000, triggers: { HYBRID: DEFAULT_HYBRID_TRIGGER_POLICY.version }, description: 'Hybrid ensemble: requires aligned evidence across at least two independent families; AI assesses coherence.' },
];

export function llmStrategyVersion(spec: LlmStrategySpec, gitSha: string, activeFrom: Instant, models: { proposer: string; adversary: string }): StrategyVersion {
  return {
    id: spec.id,
    strategyId: spec.strategyId,
    versionId: spec.versionId,
    variant: 'research',
    gitSha: gitSha as GitSha,
    featureVersion: FEATURE_ENGINE_V2.version,
    promptVersions: { proposer: 'proposer@1' as StrategyVersion['promptVersions'][string], adversary: 'adversary@1' as StrategyVersion['promptVersions'][string] },
    modelSelections: { proposer: models.proposer, adversary: models.adversary },
    thresholds: { triggers: spec.triggers, families: [...spec.families], cyclePolicy: DEFAULT_DISCRETIONARY_CYCLE_POLICY.version, modelPolicy: MODEL_POLICY_V1.version, minConfidence: DEFAULT_DISCRETIONARY_CYCLE_POLICY.minConfidence, description: spec.description },
    riskPolicyVersion: DEFAULT_RISK_POLICY.version,
    skillVersionId: TRADING_SKILL_VERSION_ID,
    guidelineVersionId: TRADING_SKILL_V1_BINDINGS.guidelineVersion,
    automationSetVersionId: DEFAULT_AUTOMATION_SET.version,
    speedTier: spec.speedTier,
    maxDecisionLatencyMs: spec.maxDecisionLatencyMs,
    maxCandidateAgeMs: spec.maxCandidateAgeMs,
    maxQuoteAgeMs: DEFAULT_RISK_POLICY.maxQuoteAgeMs,
    chaseToleranceBps: DEFAULT_RISK_POLICY.chaseToleranceBps,
    allowedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION'],
    reassessmentPolicy: { heartbeatMs: DEFAULT_AUTOMATION_SET.heartbeatMsByTier[spec.speedTier] ?? 1_800_000, automationSet: DEFAULT_AUTOMATION_SET.version },
    adversaryPolicy: { proposerModel: models.proposer, adversaryModel: models.adversary, deterministicGate: false },
    sessionRules: { allowedSessions: [], blockedWeekdays: [], customWindowsUtc: [] },
    regimeConditions: {},
    outsideWindowBehavior: 'WATCH',
    warmup: { minBarsByResolution: { '1m': Math.max(0, ...Object.values(FEATURE_ENGINE_V2.lookbackBuckets)) }, baselineWindowMs: 0 },
    eventWindowPolicy: spec.strategyId === 'S2' ? { maxDurationMs: DEFAULT_EVENT_WINDOW_CAP_POLICY.maxDurationMs, maxExtensions: DEFAULT_EVENT_WINDOW_CAP_POLICY.maxExtensions, requireRetestAfterMs: DEFAULT_EVENT_WINDOW_CAP_POLICY.requireRetestAfterMs } : { maxDurationMs: 0, maxExtensions: 0, requireRetestAfterMs: null },
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

export function llmStrategyVersions(gitSha: string, activeFrom: Instant, models: { proposer: string; adversary: string }): StrategyVersion[] {
  return LLM_STRATEGY_SPECS.map((spec) => llmStrategyVersion(spec, gitSha, activeFrom, models));
}
