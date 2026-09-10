import { DEFAULT_AUTOMATION_SET, DEFAULT_DISCRETIONARY_CYCLE_POLICY, addMs, fixedClock, fixtures, type AdversarialReviewInput, type AutomationRun, type Candidate, type Instant, type SkillVersion, type StrategyVersion, type TradingActionProposal, type TradingSkillContext, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { DiscretionaryOutcome, PositionReviewWrite, PositionTargetRow } from '@sol-agent-trader/db/server';
import type { ModelCall, ReasoningModel } from '@sol-agent-trader/agents';
import type { ContextSources } from '@sol-agent-trader/skills';
import { createLogger } from '@sol-agent-trader/observability';
import { runAgentsCycle, type AgentsDeps, type AgentsRepo } from './agents.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-00000000000${n % 10}` as Uuid;
const S1 = 'S1@1.0.0' as VersionId;
const SKILL = 'trading-skill@1.0.0' as VersionId;

const strategy = { versionId: S1, strategyId: 'S1', speedTier: 'T2_CONTEXTUAL', maxDecisionLatencyMs: 60_000, maxCandidateAgeMs: 900_000, maxQuoteAgeMs: 15_000, chaseToleranceBps: 150, allowedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT'], thresholds: {}, guidelineVersionId: 'guide-v1', skillVersionId: SKILL, liveIntentExpiryMs: 60_000 } as unknown as StrategyVersion;
const skill = { versionId: SKILL, supportedActionTypes: ['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION'] } as unknown as SkillVersion;
const candidate: Candidate = { id: IDS.candidate as Uuid, assetId: IDS.asset as Uuid, discoveredAt: addMs(T0, -60_000), triggerFamily: 'MOMENTUM_CONTINUATION', triggerDetails: {}, scannerScore: 70, status: 'QUALIFIED', featureSnapshotId: uuid(1), eligibilityEvaluationId: uuid(2), expiresAt: addMs(T0, 600_000), deterministicRejectionReason: null, dedupeKey: 'k', strategyVersionIds: [] };
const position: PositionTargetRow = { id: IDS.position as Uuid, accountId: IDS.account as Uuid, assetId: IDS.asset as Uuid, mint: 'M', symbol: 'AGT', strategyVersionId: S1, openedAt: addMs(T0, -7_200_000), averageEntryPrice: 1, markPrice: 1.02, safetyState: 'NORMAL', reviewState: 'REVIEWED', reviewStateSince: addMs(T0, -7_200_000), nextReassessmentAt: null, lastReviewedCycleId: null, lastCycleAt: null, consecutiveUnresolved: 0, unreviewedStop: null };

const sources: ContextSources = {
  async candidate(id) { return id === candidate.id ? candidate : null; },
  async position(id, asOf) { return id === position.id ? { id, accountId: IDS.account as Uuid, assetId: IDS.asset as Uuid, symbol: 'AGT', quantity: '1000', averageEntryPrice: 1, costBasisBaseUnits: '1000', markPrice: 1.02, markAt: asOf, unrealizedPnlBaseUnits: '20', stop: null, target: null, unreviewedStop: null, protectionMode: 'MONITORED_EXIT', safetyState: 'NORMAL', reviewState: 'REVIEWED', reviewStateSince: asOf, openedAt: position.openedAt, lastReviewedCycleId: null, thesis: 't', invalidation: 'i', expectedHorizonEndsAt: null } : null; },
  async featureSnapshotAt() { return null; },
  async marketSnapshotAt() { return null; },
  async eligibilityAt() { return null; },
  async safetyAt() { return null; },
  async eventsVisibleAt() { return []; },
  async onchainAt() { return null; },
  async portfolioAt(accountId, asOf) { return { accountId, asOf, settlementMint: 'USDC', equityBaseUnits: '1', exposureAtCostBaseUnits: '0', openPositions: [], cohortUsage: {}, clusterUsage: {}, sleeves: [], dayDrawdownFraction: 0, entriesPaused: false, feedsBlockEntries: false }; },
  async executionPreview() { return null; },
  async cohortPeers() { return []; },
};

function model(provider: 'anthropic' | 'openai', script: (ctx: TradingSkillContext | AdversarialReviewInput) => unknown): ReasoningModel {
  return {
    identity: () => ({ provider, model: `${provider}-m`, promptVersion: 'p@1' as VersionId }),
    async proposeTradingAction(ctx): Promise<ModelCall> { return { output: script(ctx), metadata: { provider, model: `${provider}-m`, promptVersion: 'p@1' as VersionId, temperature: 0, tokens: { input: 10, output: 5 }, costUsd: 0.01 } }; },
    async adversariallyReviewAction(input): Promise<ModelCall> { return { output: script(input), metadata: { provider, model: `${provider}-m`, promptVersion: 'a@1' as VersionId, temperature: 0, tokens: { input: 10, output: 5 }, costUsd: 0.02 } }; },
  };
}
const proposalFor = (ctx: TradingSkillContext, action: TradingActionProposal['actionType']): TradingActionProposal => ({ ...fixtures.tradingActionProposal(), actionType: action, candidateId: ctx.candidateId, positionId: ctx.positionId, strategyVersionId: ctx.strategyVersionId, skillVersionId: ctx.skillVersionId, triggerId: ctx.triggerId, supportingEvidenceIds: ctx.evidence.map((e) => e.id), contradictingEvidenceIds: [], expiresAt: addMs(ctx.cutoffAt, 600_000), evidenceCutoffVersion: ctx.cutoffVersion });
const confirm = (input: AdversarialReviewInput) => ({ ...fixtures.adversarialReviewOutput(), verdict: 'CONFIRM', objections: [], counterEvidenceIds: [], evidenceCutoffVersion: input.context.cutoffVersion });

function fakeRepo(opts: { candidates?: Candidate[]; positions?: PositionTargetRow[]; paused?: boolean; session?: boolean; history?: { lastFiredAt: Instant | null }; catalyst?: { sourceTime: Instant | null; sourceTimeConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'ABSENT'; relation: 'NEW' | 'DUPLICATE' | 'CORROBORATION' } } = {}) {
  const persisted: { outcome: DiscretionaryOutcome; extra: { positionReview?: PositionReviewWrite; outbox?: unknown } }[] = [];
  const runs: AutomationRun[] = [];
  const charges: unknown[] = [];
  const windows: { endsAt: Instant; cycleId: Uuid }[] = [];
  const repo: AgentsRepo = {
    async listCandidateTargets() { return opts.candidates ?? []; },
    async listPositionTargets() { return opts.positions ?? []; },
    async automationHistory() { return { lastFiredAt: opts.history?.lastFiredAt ?? null, lastFiredByType: {} }; },
    async recordAutomationRun(run) { runs.push(run); },
    async spendState() { return { budgets: [{ id: uuid(8), versionId: 'budget-v1' as VersionId, scope: 'STRATEGY', scopeId: 'S1', limits: { cyclesPerHour: 30, modelUsdPerDay: 8, providerRequestsPerMinute: null }, active: true, createdAt: T0 }], usage: opts.paused ? [{ id: uuid(9), budgetId: uuid(8), windowStart: addMs(T0, -1), windowEnd: addMs(T0, 3_600_000), cycles: 0, modelUsd: 0, providerRequests: 0, state: 'BUDGET_PAUSED', updatedAt: T0 }] : [] }; },
    async chargeSpend(ids, _now, delta) { charges.push({ ids, delta }); },
    async persist(outcome, extra) { persisted.push({ outcome, extra }); },
    async sessionFacts() { return opts.session === false ? null : { activity: 'ACTIVE', authority: 'PAPER', paused: false }; },
    async catalystTiming(evidenceId) { return opts.catalyst ? { ...opts.catalyst, evidenceId } : null; },
    async openEventWindow(window, cycleId) { windows.push({ endsAt: window.endsAt, cycleId }); },
  };
  return { repo, persisted, runs, charges, windows };
}

function deps(repo: AgentsRepo, proposerScript: (ctx: TradingSkillContext) => unknown, adversaryScript: (input: AdversarialReviewInput) => unknown = confirm): AgentsDeps {
  return { repo, sources, proposer: model('anthropic', (x) => proposerScript(x as TradingSkillContext)), adversary: model('openai', (x) => adversaryScript(x as AdversarialReviewInput)), clock: fixedClock(T0), logger: createLogger({ service: 'worker', minLevel: 'error' }), strategy, skill, automations: DEFAULT_AUTOMATION_SET, automationIds: { SCANNER_THRESHOLD: uuid(20), REASSESSMENT_HEARTBEAT: uuid(21) }, cyclePolicy: DEFAULT_DISCRETIONARY_CYCLE_POLICY, accountId: IDS.account as Uuid, config: { batchSize: 5, families: ['MOMENTUM_CONTINUATION'], producer: 'test' } };
}

describe('worker role agents (§11.7–11.9, D39, D43)', () => {
  it('runs a candidate cycle end to end and persists cycle, proposal, review and runs, records the automation run and charges spend', async () => {
    const f = fakeRepo({ candidates: [candidate] });
    const report = await runAgentsCycle(deps(f.repo, (ctx) => proposalFor(ctx, 'ENTER')));
    expect(report).toMatchObject({ candidates: 1, positions: 0, invoked: 1, outcomes: { CLEARED_ENTER: 1 }, errors: [] });
    expect(report.modelUsd).toBeCloseTo(0.03, 9);
    expect(f.persisted).toHaveLength(1);
    expect(f.persisted[0]?.outcome.cycle).toMatchObject({ state: 'CLEARED', verdict: 'CONFIRM', proposedAction: 'ENTER', candidateId: IDS.candidate, strategyVersionId: S1, skillVersionId: SKILL });
    expect(f.persisted[0]?.outcome.runs.map((r) => r.provider)).toEqual(['anthropic', 'openai']);
    expect(f.persisted[0]?.extra).toEqual({});
    expect(f.runs).toEqual([expect.objectContaining({ disposition: 'INVOKED', automationId: uuid(20), actionCycleId: f.persisted[0]?.outcome.cycle.id, cutoffVersion: 1 })]);
    expect(f.charges).toEqual([{ ids: [uuid(8)], delta: { cycles: 1, modelUsd: 0.03, providerRequests: 2 } }]);
  });

  /**
   * WP3 items 1 and 4, which are one event: a cycle that does not resolve still writes a state and
   * still accrues a cost. The happy path above was the only persistence ever asserted; an UNRESOLVED
   * cycle takes the same unconditional persist and chargeSpend calls, and nothing proved it.
   */
  it("an unresolved cycle is persisted with its failed run, and charges what that run actually cost", async () => {
    const f = fakeRepo({ candidates: [candidate] });
    // Schema-valid JSON that is not a proposal: the call completed, was billed, and did not parse.
    const report = await runAgentsCycle(deps(f.repo, () => ({ actionType: "ENTER" })));

    expect(report).toMatchObject({ invoked: 1, outcomes: { UNRESOLVED_MALFORMED_OUTPUT: 1 }, errors: [] });
    expect(f.persisted).toHaveLength(1);
    expect(f.persisted[0]?.outcome.cycle).toMatchObject({ state: "UNRESOLVED", unresolvedReason: "MALFORMED_OUTPUT" });
    // The failed run is persisted rather than dropped, with its schema errors.
    const run = f.persisted[0]?.outcome.runs[0];
    expect(run).toMatchObject({ role: "TRADING_PROPOSER", success: false, costAccrual: "MEASURED" });
    expect(run!.schemaValidation.errors.length).toBeGreaterThan(0);
    // And a failed cycle is not free: the billed call is charged to the D43 budget.
    expect(f.charges).toEqual([{ ids: [uuid(8)], delta: { cycles: 1, modelUsd: 0.01, providerRequests: 1 } }]);
  });

  it('skips on cooldown without a row, records other skips, and makes no model call when the budget is paused or the runtime is not active', async () => {
    const cooled = fakeRepo({ candidates: [candidate], history: { lastFiredAt: addMs(T0, -10_000) } });
    const r1 = await runAgentsCycle(deps(cooled.repo, () => { throw new Error('must not be called'); }));
    expect(r1.skipped).toEqual({ SKIPPED_COOLDOWN: 1 });
    expect(cooled.runs).toEqual([]);
    const paused = fakeRepo({ candidates: [candidate], paused: true });
    const r2 = await runAgentsCycle(deps(paused.repo, () => { throw new Error('must not be called'); }));
    expect(r2.skipped).toEqual({ SKIPPED_BUDGET: 1 });
    expect(paused.runs[0]).toMatchObject({ disposition: 'SKIPPED_BUDGET', actionCycleId: null });
    const off = fakeRepo({ candidates: [candidate], session: false });
    const r3 = await runAgentsCycle(deps(off.repo, () => { throw new Error('must not be called'); }));
    expect(r3.skipped).toEqual({ SKIPPED_ACTIVITY_STATE: 1 });
    expect(off.persisted).toEqual([]);
  });

  it('an open position HOLD that clears is written as REVIEWED without an outbox message; an unresolved review flips it to PROTECTION_ONLY', async () => {
    const held = fakeRepo({ positions: [position] });
    const r = await runAgentsCycle(deps(held.repo, (ctx) => proposalFor(ctx, 'HOLD')));
    expect(r).toMatchObject({ positions: 1, invoked: 1, outcomes: { CLEARED_HOLD: 1 } });
    expect(held.persisted[0]?.extra.positionReview).toMatchObject({ positionId: IDS.position, reviewState: 'REVIEWED', reason: null, lastReviewedCycleId: held.persisted[0]?.outcome.cycle.id });
    expect(held.persisted[0]?.extra.outbox).toBeUndefined();
    const down = fakeRepo({ positions: [position] });
    await runAgentsCycle(deps(down.repo, () => { throw new Error('provider down'); }));
    expect(down.persisted[0]?.outcome.cycle).toMatchObject({ state: 'UNRESOLVED', unresolvedReason: 'ADVERSARY_UNAVAILABLE' });
    expect(down.persisted[0]?.extra.positionReview).toMatchObject({ reviewState: 'PROTECTION_ONLY', reason: 'ADVERSARY_UNAVAILABLE', lastReviewedCycleId: null });
    expect(down.persisted[0]?.extra.outbox).toBeUndefined();
  });

  it('a cleared EXIT on a position is handed to the trading-actions queue in the same write', async () => {
    const f = fakeRepo({ positions: [position] });
    await runAgentsCycle(deps(f.repo, (ctx) => proposalFor(ctx, 'EXIT')));
    expect(f.persisted[0]?.outcome.cycle).toMatchObject({ state: 'CLEARED', proposedAction: 'EXIT' });
    expect(f.persisted[0]?.extra.positionReview).toMatchObject({ reviewState: 'REVIEWED' });
    expect(f.persisted[0]?.extra.outbox).toMatchObject({ queue: 'trading-actions', kind: 'action_cycle.cleared', correlationId: f.persisted[0]?.outcome.cycle.id, payload: { action: 'EXIT', positionId: IDS.position } });
  });

  it('a cleared ENTER with an event-window request opens a capped window only for a fresh, trusted, NEW catalyst the run was shown', async () => {
    const request = { catalystEvidenceId: IDS.candidate as Uuid, expectedHalfLifeMinutes: 120, requestedDurationMinutes: 600 };
    const fresh = fakeRepo({ candidates: [candidate], catalyst: { sourceTime: addMs(T0, -20 * 60_000), sourceTimeConfidence: 'HIGH', relation: 'NEW' } });
    await runAgentsCycle(deps(fresh.repo, (ctx) => ({ ...proposalFor(ctx, 'ENTER'), eventWindowRequest: request })));
    expect(fresh.windows).toEqual([{ endsAt: addMs(T0, -20 * 60_000 + 4 * 3_600_000), cycleId: fresh.persisted[0]?.outcome.cycle.id }]);
    const stale = fakeRepo({ candidates: [candidate], catalyst: { sourceTime: addMs(T0, -7 * 3_600_000), sourceTimeConfidence: 'HIGH', relation: 'NEW' } });
    await runAgentsCycle(deps(stale.repo, (ctx) => ({ ...proposalFor(ctx, 'ENTER'), eventWindowRequest: request })));
    expect(stale.windows).toEqual([]);
    expect(stale.persisted[0]?.outcome.cycle.state).toBe('CLEARED'); // the entry itself is unaffected by the window refusal
    const unseen = fakeRepo({ candidates: [candidate], catalyst: { sourceTime: addMs(T0, -20 * 60_000), sourceTimeConfidence: 'HIGH', relation: 'NEW' } });
    await runAgentsCycle(deps(unseen.repo, (ctx) => ({ ...proposalFor(ctx, 'ENTER'), eventWindowRequest: { ...request, catalystEvidenceId: uuid(77) } })));
    expect(unseen.persisted[0]?.outcome.cycle).toMatchObject({ state: 'UNRESOLVED', unresolvedReason: 'MALFORMED_OUTPUT' }); // a window on evidence the run never saw is a malformed proposal
    expect(unseen.windows).toEqual([]);
  });

  it('a failing persist is reported per target and does not stop the tick', async () => {
    const f = fakeRepo({ candidates: [candidate, { ...candidate, id: uuid(5) }] });
    let n = 0;
    f.repo.persist = async () => { if (n++ === 0) throw new Error('db down'); };
    const r = await runAgentsCycle(deps(f.repo, (ctx) => proposalFor(ctx, 'IGNORE')));
    expect(r.errors).toEqual([{ targetId: IDS.candidate, error: 'db down' }]);
    expect(r.invoked).toBe(2);
  });
});
