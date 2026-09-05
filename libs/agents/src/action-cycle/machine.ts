import {
  ActionCycleState,
  AdversaryVerdict,
  DiscretionaryExposureAction,
  TradingActionType,
  UnresolvedReason,
  type ActionCycle,
  type EvidenceCutoff,
  type Instant,
  type Uuid,
} from '@sol-agent-trader/contracts';

/**
 * Action-cycle state machine (blueprint §11.8–§11.9, D30, D40, ADR-0001).
 *
 * Pure: `transition(cycle, event)` returns a new cycle or a typed rejection. It owns no position
 * behavior; a position's reaction to an UNRESOLVED terminal lives in the position-review machine
 * (`libs/execution/src/state/position-review.ts`).
 *
 * Rules encoded here:
 * - one revision round at most (§11.9);
 * - proposer and adversary must share the current evidence cutoff; a refresh creates a new cutoff
 *   and invalidates any proposal made under the old one (D40, INV-19);
 * - CONFIRM clears, REJECT rejects, a CHALLENGE after the revision budget is spent is DISAGREEMENT;
 * - outage, timeout, budget exhaustion and malformed output terminate UNRESOLVED with the D39 reason;
 * - terminal states are absorbing;
 * - only a CLEARED cycle whose cleared cutoff is the latest cutoff can feed authorization (INV-14).
 */

export type ActionCycleEvent =
  | { type: 'CONTEXT_BUILT'; at: Instant }
  | { type: 'PROPOSED'; at: Instant; runId: Uuid | null; proposalId: Uuid | null; action: TradingActionType; cutoffVersion: number }
  | { type: 'ADVERSARY_REVIEWED'; at: Instant; runId: Uuid | null; verdict: AdversaryVerdict; cutoffVersion: number; reasonCodes: string[] }
  | { type: 'EVIDENCE_REFRESHED'; at: Instant }
  | { type: 'ADVERSARY_UNAVAILABLE'; at: Instant }
  | { type: 'TIMEOUT'; at: Instant }
  | { type: 'BUDGET_EXHAUSTED'; at: Instant }
  | { type: 'MALFORMED_OUTPUT'; at: Instant }
  | { type: 'EXPIRED'; at: Instant };

export type TransitionRejection =
  | { code: 'TERMINAL_STATE'; state: ActionCycleState }
  | { code: 'INVALID_FROM_STATE'; state: ActionCycleState; event: ActionCycleEvent['type'] }
  | { code: 'CUTOFF_MISMATCH'; expected: number; got: number }
  | { code: 'ACTION_NOT_ALLOWED'; action: TradingActionType };

export type TransitionResult = { ok: true; cycle: ActionCycle } | { ok: false; rejection: TransitionRejection };

const TERMINAL: ReadonlySet<ActionCycleState> = new Set(['CLEARED', 'REJECTED', 'EXPIRED', 'UNRESOLVED']);
export const MAX_REVISION_ROUNDS = 1;

export function isTerminal(cycle: Pick<ActionCycle, 'state'>): boolean {
  return TERMINAL.has(cycle.state);
}

export function latestCutoff(cycle: Pick<ActionCycle, 'cutoffs'>): EvidenceCutoff {
  const c = cycle.cutoffs[cycle.cutoffs.length - 1];
  if (!c) throw new Error('action cycle has no cutoff');
  return c;
}

function reject(rejection: TransitionRejection): TransitionResult {
  return { ok: false, rejection };
}

function terminate(cycle: ActionCycle, state: ActionCycleState, at: Instant, extra: Partial<ActionCycle> = {}): TransitionResult {
  return { ok: true, cycle: { ...cycle, ...extra, state, terminalAt: at } };
}

function unresolved(cycle: ActionCycle, reason: UnresolvedReason, at: Instant, reasonCodes: string[] = []): TransitionResult {
  return terminate(cycle, 'UNRESOLVED', at, {
    unresolvedReason: reason,
    reasonCodes: [...cycle.reasonCodes, ...reasonCodes],
  });
}

function consume(cycle: ActionCycle, runId: Uuid | null): EvidenceCutoff[] {
  if (!runId) return cycle.cutoffs;
  const last = latestCutoff(cycle);
  return [...cycle.cutoffs.slice(0, -1), { ...last, consumedByRunIds: [...last.consumedByRunIds, runId] }];
}

