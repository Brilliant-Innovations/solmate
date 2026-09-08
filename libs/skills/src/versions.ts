import { DEFAULT_TOOL_MANIFEST, TRADING_SKILL_ID, TRADING_SKILL_V1_BINDINGS, TRADING_SKILL_VERSION_ID, TRADING_SKILL_VERSION_UUID, type GitSha, type Instant, type SkillVersion } from '@sol-agent-trader/contracts';
import { GUIDELINES_V1 } from './guidelines/v1.js';
import { DEFAULT_CONTEXT_BUILD_POLICY } from './context/builder.js';

/**
 * Trading Skill v1 as an immutable `agents.skill_versions` row (blueprint §6.10A, §11.1, §11.3).
 * The bindings are checked against the libraries that own them so a drift is a test failure, not a
 * silent behaviour change (INV-17 for LIVE_AUTO is verified by the risk-authorizer's release check).
 */
export function tradingSkillVersion(gitSha: string, effectiveFrom: Instant): SkillVersion {
  if (DEFAULT_TOOL_MANIFEST.version !== TRADING_SKILL_V1_BINDINGS.toolManifestVersion) throw new Error(`tool manifest ${DEFAULT_TOOL_MANIFEST.version} != bound ${TRADING_SKILL_V1_BINDINGS.toolManifestVersion}`);
  if (GUIDELINES_V1.version !== TRADING_SKILL_V1_BINDINGS.guidelineVersion) throw new Error(`guidelines ${GUIDELINES_V1.version} != bound ${TRADING_SKILL_V1_BINDINGS.guidelineVersion}`);
  if (DEFAULT_CONTEXT_BUILD_POLICY.version !== TRADING_SKILL_V1_BINDINGS.contextBuilderVersion) throw new Error(`context builder ${DEFAULT_CONTEXT_BUILD_POLICY.version} != bound ${TRADING_SKILL_V1_BINDINGS.contextBuilderVersion}`);
  return {
    id: TRADING_SKILL_VERSION_UUID,
    skillId: TRADING_SKILL_ID,
    versionId: TRADING_SKILL_VERSION_ID,
    gitSha: gitSha as GitSha,
    toolManifestVersion: TRADING_SKILL_V1_BINDINGS.toolManifestVersion,
    guidelineVersion: TRADING_SKILL_V1_BINDINGS.guidelineVersion,
    supportedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION'],
    workflowGraphVersion: TRADING_SKILL_V1_BINDINGS.workflowGraphVersion,
    contextBuilderVersion: TRADING_SKILL_V1_BINDINGS.contextBuilderVersion,
    proposerModelPolicyVersion: TRADING_SKILL_V1_BINDINGS.proposerModelPolicyVersion,
    adversaryPolicyRequired: true,
    status: 'PAPER',
    effectiveFrom,
    effectiveTo: null,
  };
}
