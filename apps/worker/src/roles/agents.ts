import { randomUUID } from 'node:crypto';
import { capEventWindow, decideAutomation, evaluatePositionTriggers, evaluateSpendGate, pickTrigger, runDiscretionaryCycle, allowedActions, canAuthorize, type AutomationDecision, type BuiltContext, type CatalystTiming, type CycleRunOutcome, type EventWindow, type ReasoningModel, type TriggerEvent } from '@sol-agent-trader/agents';
import { DEFAULT_EVENT_WINDOW_CAP_POLICY, addMs, getContractSetDigest, type ActionCycle, type ActivityState, type AutomationRun, type AutomationSet, type AutomationTriggerType, type Candidate, type CapitalAuthority, type Clock, type DiscretionaryCyclePolicy, type Instant, type QueueMessageEnvelope, type SkillVersion, type SpendBudget, type SpendUsage, type StrategyVersion, type Uuid } from '@sol-agent-trader/contracts';
import type { AutomationHistoryRow, DiscretionaryOutcome, PositionReviewWrite, PositionTargetRow } from '@sol-agent-trader/db/server';
import { discretionaryActionsAllowed, initialPositionReview, reviewTransition, type PositionReview } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';
import { buildTradingSkillContext, DEFAULT_CONTEXT_BUILD_POLICY, type ContextSources } from '@sol-agent-trader/skills';

/**
 * Worker role `agents` (blueprint §11.7–11.9, D30, D39, D40, D43; execution plan M6). One tick:
 * for the strategy's candidate targets (the same opportunity set S0 saw) and its open positions,
 * evaluate automations, run the discretionary cycle for every INVOKED trigger, and persist the
 * outcome, the position's review transition and the outbox message in one transaction. Nothing
 * here sizes, authorizes or executes: a CLEARED ENTER is picked up by the paper-entry role like an
 * S0 decision, and a CLEARED position action goes to the trading-actions queue.
 */

export interface AgentsRepo {
  listCandidateTargets(strategyVersionId: StrategyVersion['versionId'], now: Instant, maxAgeMs: number, limit: number, families: readonly string[]): Promise<Candidate[]>;
  listPositionTargets(strategyVersionId: StrategyVersion['versionId'], limit: number): Promise<PositionTargetRow[]>;
  automationHistory(targetId: Uuid): Promise<AutomationHistoryRow>;
  recordAutomationRun(run: AutomationRun): Promise<void>;
  spendState(now: Instant): Promise<{ budgets: SpendBudget[]; usage: SpendUsage[] }>;
  chargeSpend(budgetIds: readonly Uuid[], now: Instant, delta: { cycles: number; modelUsd: number; providerRequests: number }): Promise<void>;
  persist(outcome: DiscretionaryOutcome, extra: { positionReview?: PositionReviewWrite; outbox?: QueueMessageEnvelope }): Promise<void>;
  sessionFacts(): Promise<{ activity: ActivityState; authority: CapitalAuthority; paused: boolean } | null>;
  /** The catalyst's recorded timing for an event-window request (§12.3A); null when the evidence is not an intelligence event. */
  catalystTiming(evidenceId: Uuid): Promise<CatalystTiming | null>;
  /** Hands a deterministically capped window to the runtime (the session role opens EVENT_WINDOW); recorded for the Inspector either way. */
  openEventWindow(window: EventWindow, cycleId: Uuid): Promise<void>;
}

export interface AgentsDeps {
  repo: AgentsRepo;
  sources: ContextSources;
  proposer: ReasoningModel;
  adversary: ReasoningModel;
  clock: Clock;
  logger: Logger;
  strategy: StrategyVersion;
  skill: SkillVersion;
  automations: AutomationSet;
  automationIds: Record<string, Uuid>;
  cyclePolicy: DiscretionaryCyclePolicy;
  accountId: Uuid;
  config: { batchSize: number; families: readonly string[]; producer: string };
}

export interface AgentsReport {
  candidates: number;
  positions: number;
  invoked: number;
  skipped: Record<string, number>;
  outcomes: Record<string, number>;
  modelUsd: number;
  errors: { targetId: Uuid; error: string }[];
}

