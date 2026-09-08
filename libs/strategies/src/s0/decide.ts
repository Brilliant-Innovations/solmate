import { newActionCycle, transition, type ActionCycleEvent } from '@sol-agent-trader/agents';
import { S0_RAW_UNGATED_REASON, type ActionCycle, type AdversarialReview, type Candidate, type FeatureSnapshot, type Instant, type Proposal, type S0SafetyGatePolicy, type S0Variant, type StrategyVersion, type Uuid } from '@sol-agent-trader/contracts';
import { evaluateS0SafetyGate, type S0GateResult } from './gate.js';
import { proposeS0Entry } from './proposer.js';

/**
 * One S0 decision as an action cycle (execution plan M5a: "every S0_SAFE decision is persisted
 * as an action cycle with the deterministic gate recorded as the adversary"). The cycle runs the
 * shared machine: TRIGGERED → CONTEXT_BUILT → PROPOSED → ADVERSARY_REVIEWED → CLEARED/REJECTED.
 *
 * - SAFE: the gate is the adversary; REJECT ends the cycle REJECTED and nothing downstream sees it.
 * - RAW: the same gate output is recorded as a non-blocking, informational review and the cycle
 *   always clears, so every SAFE rejection has its RAW hypothetical action beside it (§12.1).
 *   RAW authority is bounded by its strategy version (OBSERVE/PAPER only), never by this code.
 *
 * Pure: identical stored inputs reproduce identical cycle, proposal and review (exit gate).
 */

export interface S0DecisionInput {
  variant: S0Variant;
  ids: { cycleId: Uuid; proposalId: Uuid; reviewId: Uuid };
  candidate: Candidate;
  snapshot: FeatureSnapshot;
  strategy: StrategyVersion;
  gatePolicy: S0SafetyGatePolicy;
  now: Instant;
}

export interface S0Decision {
  variant: S0Variant;
  cycle: ActionCycle;
  proposal: Proposal;
  review: AdversarialReview;
  gate: S0GateResult;
}

/**
 * D32 / §12.3: a candidate older than the strategy's own candidate-age contract at decision time
 * yields an EXPIRED cycle, never a late decision. No proposal and no review exist for it.
 */
export function expireS0(input: { cycleId: Uuid; candidate: Candidate; strategy: StrategyVersion; now: Instant }): ActionCycle {
  const cycle = newActionCycle({ id: input.cycleId, triggerId: input.candidate.id, strategyVersionId: input.strategy.versionId, speedTier: input.strategy.speedTier, decisionBudgetMs: input.strategy.maxDecisionLatencyMs, startedAt: input.now, candidateId: input.candidate.id });
  const r = transition(cycle, { type: 'EXPIRED', at: input.now });
  if (!r.ok) throw new Error(`S0 cycle rejected EXPIRED: ${JSON.stringify(r.rejection)}`);
  return r.cycle;
}

export function decideS0(input: S0DecisionInput): S0Decision {
  const { candidate, snapshot, strategy, now } = input;
  let cycle = newActionCycle({
    id: input.ids.cycleId,
    triggerId: candidate.id,
    strategyVersionId: strategy.versionId,
    speedTier: strategy.speedTier,
    decisionBudgetMs: strategy.maxDecisionLatencyMs,
    startedAt: now,
    candidateId: candidate.id,
  });
  const cutoffVersion = 1;
  const proposal = proposeS0Entry({ id: input.ids.proposalId, actionCycleId: cycle.id, candidate, snapshot, strategy, now, cutoffVersion });
  const gate = evaluateS0SafetyGate({ candidate, snapshot, policy: input.gatePolicy, now, cutoffVersion });
  const safe = input.variant === 'SAFE';
  const verdict = safe ? gate.verdict : 'CONFIRM';
  const reasonCodes = safe ? gate.objections.map((o) => o.code) : [S0_RAW_UNGATED_REASON, ...gate.objections.map((o) => o.code)];

  const events: ActionCycleEvent[] = [
    { type: 'CONTEXT_BUILT', at: now },
    { type: 'PROPOSED', at: now, runId: null, proposalId: proposal.id, action: 'ENTER', cutoffVersion },
    { type: 'ADVERSARY_REVIEWED', at: now, runId: null, verdict, cutoffVersion, reasonCodes },
  ];
  for (const e of events) {
    const r = transition(cycle, e);
    if (!r.ok) throw new Error(`S0 cycle rejected ${e.type}: ${JSON.stringify(r.rejection)}`);
    cycle = r.cycle;
  }

  const review: AdversarialReview = {
    id: input.ids.reviewId,
    actionCycleId: cycle.id,
    agentRunId: null,
    deterministicGate: true,
    verdict,
    objections: gate.output.objections,
    confidence: 1,
    cutoffVersion,
    latencyMs: 0,
    blocking: safe,
    createdAt: now,
  };
  return { variant: input.variant, cycle, proposal, review, gate };
}
