import { compareInstants, type ToolArguments, type ToolName, type ToolRefusalReason, type ToolScope, type TradingActionProposal, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Server-side id resolution (§11.4: "IDs are server-resolved and validated before use"). The model may
 * only name the action cycle's own candidate, position and assets, and may only cite evidence it was
 * shown: ids seeded by the context builder plus ids returned by tools during the same run.
 */
export interface RunLedger {
  /** Evidence ids this run has seen so far (scope seed + tool responses). */
  seenEvidenceIds: Set<Uuid>;
  invocations: number;
  proposals: number;
  closed: boolean;
}

export function newRunLedger(scope: ToolScope): RunLedger {
  return { seenEvidenceIds: new Set(scope.evidenceIds), invocations: 0, proposals: 0, closed: false };
}

export interface ScopeViolation {
  reason: ToolRefusalReason;
  detail: string;
}

export function checkScope(name: ToolName, args: ToolArguments[ToolName], scope: ToolScope, ledger: RunLedger): ScopeViolation | null {
  switch (name) {
    case 'getCandidateContext': {
      const a = args as ToolArguments['getCandidateContext'];
      if (scope.candidateId === null || a.candidateId !== scope.candidateId) return { reason: 'OUT_OF_SCOPE_ID', detail: 'candidateId is not this action cycle\'s candidate' };
      return null;
    }
    case 'getPositionContext': {
      const a = args as ToolArguments['getPositionContext'];
      if (scope.positionId === null || a.positionId !== scope.positionId) return { reason: 'OUT_OF_SCOPE_ID', detail: 'positionId is not this action cycle\'s position' };
      return null;
    }
    case 'getAssetMarketState':
    case 'getAssetSafetyState':
    case 'getOnchainContext':
    case 'getExecutionPreview':
    case 'getNewsSocialEvidence': {
      const a = args as ToolArguments['getAssetMarketState'];
      if (!scope.assetIds.includes(a.assetId)) return { reason: 'OUT_OF_SCOPE_ID', detail: 'assetId is not in this action cycle\'s scope' };
      return null;
    }
    case 'getPortfolioContext':
      return null;
    case 'submitActionProposal': {
      const a = args as ToolArguments['submitActionProposal'];
      return checkProposal(a.proposal, scope, ledger);
    }
  }
}

const POSITION_ACTIONS = new Set<TradingActionProposal['actionType']>(['HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION', 'ADD']);

/**
 * A proposal is bound to its cycle: same strategy and skill versions, same trigger, same cutoff, the
 * cycle's own candidate or position, an action the skill version supports, and only evidence the run
 * was shown. Hallucinated evidence ids are refused, not silently dropped (§32 "Can hallucinated
 * evidence IDs pass validation?").
 */
export function checkProposal(p: TradingActionProposal, scope: ToolScope, ledger: RunLedger): ScopeViolation | null {
  if (p.evidenceCutoffVersion !== scope.cutoffVersion) return { reason: 'CUTOFF_MISMATCH', detail: `proposal cutoff v${p.evidenceCutoffVersion} != run cutoff v${scope.cutoffVersion}` };
  if (!scope.supportedActionTypes.includes(p.actionType)) return { reason: 'ACTION_NOT_SUPPORTED', detail: `${p.actionType} is not supported by skill ${scope.skillVersionId}` };
  if (p.strategyVersionId !== scope.strategyVersionId) return { reason: 'PROPOSAL_INCONSISTENT', detail: 'strategyVersionId differs from the action cycle' };
  if (p.skillVersionId !== scope.skillVersionId) return { reason: 'PROPOSAL_INCONSISTENT', detail: 'skillVersionId differs from the action cycle' };
  if (p.triggerId !== scope.triggerId) return { reason: 'PROPOSAL_INCONSISTENT', detail: 'triggerId differs from the action cycle' };
  if (p.actionType === 'ENTER' || p.actionType === 'IGNORE') {
    if (scope.candidateId === null || p.candidateId !== scope.candidateId) return { reason: 'OUT_OF_SCOPE_ID', detail: `${p.actionType} must name this cycle's candidate` };
    if (p.positionId !== null) return { reason: 'PROPOSAL_INCONSISTENT', detail: `${p.actionType} cannot name a position` };
  } else if (POSITION_ACTIONS.has(p.actionType)) {
    if (scope.positionId === null || p.positionId !== scope.positionId) return { reason: 'OUT_OF_SCOPE_ID', detail: `${p.actionType} must name this cycle's position` };
    if (p.candidateId !== null && p.candidateId !== scope.candidateId) return { reason: 'OUT_OF_SCOPE_ID', detail: 'candidateId is not this cycle\'s candidate' };
  }
  if ((p.actionType === 'REDUCE') !== (p.requestedFractionToReduce !== null)) return { reason: 'PROPOSAL_INCONSISTENT', detail: 'requestedFractionToReduce is required for REDUCE and forbidden otherwise' };
  if (p.actionType === 'REDUCE' && (p.requestedFractionToReduce ?? 0) <= 0) return { reason: 'PROPOSAL_INCONSISTENT', detail: 'REDUCE fraction must be positive' };
  if (p.actionType === 'ADJUST_PROTECTION' && p.protectionIntent === null) return { reason: 'PROPOSAL_INCONSISTENT', detail: 'ADJUST_PROTECTION requires a protectionIntent' };
  if (compareInstants(p.expiresAt, scope.cutoffAt) <= 0) return { reason: 'PROPOSAL_INCONSISTENT', detail: 'proposal already expired at the cutoff' };
  const unknown = [...p.supportingEvidenceIds, ...p.contradictingEvidenceIds].filter((id) => !ledger.seenEvidenceIds.has(id));
  if (unknown.length > 0) return { reason: 'UNKNOWN_EVIDENCE_ID', detail: `evidence not shown to this run: ${unknown.slice(0, 5).join(',')}` };
  const both = p.supportingEvidenceIds.filter((id) => p.contradictingEvidenceIds.includes(id));
  if (both.length > 0) return { reason: 'PROPOSAL_INCONSISTENT', detail: 'evidence cited as both supporting and contradicting' };
  return null;
}