export async function runAgentsCycle(deps: AgentsDeps): Promise<AgentsReport> {
  const now = deps.clock.now();
  const report: AgentsReport = { candidates: 0, positions: 0, invoked: 0, skipped: {}, outcomes: {}, modelUsd: 0, errors: [] };
  const session = await deps.repo.sessionFacts();
  const facts = { capitalAuthority: session?.authority ?? ('OBSERVE' as CapitalAuthority), activityState: session?.paused ? ('WATCH' as ActivityState) : (session?.activity ?? ('OFF' as ActivityState)) };
  const spend = await deps.repo.spendState(now);
  const providers = [deps.proposer.identity().provider, deps.adversary.identity().provider];
  const spendGate = () => evaluateSpendGate({ budgets: spend.budgets, usage: spend.usage, strategyId: deps.strategy.strategyId, providers, now: deps.clock.now() });
  const chargeable = spend.budgets.filter((b) => b.active && (b.scope === 'PLATFORM' || (b.scope === 'STRATEGY' && b.scopeId === deps.strategy.strategyId) || (b.scope === 'PROVIDER' && b.scopeId !== null && providers.includes(b.scopeId)))).map((b) => b.id);

  const candidates = await deps.repo.listCandidateTargets(deps.strategy.versionId, now, deps.strategy.maxCandidateAgeMs, deps.config.batchSize, deps.config.families);
  report.candidates = candidates.length;
  for (const c of candidates) {
    const event: TriggerEvent = { type: 'SCANNER_THRESHOLD', targetId: c.id, at: now, details: { assetId: c.assetId, triggerFamily: c.triggerFamily, scannerScore: c.scannerScore } };
    await handleTarget(deps, report, event, { kind: 'CANDIDATE', candidateId: c.id, position: null }, facts, spendGate, chargeable);
  }

  const positions = await deps.repo.listPositionTargets(deps.strategy.versionId, deps.config.batchSize);
  report.positions = positions.length;
  for (const p of positions) {
    const triggers = evaluatePositionTriggers(deps.automations, {
      positionId: p.id, speedTier: deps.strategy.speedTier, openedAt: p.openedAt, lastReassessedAt: p.lastCycleAt, nextReassessmentAt: p.nextReassessmentAt, averageEntryPrice: p.averageEntryPrice, markPrice: p.markPrice, highWaterPrice: null, expectedHorizonEndsAt: null,
      volatilityRegimeChanged: false, liquidityDegraded: false, smartMoneyReversal: false, newSecurityEvidence: p.safetyState !== 'NORMAL', catalystChanged: false, protectiveOrderChanged: false, recoveredAfterRestart: false, profitMilestoneFraction: null,
    }, now);
    const event = pickTrigger(deps.automations, triggers);
    if (!event) continue;
    await handleTarget(deps, report, event, { kind: 'POSITION', candidateId: null, position: p }, facts, spendGate, chargeable);
  }
  deps.logger.info('agents_cycle', { strategy: deps.strategy.versionId, candidates: report.candidates, positions: report.positions, invoked: report.invoked, skipped: report.skipped, outcomes: report.outcomes, modelUsd: Number(report.modelUsd.toFixed(4)), errors: report.errors.length, authority: facts.capitalAuthority, activity: facts.activityState });
  return report;
}

type Target = { kind: 'CANDIDATE'; candidateId: Uuid; position: null } | { kind: 'POSITION'; candidateId: null; position: PositionTargetRow };

