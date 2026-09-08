import { addMs, instantToMs, type ActionCycle, type AssetEligibility, type EvidenceCutoff, type EvidenceItem, type FeatureSnapshot, type HeldAssetSafety, type Instant, type IntelligenceEvent, type MarketSnapshot, type SkillVersion, type StrategyVersion, type ToolScope, type TradingActionType, type TradingSkillContext, type AdversarialReviewOutput, type Uuid } from '@sol-agent-trader/contracts';
import type { ContextSources, PositionFacts } from './sources.js';

/**
 * Point-in-time context builder (blueprint §11.3, §11.13, §18.3, D40; INV-13). Everything in the
 * packet is what was first seen or observed at or before the cutoff. Stale data is labelled, never
 * zero-filled (§32 "Can stale or missing market/risk data appear as a valid zero?"). Text from
 * providers is carried as quoted evidence with an id the model may cite; nothing else in the packet
 * is citable.
 */

export interface ContextBuildInput {
  cycle: Pick<ActionCycle, 'id' | 'candidateId' | 'positionId' | 'strategyVersionId' | 'triggerId' | 'speedTier' | 'startedAt' | 'decisionBudgetMs'>;
  cutoff: EvidenceCutoff;
  accountId: Uuid;
  strategy: Pick<StrategyVersion, 'versionId' | 'speedTier' | 'chaseToleranceBps' | 'maxCandidateAgeMs' | 'maxQuoteAgeMs' | 'allowedActionTypes' | 'thresholds' | 'guidelineVersionId'>;
  skill: Pick<SkillVersion, 'versionId' | 'supportedActionTypes'>;
  /** The machine's allowed actions for this target; intersected with the skill and strategy. */
  machineAllowed: readonly TradingActionType[];
  revision: { round: number; objections: AdversarialReviewOutput['objections'] };
  policy: ContextBuildPolicy;
}

export interface ContextBuildPolicy {
  version: string;
  maxEvents: number;
  /** A market or feature snapshot older than this at the cutoff is labelled stale. */
  staleAfterMs: number;
  /** Quoted text per event is truncated to this many characters. */
  maxQuotedChars: number;
}

export const DEFAULT_CONTEXT_BUILD_POLICY: ContextBuildPolicy = { version: 'ctx-v1', maxEvents: 25, staleAfterMs: 15 * 60_000, maxQuotedChars: 1_500 };

export interface BuiltSkillContext {
  context: TradingSkillContext;
  scope: ToolScope;
  assetId: Uuid;
}

