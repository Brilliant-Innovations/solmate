import {
  AdversarialReviewOutput,
  TradingActionProposal,
  addMs,
  instantToMs,
  type ActionCycle,
  type AdversarialReview,
  type AgentRole,
  type AgentRun,
  type Clock,
  type DiscretionaryCyclePolicy,
  type EvidenceCutoff,
  type Instant,
  type Proposal,
  type StrategyVersion,
  type ToolScope,
  type TradingActionType,
  type TradingSkillContext,
  type UnresolvedReason,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { checkProposal, newRunLedger } from '@sol-agent-trader/skills';
import { allowedActions, latestCutoff, newActionCycle, transition, type ActionCycleEvent, type TransitionOptions } from '../action-cycle/machine.js';
import type { SpendGateResult } from '../budget/spend-gate.js';
import { redactString } from '@sol-agent-trader/observability';
import { ModelTimeoutError, type ModelCall, type ReasoningModel } from './model.js';

/**
 * Discretionary action-cycle runner (blueprint §11.8–11.9, §11.13, D30, D39, D40, D43).
 *
 * Drives one cycle through the shared machine with an injected reasoning model, a context builder
 * and a spend gate. Rules the runner enforces on top of the machine:
 * - the spend gate runs before any model call; a breach ends UNRESOLVED(BUDGET) with zero runs;
 * - proposer and adversary receive the same packet under the same cutoff; a revision after a
 *   permitted refresh rebuilds the packet at cutoff vN+1 for both (D40);
 * - every model output is validated against the typed contract and the cycle scope; malformed,
 *   hallucinated or out-of-scope output ends UNRESOLVED(MALFORMED_OUTPUT), never a guessed action;
 * - the adversary can only return a verdict on the submitted proposal and may cite only evidence in
 *   the packet or the proposal; it cannot add evidence, edit or upgrade the proposal;
 * - provider failure ends UNRESOLVED(ADVERSARY_UNAVAILABLE); a call that overruns ends
 *   UNRESOLVED(TIMEOUT); a budget with too little time left for the next call EXPIRES the cycle;
 * - the runner records an `AgentRun` for every call, success or not, and returns everything the
 *   worker persists in one transaction. It owns no position behaviour (ADR-0001).
 */

export interface BuiltContext {
  context: TradingSkillContext;
  scope: ToolScope;
}

export interface CycleRunnerDeps {
  proposer: ReasoningModel;
  adversary: ReasoningModel;
  /** Point-in-time context at the given cutoff; called again on a permitted refresh. */
  buildContext(cycle: ActionCycle, cutoff: EvidenceCutoff, revision: { round: number; objections: AdversarialReviewOutput['objections'] }): Promise<BuiltContext>;
  spendGate(cycle: ActionCycle): Promise<SpendGateResult> | SpendGateResult;
  clock: Clock;
  newId: () => Uuid;
  policy: DiscretionaryCyclePolicy;
  options?: TransitionOptions;
}

export interface CycleRunInput {
  id: Uuid;
  triggerId: Uuid;
  strategy: Pick<StrategyVersion, 'versionId' | 'speedTier' | 'maxDecisionLatencyMs' | 'skillVersionId' | 'guidelineVersionId'>;
  candidateId?: Uuid | null;
  positionId?: Uuid | null;
  automationRunId?: Uuid | null;
}

export interface CycleRunOutcome {
  cycle: ActionCycle;
  proposals: Proposal[];
  reviews: AdversarialReview[];
  runs: AgentRun[];
  /** Why the cycle ended the way it did, for logs and the Inspector. */
  notes: string[];
}

type CallResult<T> = { kind: 'OK'; value: T; run: AgentRun } | { kind: 'MALFORMED'; run: AgentRun; errors: string[] } | { kind: 'TIMEOUT'; run: AgentRun } | { kind: 'OUTAGE'; run: AgentRun; error: string };

export async function runDiscretionaryCycle(deps: CycleRunnerDeps, input: CycleRunInput): Promise<CycleRunOutcome> {
  const { clock, policy } = deps;
  const out: CycleRunOutcome = { cycle: newActionCycle({ ...input, strategyVersionId: input.strategy.versionId, speedTier: input.strategy.speedTier, decisionBudgetMs: input.strategy.maxDecisionLatencyMs, startedAt: clock.now(), skillVersionId: input.strategy.skillVersionId, guidelineVersionId: input.strategy.guidelineVersionId }), proposals: [], reviews: [], runs: [], notes: [] };
  const deadlineAt = addMs(out.cycle.startedAt, out.cycle.decisionBudgetMs);
  const step = (e: ActionCycleEvent) => {
    const r = transition(out.cycle, e, deps.options);
    if (!r.ok) throw new Error(`action cycle ${out.cycle.id} rejected ${e.type} from ${out.cycle.state}: ${JSON.stringify(r.rejection)}`);
    out.cycle = r.cycle;
  };
  const end = (reason: UnresolvedReason, note: string) => {
    out.notes.push(note);
    const type = ({ BUDGET: 'BUDGET_EXHAUSTED', ADVERSARY_UNAVAILABLE: 'ADVERSARY_UNAVAILABLE', TIMEOUT: 'TIMEOUT', MALFORMED_OUTPUT: 'MALFORMED_OUTPUT', DISAGREEMENT: 'MALFORMED_OUTPUT', REVISION_EXHAUSTED: 'MALFORMED_OUTPUT' } as const)[reason];
    step({ type, at: clock.now() });
    return out;
  };
  const expire = (note: string) => {
    out.notes.push(note);
    step({ type: 'EXPIRED', at: clock.now() });
    return out;
  };
  const remainingMs = () => instantToMs(deadlineAt) - clock.nowMs();

  // D43: budgets before any model call.
  const gate = await deps.spendGate(out.cycle);
  if (!gate.ok) return end('BUDGET', `spend gate: ${gate.block.code} (${gate.block.scope} ${gate.block.budgetId})`);

  if (input.strategy.skillVersionId === null) return expire('strategy has no skill version bound; discretionary cycles need one (§11.1)');

  let built: BuiltContext;
  try {
    built = await deps.buildContext(out.cycle, latestCutoff(out.cycle), { round: 0, objections: [] });
  } catch (e) {
    return end('ADVERSARY_UNAVAILABLE', `context builder failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
  step({ type: 'CONTEXT_BUILT', at: clock.now() });
  if (policy.requireDistinctAdversaryModel && sameModel(deps)) return end('ADVERSARY_UNAVAILABLE', 'adversary must run on a model distinct from the proposer (policy)');

  let objections: AdversarialReviewOutput['objections'] = [];
  for (let round = 0; ; round++) {
    const cutoff = latestCutoff(out.cycle);
    if (round > 0) {
      if (policy.refreshEvidenceOnRevision) {
        step({ type: 'EVIDENCE_REFRESHED', at: clock.now() });
        try {
          built = await deps.buildContext(out.cycle, latestCutoff(out.cycle), { round, objections });
        } catch (e) {
          return end('ADVERSARY_UNAVAILABLE', `context refresh failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        }
      } else {
        built = { ...built, context: { ...built.context, revisionRound: 1, priorObjections: objections } };
      }
    }
    const current = latestCutoff(out.cycle);
    const scope = bindScope(out.cycle, built, current, deadlineAt, round, objections, deps.options);
    built = scope.built;

    if (remainingMs() < policy.minRemainingBudgetMs) return expire(`decision budget exhausted before proposer round ${round}`);
    const proposed = await callModel<TradingActionProposal>(deps, 'TRADING_PROPOSER', out.cycle, scope.built.context, (signal) => deps.proposer.proposeTradingAction(scope.built.context, signal), (raw) => {
      const parsed = TradingActionProposal.safeParse(raw);
      if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`) };
      const violation = checkProposal(parsed.data, scope.built.scope, newRunLedger(scope.built.scope));
      if (violation) return { ok: false, errors: [`${violation.reason}: ${violation.detail}`] };
      if (parsed.data.confidence < policy.minConfidence && parsed.data.actionType !== 'IGNORE') return { ok: false, errors: [`LOW_CONFIDENCE: ${parsed.data.confidence} < ${policy.minConfidence}`] };
      return { ok: true, value: parsed.data };
    }, remainingMs());
    out.runs.push(proposed.run);
    if (proposed.kind !== 'OK') return failCall(proposed, 'proposer', end);
    const proposal: Proposal = { id: deps.newId(), actionCycleId: out.cycle.id, candidateId: out.cycle.candidateId, positionId: out.cycle.positionId, strategyVersionId: out.cycle.strategyVersionId, source: 'AI', proposal: proposed.value, createdAt: clock.now(), expiresAt: proposed.value.expiresAt };
    out.proposals.push(proposal);
    step({ type: 'PROPOSED', at: clock.now(), runId: proposed.run.id, proposalId: proposal.id, action: proposed.value.actionType, cutoffVersion: current.version });
    if (out.cycle.state === 'CLEARED') {
      out.notes.push('IGNORE is an explicit no-trade decision; no exposure, no adversary (§11.9)');
      return out;
    }

    if (remainingMs() < policy.minRemainingBudgetMs) return expire(`decision budget exhausted before adversary round ${round}`);
    const packetIds = new Set<string>([...scope.built.context.evidence.map((e) => e.id), ...proposed.value.supportingEvidenceIds, ...proposed.value.contradictingEvidenceIds]);
    const reviewed = await callModel<AdversarialReviewOutput>(deps, 'ACTION_ADVERSARY', out.cycle, scope.built.context, (signal) => deps.adversary.adversariallyReviewAction({ context: scope.built.context, proposalId: proposal.id, proposal: proposed.value }, signal), (raw) => {
      const parsed = AdversarialReviewOutput.safeParse(raw);
      if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`) };
      if (parsed.data.evidenceCutoffVersion !== current.version) return { ok: false, errors: [`ADVERSARY_CUTOFF_MISMATCH: v${parsed.data.evidenceCutoffVersion} != v${current.version}`] };
      const foreign = [...parsed.data.counterEvidenceIds, ...parsed.data.objections.flatMap((o) => o.evidenceIds)].filter((id) => !packetIds.has(id));
      if (foreign.length > 0) return { ok: false, errors: [`ADVERSARY_EVIDENCE_OUTSIDE_PACKET: ${foreign.slice(0, 5).join(',')}`] };
      return { ok: true, value: parsed.data };
    }, remainingMs());
    out.runs.push(reviewed.run);
    if (reviewed.kind !== 'OK') return failCall(reviewed, 'adversary', end);
    out.reviews.push({ id: deps.newId(), actionCycleId: out.cycle.id, agentRunId: reviewed.run.id, deterministicGate: false, verdict: reviewed.value.verdict, objections: reviewed.value.objections, confidence: reviewed.value.confidence, cutoffVersion: current.version, latencyMs: reviewed.run.latencyMs, blocking: true, createdAt: clock.now() });
    step({ type: 'ADVERSARY_REVIEWED', at: clock.now(), runId: reviewed.run.id, verdict: reviewed.value.verdict, cutoffVersion: current.version, reasonCodes: reviewed.value.objections.map((o) => o.code) });
    if (out.cycle.state !== 'REVISION_REQUESTED') {
      out.notes.push(`adversary ${reviewed.value.verdict} at cutoff v${current.version}${cutoff.version !== current.version ? ' (after refresh)' : ''}`);
      return out;
    }
    objections = reviewed.value.objections;
  }
}