async function handleTarget(deps: AgentsDeps, report: AgentsReport, event: TriggerEvent, target: Target, facts: { capitalAuthority: CapitalAuthority; activityState: ActivityState }, spendGate: () => ReturnType<typeof evaluateSpendGate>, chargeable: readonly Uuid[]): Promise<void> {
  const now = deps.clock.now();
  try {
    const history = await deps.repo.automationHistory(event.targetId);
    const decision: AutomationDecision = decideAutomation(deps.automations, event, { ...history, cycleInFlight: false, reviewState: target.position?.reviewState ?? null, consecutiveUnresolved: target.position?.consecutiveUnresolved ?? 0 }, { ...facts, spendGate: spendGate() });
    const automationId = deps.automationIds[event.type];
    if (decision.disposition !== 'INVOKED') {
      report.skipped[decision.disposition] = (report.skipped[decision.disposition] ?? 0) + 1;
      if (decision.disposition !== 'SKIPPED_COOLDOWN' && automationId) {
        await deps.repo.recordAutomationRun({ id: randomUUID() as Uuid, automationId, automationVersionId: deps.automations.version, triggerEvent: { ...event, reason: decision.reason }, cutoffVersion: null, cutoffAt: null, skillInvocationRunId: null, actionCycleId: null, disposition: decision.disposition, createdAt: now });
      }
      return;
    }
    report.invoked++;
    const outcome = await runDiscretionaryCycle(
      {
        proposer: deps.proposer,
        adversary: deps.adversary,
        clock: deps.clock,
        newId: () => randomUUID() as Uuid,
        policy: deps.cyclePolicy,
        spendGate: () => spendGate(),
        buildContext: async (cycle, cutoff, revision): Promise<BuiltContext> => {
          const built = await buildTradingSkillContext(deps.sources, { cycle, cutoff, accountId: deps.accountId, strategy: deps.strategy, skill: deps.skill, machineAllowed: [...allowedActions(cycle)], revision, policy: DEFAULT_CONTEXT_BUILD_POLICY });
          return { context: built.context, scope: built.scope };
        },
      },
      { id: randomUUID() as Uuid, triggerId: event.targetId, strategy: deps.strategy, candidateId: target.candidateId, positionId: target.position?.id ?? null },
    );
    const modelUsd = outcome.runs.reduce((acc, r) => acc + r.costUsd, 0);
    report.modelUsd += modelUsd;
    const key = outcome.cycle.state === 'UNRESOLVED' ? `UNRESOLVED_${outcome.cycle.unresolvedReason}` : outcome.cycle.state === 'CLEARED' ? `CLEARED_${outcome.cycle.proposedAction}` : outcome.cycle.state;
    report.outcomes[key] = (report.outcomes[key] ?? 0) + 1;
    const extra: { positionReview?: PositionReviewWrite; outbox?: QueueMessageEnvelope } = target.position ? positionHandoff(deps, outcome, target.position, now) : {};
    await deps.repo.persist({ cycle: outcome.cycle, proposals: outcome.proposals, reviews: outcome.reviews, runs: outcome.runs }, extra);
    if (automationId) {
      await deps.repo.recordAutomationRun({ id: randomUUID() as Uuid, automationId, automationVersionId: deps.automations.version, triggerEvent: { ...event }, cutoffVersion: outcome.cycle.cutoffs.at(-1)?.version ?? 1, cutoffAt: outcome.cycle.cutoffs.at(-1)?.at ?? now, skillInvocationRunId: outcome.runs[0]?.id ?? null, actionCycleId: outcome.cycle.id, disposition: 'INVOKED', createdAt: now });
    }
    await deps.repo.chargeSpend(chargeable, now, { cycles: 1, modelUsd, providerRequests: outcome.runs.length });
    await handleEventWindowRequest(deps, outcome, now);
    deps.logger.info('agents_cycle_done', { cycleId: outcome.cycle.id, target: target.kind, targetId: event.targetId, trigger: event.type, state: outcome.cycle.state, action: outcome.cycle.proposedAction, verdict: outcome.cycle.verdict, unresolvedReason: outcome.cycle.unresolvedReason, revisionRound: outcome.cycle.revisionRound, runs: outcome.runs.length, modelUsd: Number(modelUsd.toFixed(4)), notes: outcome.notes, review: extra.positionReview?.reviewState ?? null });
  } catch (err) {
    report.errors.push({ targetId: event.targetId, error: err instanceof Error ? err.message : String(err) });
    deps.logger.error('agents_target_failed', { target: target.kind, targetId: event.targetId, trigger: event.type, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * §12.3A: the skill may ask for a catalyst window on a cleared ENTER; the deterministic cap decides.
 * The request never changes the entry itself (size, risk and execution are unchanged); it only asks the
 * runtime for a bounded faster cadence, and only a fresh, trusted, NEW catalyst can open one.
 */
async function handleEventWindowRequest(deps: AgentsDeps, outcome: CycleRunOutcome, now: Instant): Promise<void> {
  const proposal = outcome.proposals.at(-1);
  const request = proposal?.proposal.eventWindowRequest ?? null;
  if (!request || !canAuthorize(outcome.cycle) || outcome.cycle.proposedAction !== 'ENTER') return;
  const timing = await deps.repo.catalystTiming(request.catalystEvidenceId);
  if (!timing) {
    deps.logger.info('agents_event_window', { cycleId: outcome.cycle.id, allowed: false, reason: 'EVIDENCE_NOT_A_CATALYST', catalystEvidenceId: request.catalystEvidenceId });
    return;
  }
  const decision = capEventWindow(request, timing, DEFAULT_EVENT_WINDOW_CAP_POLICY, now);
  if (!decision.allowed) {
    deps.logger.info('agents_event_window', { cycleId: outcome.cycle.id, allowed: false, reason: decision.reason, catalystEvidenceId: request.catalystEvidenceId, requested: request });
    return;
  }
  await deps.repo.openEventWindow(decision.window, outcome.cycle.id);
  deps.logger.info('agents_event_window', { cycleId: outcome.cycle.id, allowed: true, t0: decision.window.t0, endsAt: decision.window.endsAt, cappedByPolicy: decision.window.cappedByPolicy, cadenceMs: decision.window.cadenceMs, extensionsRemaining: decision.window.extensionsRemaining, requested: request });
}

/**
 * ADR-0001: the position's next review state comes from the position-review machine, computed here
 * and written with the cycle in one transaction. A CLEARED exposure action is handed to the
 * trading-actions queue; HOLD only marks the position reviewed.
 */
function positionHandoff(deps: AgentsDeps, outcome: CycleRunOutcome, p: PositionTargetRow, now: Instant): { positionReview: PositionReviewWrite; outbox?: QueueMessageEnvelope } {
  const current: PositionReview = { reviewState: p.reviewState, reason: null, since: p.reviewStateSince, lastReviewedCycleId: p.lastReviewedCycleId, unreviewedStop: p.unreviewedStop, consecutiveUnresolved: p.consecutiveUnresolved };
  const terminal = outcome.cycle.state as 'CLEARED' | 'REJECTED' | 'EXPIRED' | 'UNRESOLVED';
  const r = reviewTransition(current.reviewState === 'REVIEWED' ? initialPositionReview(p.reviewStateSince, p.lastReviewedCycleId) : current, { type: 'CYCLE_TERMINATED', at: now, cycleId: outcome.cycle.id, terminal, action: outcome.cycle.proposedAction, unresolvedReason: outcome.cycle.unresolvedReason });
  const next: PositionReview = r.ok ? r.review : { ...current, reviewState: 'PROTECTION_ONLY', reason: outcome.cycle.unresolvedReason ?? 'MALFORMED_OUTPUT', since: now };
  const positionReview: PositionReviewWrite = { positionId: p.id, reviewState: next.reviewState, reason: next.reviewState === 'REVIEWED' ? null : (next.reason ?? 'DISAGREEMENT'), since: next.since, lastReviewedCycleId: next.reviewState === 'REVIEWED' ? outcome.cycle.id : null };
  if (!discretionaryActionsAllowed(next) || !canAuthorize(outcome.cycle) || outcome.cycle.proposedAction === 'HOLD') return { positionReview };
  const proposal = outcome.proposals.at(-1);
  const outbox: QueueMessageEnvelope = { messageId: randomUUID() as Uuid, queue: 'trading-actions', kind: 'action_cycle.cleared', kindVersion: 1, idempotencyKey: `cycle:${outcome.cycle.id}` as never, correlationId: outcome.cycle.id, causationId: null, enqueuedAt: now, attempt: 1, contractSetDigest: CONTRACT_DIGEST, payload: { actionCycleId: outcome.cycle.id, positionId: p.id, action: outcome.cycle.proposedAction, proposalId: proposal?.id ?? null, expiresAt: proposal?.expiresAt ?? addMs(now, deps.strategy.liveIntentExpiryMs), strategyVersionId: deps.strategy.versionId } };
  return { positionReview, outbox };
}

let CONTRACT_DIGEST = ''.padEnd(64, '0') as QueueMessageEnvelope['contractSetDigest'];
export async function primeContractDigest(): Promise<void> {
  CONTRACT_DIGEST = (await getContractSetDigest()).digest as QueueMessageEnvelope['contractSetDigest'];
}

export function cycleSummary(cycle: ActionCycle): string {
  return `${cycle.state}${cycle.proposedAction ? ` ${cycle.proposedAction}` : ''}${cycle.verdict ? ` ${cycle.verdict}` : ''}${cycle.unresolvedReason ? ` (${cycle.unresolvedReason})` : ''}`;
}

export type { AutomationTriggerType };
