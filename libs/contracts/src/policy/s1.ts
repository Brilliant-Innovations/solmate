import type { Uuid, VersionId } from '../primitives.js';

/**
 * S1 contextual momentum (blueprint §12.1) and the Trading Skill v1 binding (§11.1). An S1 version
 * is a binding of immutable versions: strategy + skill + guidelines + automation set + risk policy
 * + model policy. Changing any one is a new version, never an edit (D7).
 */
export const S1_STRATEGY_VERSION_ID = 'S1@1.0.0' as VersionId;
export const S1_STRATEGY_VERSION_UUID = '51000000-0000-4000-8000-000000000001' as Uuid;

export const S2_STRATEGY_VERSION_ID = 'S2@1.0.0' as VersionId;
export const S2_STRATEGY_VERSION_UUID = '52000000-0000-4000-8000-000000000001' as Uuid;
export const S3_STRATEGY_VERSION_ID = 'S3@1.0.0' as VersionId;
export const S3_STRATEGY_VERSION_UUID = '53000000-0000-4000-8000-000000000001' as Uuid;
export const S4_STRATEGY_VERSION_ID = 'S4@1.0.0' as VersionId;
export const S4_STRATEGY_VERSION_UUID = '54000000-0000-4000-8000-000000000001' as Uuid;

export const TRADING_SKILL_ID = 'trading-skill';
export const TRADING_SKILL_VERSION_ID = 'trading-skill@1.0.0' as VersionId;
export const TRADING_SKILL_VERSION_UUID = '5c000000-0000-4000-8000-000000000001' as Uuid;

/** Version ids the skill binds; each is pinned by the library that owns it (skills, contracts). */
export const TRADING_SKILL_V1_BINDINGS = {
  toolManifestVersion: 'tools-v1' as VersionId,
  guidelineVersion: 'guide-v1' as VersionId,
  workflowGraphVersion: 'wf-v1' as VersionId,
  contextBuilderVersion: 'ctx-v1' as VersionId,
  proposerModelPolicyVersion: 'model-v1' as VersionId,
  automationSetVersion: 'automations-v1' as VersionId,
  cyclePolicyVersion: 'cycle-v1' as VersionId,
} as const;

/**
 * Model policy v1 (§11.2): proposer and adversary run on different providers so the review is
 * not the same prompt paraphrased twice. The exact model ids come from the worker environment and
 * are recorded on every agent run; this policy only fixes the shape.
 */
/** D43 defaults for the first paper run; the operator tightens or widens them per account in ops.spend_budgets. */
export const DEFAULT_SPEND_LIMITS = {
  platform: { cyclesPerHour: null, modelUsdPerDay: 20, providerRequestsPerMinute: null },
  strategy: { cyclesPerHour: 30, modelUsdPerDay: 8, providerRequestsPerMinute: null },
  provider: { cyclesPerHour: null, modelUsdPerDay: null, providerRequestsPerMinute: 30 },
} as const;

export const MODEL_POLICY_V1 = {
  version: 'model-v1' as VersionId,
  requireDistinctProviders: true,
  proposerTemperature: 0.2,
  adversaryTemperature: 0.1,
  maxOutputTokens: 4096,
  callTimeoutMs: 45_000,
} as const;