function sameModel(deps: CycleRunnerDeps): boolean {
  const a = deps.proposer.identity();
  const b = deps.adversary.identity();
  return a.provider === b.provider && a.model === b.model;
}

function failCall(r: Exclude<CallResult<unknown>, { kind: 'OK' }>, who: string, end: (reason: UnresolvedReason, note: string) => CycleRunOutcome): CycleRunOutcome {
  switch (r.kind) {
    case 'MALFORMED':
      return end('MALFORMED_OUTPUT', `${who} output rejected: ${r.errors.slice(0, 3).join('; ')}`);
    case 'TIMEOUT':
      return end('TIMEOUT', `${who} call overran the decision budget`);
    case 'OUTAGE':
      return end('ADVERSARY_UNAVAILABLE', `${who} unavailable: ${r.error}`);
  }
}

/**
 * The scope a proposal is validated against is derived from the cycle, never from the context
 * builder alone: allowed actions are the machine's target rule intersected with what the builder
 * says the skill version supports, and the evidence allow-list is exactly the packet.
 */
function bindScope(cycle: ActionCycle, built: BuiltContext, cutoff: EvidenceCutoff, deadlineAt: Instant, round: number, objections: AdversarialReviewOutput['objections'], options: TransitionOptions | undefined): { built: BuiltContext } {
  const machineAllowed = allowedActions(cycle, options);
  const allowed = built.context.allowedActions.filter((a) => machineAllowed.has(a)) as TradingActionType[];
  const evidenceIds = built.context.evidence.map((e) => e.id);
  const context: TradingSkillContext = { ...built.context, actionCycleId: cycle.id, candidateId: cycle.candidateId, positionId: cycle.positionId, strategyVersionId: cycle.strategyVersionId, triggerId: cycle.triggerId, allowedActions: allowed.length > 0 ? allowed : [...machineAllowed], cutoffVersion: cutoff.version, cutoffAt: cutoff.at, deadlineAt, revisionRound: Math.min(round, 1), priorObjections: objections };
  const scope: ToolScope = { ...built.scope, actionCycleId: cycle.id, candidateId: cycle.candidateId, positionId: cycle.positionId, strategyVersionId: cycle.strategyVersionId, skillVersionId: context.skillVersionId, supportedActionTypes: context.allowedActions, triggerId: cycle.triggerId, cutoffVersion: cutoff.version, cutoffAt: cutoff.at, evidenceIds };
  return { built: { context, scope } };
}