export class ContextUnavailableError extends Error {
  constructor(
    readonly code: 'TARGET_NOT_FOUND' | 'TARGET_NOT_VISIBLE',
    message: string,
  ) {
    super(message);
    this.name = 'ContextUnavailableError';
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function ageFacts(observedAt: Instant, asOf: Instant, staleAfterMs: number): { ageMs: number; stale: boolean } {
  const ageMs = Math.max(0, instantToMs(asOf) - instantToMs(observedAt));
  return { ageMs, stale: ageMs > staleAfterMs };
}

export function featureEvidence(s: FeatureSnapshot, asOf: Instant, policy: ContextBuildPolicy): EvidenceItem {
  const facts: Record<string, unknown> = { ...ageFacts(s.asOf, asOf, policy.staleAfterMs), engine: s.featureEngineVersion, provenance: s.provenance, regime: s.regime, marketSessions: s.marketSessions, selfInfluenceSuppressed: s.selfInfluenceSuppressed };
  for (const [k, v] of Object.entries(s.features)) facts[k] = v === null ? 'missing' : v;
  return { id: s.id, kind: 'FEATURE_SNAPSHOT', observedAt: s.asOf, quality: null, quoted: '', facts };
}

export function marketEvidence(m: MarketSnapshot, asOf: Instant, policy: ContextBuildPolicy): EvidenceItem {
  const facts: Record<string, unknown> = { ...ageFacts(m.observedAt, asOf, policy.staleAfterMs), provenance: m.provenance, priceUsd: m.priceUsd ?? 'missing', liquidityUsd: m.liquidityUsd ?? 'missing', relativeVolume: m.relativeVolume ?? 'missing', atr: m.atr ?? 'missing' };
  for (const [w, v] of Object.entries(m.volumeUsd ?? {})) facts[`volumeUsd_${w}`] = v ?? 'missing';
  return { id: m.id, kind: 'FEATURE_SNAPSHOT', observedAt: m.observedAt, quality: null, quoted: '', facts };
}

export function eligibilityEvidence(e: AssetEligibility, asOf: Instant, policy: ContextBuildPolicy): EvidenceItem {
  return { id: e.id, kind: 'SAFETY_STATE', observedAt: e.evaluatedAt, quality: null, quoted: '', facts: { ...ageFacts(e.evaluatedAt, asOf, policy.staleAfterMs), eligible: e.eligible, hardReject: e.hardReject, rejectionReasons: e.rejectionReasons, grade: e.grade ?? 'missing', liquidityUsd: e.liquidityUsd ?? 'missing', holderCount: e.holderCount ?? 'missing', mintAuthority: e.mintAuthority, policyVersion: e.policyVersion } };
}

export function safetyEvidence(s: HeldAssetSafety, asOf: Instant, policy: ContextBuildPolicy): EvidenceItem {
  return { id: s.id, kind: 'SAFETY_STATE', observedAt: s.evaluatedAt, quality: null, quoted: '', facts: { ...ageFacts(s.evaluatedAt, asOf, policy.staleAfterMs), state: s.state, previousState: s.previousState, reasons: s.reasons, exitCompatibility: s.exitCompatibility, liquidityUsd: s.liquidityUsd ?? 'missing', policyVersion: s.policyVersion } };
}

export function eventEvidence(e: IntelligenceEvent, asOf: Instant, policy: ContextBuildPolicy): EvidenceItem {
  const quoted = [e.title, e.summary].filter((t): t is string => typeof t === 'string' && t.length > 0).join(' — ').slice(0, policy.maxQuotedChars);
  const sourceAgeMs = e.sourcePublishedAt ? Math.max(0, instantToMs(asOf) - instantToMs(e.sourcePublishedAt)) : null;
  return { id: e.id, kind: 'EVENT', observedAt: e.firstSeenAt, quality: e.sourceQuality, quoted, facts: { kind: e.kind, provider: e.sourceProvider, sourceTimeConfidence: e.sourceTimeConfidence, sourceAgeMs: sourceAgeMs ?? 'unknown', firstSeenAgeMs: Math.max(0, instantToMs(asOf) - instantToMs(e.firstSeenAt)), noveltyScore: e.noveltyScore ?? 'unknown', clusterId: e.clusterId, corroboratesEventId: e.corroboratesEventId, sentiment: e.sentiment?.score ?? 'unknown', classification: e.classification ?? 'unknown' } };
}

export function positionEvidence(p: PositionFacts, asOf: Instant, policy: ContextBuildPolicy): EvidenceItem {
  const markFacts = p.markAt ? ageFacts(p.markAt, asOf, policy.staleAfterMs) : { ageMs: 'unknown', stale: true };
  const excursion = p.averageEntryPrice && p.markPrice ? (p.markPrice - p.averageEntryPrice) / p.averageEntryPrice : 'unknown';
  return { id: p.id, kind: 'POSITION_STATE', observedAt: p.markAt ?? p.openedAt, quality: null, quoted: [p.thesis ? `thesis: ${p.thesis}` : '', p.invalidation ? `invalidation: ${p.invalidation}` : ''].filter(Boolean).join(' | ').slice(0, policy.maxQuotedChars), facts: { ...markFacts, symbol: p.symbol, quantity: p.quantity, averageEntryPrice: p.averageEntryPrice ?? 'unknown', markPrice: p.markPrice ?? 'unknown', excursion, unrealizedPnlBaseUnits: p.unrealizedPnlBaseUnits ?? 'unknown', stop: p.stop, target: p.target, unreviewedStop: p.unreviewedStop, protectionMode: p.protectionMode, safetyState: p.safetyState, reviewState: p.reviewState, openedAt: p.openedAt, heldMs: Math.max(0, instantToMs(asOf) - instantToMs(p.openedAt)), expectedHorizonEndsAt: p.expectedHorizonEndsAt } };
}

export async function buildTradingSkillContext(sources: ContextSources, input: ContextBuildInput): Promise<BuiltSkillContext> {
  const { cycle, cutoff, policy } = input;
  const asOf = cutoff.at;
  let assetId: Uuid;
  const evidence: EvidenceItem[] = [];
  let positionFacts: PositionFacts | null = null;
  if (cycle.positionId !== null) {
    positionFacts = await sources.position(cycle.positionId, asOf);
    if (!positionFacts) throw new ContextUnavailableError('TARGET_NOT_FOUND', `position ${cycle.positionId} not found`);
    assetId = positionFacts.assetId;
    evidence.push(positionEvidence(positionFacts, asOf, policy));
    const safety = await sources.safetyAt(cycle.positionId, asOf);
    if (safety) evidence.push(safetyEvidence(safety, asOf, policy));
  } else if (cycle.candidateId !== null) {
    const candidate = await sources.candidate(cycle.candidateId, asOf);
    if (!candidate) throw new ContextUnavailableError('TARGET_NOT_FOUND', `candidate ${cycle.candidateId} not found`);
    if (instantToMs(candidate.discoveredAt) > instantToMs(asOf)) throw new ContextUnavailableError('TARGET_NOT_VISIBLE', `candidate ${cycle.candidateId} discovered after the cutoff`);
    assetId = candidate.assetId;
    evidence.push({ id: candidate.id, kind: 'FEATURE_SNAPSHOT', observedAt: candidate.discoveredAt, quality: null, quoted: '', facts: { triggerFamily: candidate.triggerFamily, scannerScore: candidate.scannerScore, discoveredAt: candidate.discoveredAt, expiresAt: candidate.expiresAt, candidateAgeMs: Math.max(0, instantToMs(asOf) - instantToMs(candidate.discoveredAt)), triggerDetails: candidate.triggerDetails } });
  } else {
    throw new ContextUnavailableError('TARGET_NOT_FOUND', 'cycle has neither candidate nor position');
  }
  const [features, market, eligibility, events, onchain] = await Promise.all([
    sources.featureSnapshotAt(assetId, asOf),
    sources.marketSnapshotAt(assetId, asOf),
    sources.eligibilityAt(assetId, asOf),
    sources.eventsVisibleAt(assetId, asOf, policy.maxEvents),
    sources.onchainAt(assetId, asOf),
  ]);
  if (features) evidence.push(featureEvidence(features, asOf, policy));
  if (market) evidence.push(marketEvidence(market, asOf, policy));
  if (eligibility) evidence.push(eligibilityEvidence(eligibility, asOf, policy));
  if (onchain) evidence.push({ id: `${assetId}` as Uuid, kind: 'ONCHAIN_CONTEXT', observedAt: onchain.asOf, quality: null, quoted: '', facts: { ...onchain, assetId: undefined } as Record<string, unknown> });
  for (const e of events) {
    if (instantToMs(e.firstSeenAt) > instantToMs(asOf)) continue; // defence in depth: INV-13 is enforced in SQL too
    evidence.push(eventEvidence(e, asOf, policy));
  }
  const peers = await sources.cohortPeers(assetId, asOf);
  const allowed = input.machineAllowed.filter((a) => input.skill.supportedActionTypes.includes(a) && input.strategy.allowedActionTypes.includes(a));
  const deadlineAt = addMs(cycle.startedAt, cycle.decisionBudgetMs);
  const context: TradingSkillContext = {
    actionCycleId: cycle.id,
    candidateId: cycle.candidateId,
    positionId: cycle.positionId,
    assetId,
    strategyVersionId: cycle.strategyVersionId,
    skillVersionId: input.skill.versionId,
    guidelineVersionId: input.strategy.guidelineVersionId,
    speedTier: cycle.speedTier,
    triggerId: cycle.triggerId,
    allowedActions: allowed.length > 0 ? allowed : ['IGNORE'],
    cutoffVersion: cutoff.version,
    cutoffAt: asOf,
    deadlineAt,
    evidence: dedupeById(evidence),
    strategyFacts: { speedTier: input.strategy.speedTier, chaseToleranceBps: input.strategy.chaseToleranceBps, maxCandidateAgeMs: input.strategy.maxCandidateAgeMs, maxQuoteAgeMs: input.strategy.maxQuoteAgeMs, thresholds: input.strategy.thresholds, contextPolicy: policy.version, staleAfterMs: policy.staleAfterMs },
    revisionRound: Math.min(1, input.revision.round),
    priorObjections: input.revision.objections,
  };
  const scope: ToolScope = {
    actionCycleId: cycle.id,
    accountId: input.accountId,
    candidateId: cycle.candidateId,
    positionId: cycle.positionId,
    assetIds: [assetId, ...peers.filter((p) => p !== assetId)],
    strategyVersionId: cycle.strategyVersionId,
    skillVersionId: input.skill.versionId,
    supportedActionTypes: context.allowedActions,
    triggerId: cycle.triggerId,
    cutoffVersion: cutoff.version,
    cutoffAt: asOf,
    evidenceIds: context.evidence.map((e) => e.id),
  };
  return { context, scope, assetId };
}

function dedupeById(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

export { num as numberOrNull };