export function transition(cycle: ActionCycle, event: ActionCycleEvent): TransitionResult {
  if (isTerminal(cycle)) return reject({ code: 'TERMINAL_STATE', state: cycle.state });

  switch (event.type) {
    case 'EXPIRED':
      return terminate(cycle, 'EXPIRED', event.at);
    case 'ADVERSARY_UNAVAILABLE':
      return unresolved(cycle, 'ADVERSARY_UNAVAILABLE', event.at);
    case 'TIMEOUT':
      return unresolved(cycle, 'TIMEOUT', event.at);
    case 'BUDGET_EXHAUSTED':
      return unresolved(cycle, 'BUDGET', event.at);
    case 'MALFORMED_OUTPUT':
      return unresolved(cycle, 'MALFORMED_OUTPUT', event.at);

    case 'CONTEXT_BUILT': {
      if (cycle.state !== 'TRIGGERED') return reject({ code: 'INVALID_FROM_STATE', state: cycle.state, event: event.type });
      return { ok: true, cycle: { ...cycle, state: 'CONTEXT_BUILT' } };
    }

    case 'EVIDENCE_REFRESHED': {
      // D40: a refresh mints cutoff vN+1. A pending proposal made under vN is invalidated and the
      // proposer must re-propose (from CONTEXT_BUILT); a requested revision simply targets the new cutoff.
      if (!['CONTEXT_BUILT', 'PROPOSED', 'REVISION_REQUESTED'].includes(cycle.state)) {
        return reject({ code: 'INVALID_FROM_STATE', state: cycle.state, event: event.type });
      }
      const next: EvidenceCutoff = { version: latestCutoff(cycle).version + 1, at: event.at, consumedByRunIds: [] };
      const state: ActionCycleState = cycle.state === 'PROPOSED' ? 'CONTEXT_BUILT' : cycle.state;
      return { ok: true, cycle: { ...cycle, state, cutoffs: [...cycle.cutoffs, next], proposedAction: state === 'CONTEXT_BUILT' ? null : cycle.proposedAction, proposalId: state === 'CONTEXT_BUILT' ? null : cycle.proposalId } };
    }

    case 'PROPOSED': {
      const from = cycle.state;
      if (from !== 'CONTEXT_BUILT' && from !== 'REVISION_REQUESTED') {
        return reject({ code: 'INVALID_FROM_STATE', state: from, event: event.type });
      }
      const current = latestCutoff(cycle).version;
      if (event.cutoffVersion !== current) return reject({ code: 'CUTOFF_MISMATCH', expected: current, got: event.cutoffVersion });
      const base: ActionCycle = {
        ...cycle,
        cutoffs: consume(cycle, event.runId),
        proposerRunIds: event.runId ? [...cycle.proposerRunIds, event.runId] : cycle.proposerRunIds,
        proposedAction: event.action,
        proposalId: event.proposalId,
      };
      // IGNORE is an explicit no-trade decision; the adversary reviews exposure decisions only (§11.9).
      if (event.action === 'IGNORE') {
        return terminate(base, 'CLEARED', event.at, { verdict: null, clearedCutoffVersion: current });
      }
      return { ok: true, cycle: { ...base, state: 'PROPOSED' } };
    }

    case 'ADVERSARY_REVIEWED': {
      if (cycle.state !== 'PROPOSED') return reject({ code: 'INVALID_FROM_STATE', state: cycle.state, event: event.type });
      const current = latestCutoff(cycle).version;
      if (event.cutoffVersion !== current) return reject({ code: 'CUTOFF_MISMATCH', expected: current, got: event.cutoffVersion });
      const reviewed: ActionCycle = {
        ...cycle,
        cutoffs: consume(cycle, event.runId),
        adversaryRunIds: event.runId ? [...cycle.adversaryRunIds, event.runId] : cycle.adversaryRunIds,
        verdict: event.verdict,
        reasonCodes: [...cycle.reasonCodes, ...event.reasonCodes],
      };
      switch (event.verdict) {
        case 'CONFIRM':
          return terminate(reviewed, 'CLEARED', event.at, { clearedCutoffVersion: current });
        case 'REJECT':
          return terminate(reviewed, 'REJECTED', event.at);
        case 'CHALLENGE':
          if (cycle.revisionRound >= MAX_REVISION_ROUNDS) return unresolved(reviewed, 'DISAGREEMENT', event.at);
          return { ok: true, cycle: { ...reviewed, state: 'REVISION_REQUESTED', revisionRound: cycle.revisionRound + 1 } };
      }
    }
  }
}

/** A cycle may feed deterministic risk authorization only under these exact conditions (INV-14, INV-19). */
export function canAuthorize(cycle: ActionCycle): boolean {
  if (cycle.state !== 'CLEARED') return false;
  if (cycle.proposedAction === null || !DiscretionaryExposureAction.options.includes(cycle.proposedAction as never)) return false;
  return cycle.clearedCutoffVersion !== null && cycle.clearedCutoffVersion === latestCutoff(cycle).version;
}

export function newActionCycle(init: {
  id: Uuid;
  triggerId: Uuid;
  strategyVersionId: ActionCycle['strategyVersionId'];
  speedTier: ActionCycle['speedTier'];
  decisionBudgetMs: number;
  startedAt: Instant;
  candidateId?: Uuid | null;
  positionId?: Uuid | null;
  skillVersionId?: ActionCycle['skillVersionId'];
  guidelineVersionId?: ActionCycle['guidelineVersionId'];
  automationRunId?: Uuid | null;
}): ActionCycle {
  return {
    id: init.id,
    automationRunId: init.automationRunId ?? null,
    triggerId: init.triggerId,
    candidateId: init.candidateId ?? null,
    positionId: init.positionId ?? null,
    strategyVersionId: init.strategyVersionId,
    skillVersionId: init.skillVersionId ?? null,
    guidelineVersionId: init.guidelineVersionId ?? null,
    speedTier: init.speedTier,
    decisionBudgetMs: init.decisionBudgetMs,
    proposedAction: null,
    proposalId: null,
    proposerRunIds: [],
    adversaryRunIds: [],
    verdict: null,
    reasonCodes: [],
    revisionRound: 0,
    state: 'TRIGGERED',
    unresolvedReason: null,
    cutoffs: [{ version: 1, at: init.startedAt, consumedByRunIds: [] }],
    clearedCutoffVersion: null,
    riskEvaluationId: null,
    intentId: null,
    startedAt: init.startedAt,
    terminalAt: null,
  };
}

export { ActionCycleState, AdversaryVerdict, UnresolvedReason };