async function callModel<T>(deps: CycleRunnerDeps, role: AgentRole, cycle: ActionCycle, context: TradingSkillContext, call: (signal: AbortSignal) => Promise<ModelCall>, validate: (raw: unknown) => { ok: true; value: T } | { ok: false; errors: string[] }, remainingMs: number): Promise<CallResult<T>> {
  const { clock, policy } = deps;
  const model = role === 'TRADING_PROPOSER' ? deps.proposer : deps.adversary;
  const budgetMs = Math.max(0, Math.min(policy.maxModelCallMs, remainingMs));
  const started = clock.nowMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ModelTimeoutError()), budgetMs);
  const base = (): Omit<AgentRun, 'provider' | 'model' | 'promptVersion' | 'temperature' | 'tokens' | 'costUsd' | 'costAccrual' | 'structuredOutput' | 'success' | 'schemaValidation' | 'latencyMs'> => ({ id: deps.newId(), actionCycleId: cycle.id, candidateId: cycle.candidateId, positionId: cycle.positionId, role, reasoningConfig: null, inputEvidenceIds: context.evidence.map((e) => e.id), cutoffVersion: context.cutoffVersion, cutoffAt: context.cutoffAt, createdAt: clock.now() });
  const identity = model.identity();
  const failedRun = (latencyMs: number, error: string): AgentRun => ({ ...base(), provider: identity.provider, model: identity.model, promptVersion: identity.promptVersion, temperature: null, tokens: { input: 0, output: 0 }, costUsd: 0, costAccrual: 'UNKNOWN', structuredOutput: null, success: false, schemaValidation: { ok: false, errors: [error] }, latencyMs });
  let result: ModelCall;
  try {
    result = await Promise.race([
      call(controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new ModelTimeoutError()), { once: true })),
    ]);
  } catch (e) {
    clearTimeout(timer);
    const latencyMs = Math.max(0, clock.nowMs() - started);
    if (e instanceof ModelTimeoutError || controller.signal.aborted) return { kind: 'TIMEOUT', run: failedRun(latencyMs, 'timeout') };
    /**
     * The provider's error body reaches this string (providers.ts slices 300 chars of it into the
     * message) and is persisted on the run as a schema-validation error. That is deliberate - it is
     * the only place real provider failure shapes accumulate, and the burn-in needs them as fixtures.
     *
     * Two bounds on what it may carry. Credentials are redacted here, because a 401 body can echo the
     * key we sent. Prompt echo is bounded only by the 300-character truncation upstream: an error body
     * that quotes part of the request could carry evidence text. The request itself is never stored
     * alongside it, so this is a fragment without its context, which is the intended limit.
     */
    const error = redactString((e instanceof Error ? e.message : String(e)).slice(0, 512));
    return { kind: 'OUTAGE', run: failedRun(latencyMs, error), error };
  }
  clearTimeout(timer);
  const latencyMs = Math.max(0, clock.nowMs() - started);
  const validated = validate(result.output);
  const structuredOutput = result.output !== null && typeof result.output === 'object' && !Array.isArray(result.output) ? (result.output as Record<string, unknown>) : null;
  const run: AgentRun = { ...base(), provider: result.metadata.provider, model: result.metadata.model, promptVersion: result.metadata.promptVersion, temperature: result.metadata.temperature, tokens: result.metadata.tokens, costUsd: result.metadata.costUsd, costAccrual: 'MEASURED', structuredOutput, success: validated.ok, schemaValidation: validated.ok ? { ok: true, errors: [] } : { ok: false, errors: validated.errors.slice(0, 20) }, latencyMs };
  if (!validated.ok) return { kind: 'MALFORMED', run, errors: validated.errors };
  return { kind: 'OK', value: validated.value, run };
}
