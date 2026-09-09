import { addMs, instantToMs, type ActionCycleTerminalState, type Instant, type ReplayVariant, type S0SafetyGatePolicy, type S0Variant, type StrategyVersion } from '@sol-agent-trader/contracts';
import { guardedRows } from '@sol-agent-trader/replay';
import { decideS0, expireS0 } from '@sol-agent-trader/strategies';
import type { RecordedDecision, ReplayDecisionContext, ReplayStrategy, StrategyVerdict } from './types.js';

/**
 * Strategy plug-ins for the replay engine (blueprint §12.1, §18.5, P9). S0_RAW and S0_SAFE run
 * the same pure decision code the live worker runs, over the replayed snapshot and the simulated
 * clock. The recorded strategy replays the decisions a live S1 run actually made (Level B): the
 * model's outputs are the stored record, never re-asked (§18.5 "outputs themselves must be
 * stored"), and a decision cannot be applied before the moment the live worker finished it.
 */

export function s0ReplayStrategy(variant: S0Variant, version: StrategyVersion, gatePolicy: S0SafetyGatePolicy, variants: readonly ReplayVariant[] = ['FULL']): ReplayStrategy {
  return {
    version,
    variants,
    decide(ctx: ReplayDecisionContext): StrategyVerdict {
      const now = ctx.now;
      const age = instantToMs(now) - instantToMs(ctx.candidate.discoveredAt);
      if (age > version.maxCandidateAgeMs) {
        const cycle = expireS0({ cycleId: ctx.newId(), candidate: ctx.candidate, strategy: version, now });
        return { cycleState: cycle.state as ActionCycleTerminalState, action: null, proposerConfidence: null, adversaryVerdict: null, reasonCodes: ['CANDIDATE_EXPIRED'], decidedAt: now, decisionLatencyMs: 0, expiresAt: null };
      }
      const d = decideS0({ variant, ids: { cycleId: ctx.newId(), proposalId: ctx.newId(), reviewId: ctx.newId() }, candidate: ctx.candidate, snapshot: ctx.snapshot, strategy: version, gatePolicy, now });
      return {
        cycleState: d.cycle.state as ActionCycleTerminalState,
        action: d.cycle.state === 'CLEARED' ? 'ENTER' : null,
        proposerConfidence: d.proposal.proposal.confidence ?? null,
        adversaryVerdict: d.review.verdict,
        reasonCodes: d.review.objections.map((o) => o.code),
        decidedAt: now,
        decisionLatencyMs: 0,
        expiresAt: d.proposal.expiresAt,
      };
    },
  };
}

/**
 * Level B recorded decisions. `candidateKey` maps a replayed candidate to the live candidate the
 * record belongs to (same asset and trigger minute by default). PROPOSER_ONLY treats the stored
 * proposal as cleared whatever the adversary said; LATENCY_MATCHED is not meaningful for a
 * recorded strategy and is refused at construction.
 */
export function recordedReplayStrategy(version: StrategyVersion, variants: readonly ReplayVariant[] = ['FULL', 'PROPOSER_ONLY'], candidateKey: (c: { assetId: string; discoveredAt: Instant }) => string = (c) => `${c.assetId}:${Math.floor(instantToMs(c.discoveredAt) / 60_000)}`): ReplayStrategy {
  if (variants.includes('LATENCY_MATCHED')) throw new Error('a recorded strategy has no latency-matched variant');
  return {
    version,
    variants,
    decide(ctx: ReplayDecisionContext): StrategyVerdict {
      const key = candidateKey(ctx.candidate);
      // Point in time: a record is readable only once the live worker had finished deciding it.
      const visible = guardedRows('recorded_decisions', ctx.dataset.recorded.filter((r) => r.strategyVersionId === version.versionId).map((r) => ({ ...r, firstSeenAt: r.decidedAt })), ctx.now, ctx.guard);
      const rec = visible.find((r) => candidateKey({ assetId: ctx.candidate.assetId, discoveredAt: liveDiscoveredAt(r) }) === key) ?? null;
      if (!rec) return { cycleState: 'REJECTED', action: null, proposerConfidence: null, adversaryVerdict: null, reasonCodes: ['NOT_RECORDED'], decidedAt: ctx.now, decisionLatencyMs: 0, expiresAt: null };
      const latency = Math.max(0, instantToMs(rec.decidedAt) - instantToMs(rec.cycle.startedAt));
      const decidedAt = addMs(ctx.now, latency);
      const body = (rec.proposal?.proposal ?? {}) as { actionType?: string; confidence?: number | null };
      const confidence = typeof body.confidence === 'number' ? body.confidence : null;
      const verdict = rec.review?.verdict ?? null;
      const objections = rec.review?.objections.map((o) => o.code) ?? [];
      if (ctx.variant === 'PROPOSER_ONLY') {
        const proposed = rec.proposal !== null && body.actionType === 'ENTER';
        return { cycleState: proposed ? 'CLEARED' : 'REJECTED', action: proposed ? 'ENTER' : null, proposerConfidence: confidence, adversaryVerdict: null, reasonCodes: proposed ? [] : ['NO_ENTRY_PROPOSED'], decidedAt, decisionLatencyMs: latency, expiresAt: rec.proposal?.expiresAt ?? null };
      }
      const cleared = rec.cycle.state === 'CLEARED' && body.actionType === 'ENTER';
      return { cycleState: rec.cycle.state as ActionCycleTerminalState, action: cleared ? 'ENTER' : null, proposerConfidence: confidence, adversaryVerdict: verdict, reasonCodes: objections, decidedAt, decisionLatencyMs: latency, expiresAt: rec.proposal?.expiresAt ?? null };
    },
  };
}

function liveDiscoveredAt(r: RecordedDecision): Instant {
  return r.cycle.startedAt;
}
