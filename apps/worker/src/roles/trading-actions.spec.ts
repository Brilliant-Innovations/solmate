import { addMs, fixedClock, fixtures, type ActionCycle, type Instant, type Proposal, type QueueMessageEnvelope, type Sha256Hex, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import type { OpenPositionRow } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { handleClearedAction, type TradingActionsDeps } from './trading-actions.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const S1 = 'S1@1.0.0' as VersionId;

function cycle(patch: Partial<ActionCycle> = {}): ActionCycle {
  return { id: IDS.cycle as Uuid, automationRunId: null, triggerId: IDS.position as Uuid, candidateId: null, positionId: IDS.position as Uuid, strategyVersionId: S1, skillVersionId: 'trading-skill@1.0.0' as VersionId, guidelineVersionId: null, speedTier: 'T2_CONTEXTUAL', decisionBudgetMs: 60_000, proposedAction: 'EXIT', proposalId: IDS.message as Uuid, proposerRunIds: [], adversaryRunIds: [], verdict: 'CONFIRM', reasonCodes: [], revisionRound: 0, state: 'CLEARED', unresolvedReason: null, cutoffs: [{ version: 1, at: T0, consumedByRunIds: [] }], clearedCutoffVersion: 1, riskEvaluationId: null, intentId: null, startedAt: T0, terminalAt: T0, ...patch };
}
function proposal(patch: Partial<Proposal['proposal']> = {}, expiresAt: Instant = addMs(T0, 600_000)): Proposal {
  return { id: IDS.message as Uuid, actionCycleId: IDS.cycle as Uuid, candidateId: null, positionId: IDS.position as Uuid, strategyVersionId: S1, source: 'AI', createdAt: T0, expiresAt, proposal: { ...fixtures.tradingActionProposal(), actionType: 'EXIT', candidateId: null, positionId: IDS.position as Uuid, strategyVersionId: S1, requestedFractionToReduce: null, expiresAt, ...patch } };
}
const position = (reviewState = 'REVIEWED'): OpenPositionRow & { reviewState: string } => ({ id: IDS.position as Uuid, accountId: IDS.account as Uuid, assetId: IDS.asset as Uuid, mint: fixtures.MINTS.USDC as never, decimals: 9, symbol: 'AGT', quantity: '1000' as never, averageEntryPrice: 1, costBasisBaseUnits: '1000' as never, realizedPnlBaseUnits: '0' as never, stop: { model: 'ATR', level: 0.9, distanceFraction: 0.1 }, target: null, unreviewedStop: null, safetyState: 'NORMAL', openedAt: addMs(T0, -3_600_000), lots: [], reviewState });
const envelope = (payload: Record<string, unknown>): QueueMessageEnvelope => ({ messageId: IDS.message as Uuid, queue: 'trading-actions', kind: 'action_cycle.cleared', kindVersion: 1, idempotencyKey: `cycle:${IDS.cycle}` as never, correlationId: IDS.cycle, causationId: null, enqueuedAt: T0, attempt: 1, contractSetDigest: 'ab'.repeat(32) as Sha256Hex, payload });
const goodPayload = { actionCycleId: IDS.cycle, positionId: IDS.position, action: 'EXIT', proposalId: IDS.message, expiresAt: addMs(T0, 600_000), strategyVersionId: S1 };

function deps(over: Partial<{ cycle: ActionCycle | null; proposal: Proposal | null; position: ReturnType<typeof position> | null; tightened: boolean }> = {}) {
  const calls: string[] = [];
  const d: TradingActionsDeps = {
    async loadCycle() { return over.cycle === undefined ? cycle() : over.cycle; },
    async loadProposal() { return over.proposal === undefined ? proposal() : over.proposal; },
    async loadPosition() { return over.position === undefined ? position() : over.position; },
    async tightenStop(_id, level) { calls.push(`tighten:${level}`); return over.tightened ?? true; },
    async execute(_p, c, pr) { calls.push(`execute:${c.id}:${pr.proposal.actionType}`); return 'FILLED'; },
    clock: fixedClock(addMs(T0, 1_000)),
    logger: createLogger({ service: 'worker', minLevel: 'error' }),
  };
  return { d, calls };
}

describe('worker role trading-actions (§11.8–11.9, ADR-0001, INV-14)', () => {
  it('executes a cleared EXIT through the injected exit path exactly as persisted', async () => {
    const { d, calls } = deps();
    expect(await handleClearedAction(d, envelope(goodPayload))).toEqual({ outcome: 'EXECUTED', fill: 'FILLED', action: 'EXIT' });
    expect(calls).toEqual([`execute:${IDS.cycle}:EXIT`]);
  });

  it('re-checks the database before moving: unauthorizable, already executed, missing or expired proposal, gone or unreviewed position all skip without side effects', async () => {
    const cases: Array<[string, Parameters<typeof deps>[0], string]> = [
      ['rejected cycle', { cycle: cycle({ state: 'REJECTED', verdict: 'REJECT' }) }, 'NOT_AUTHORIZABLE'],
      ['cleared under a stale cutoff', { cycle: cycle({ cutoffs: [{ version: 1, at: T0, consumedByRunIds: [] }, { version: 2, at: T0, consumedByRunIds: [] }] }) }, 'NOT_AUTHORIZABLE'],
      ['HOLD is not executable', { cycle: cycle({ proposedAction: 'HOLD' }) }, 'UNSUPPORTED_ACTION'],
      ['other position', { cycle: cycle({ positionId: IDS.lot as Uuid }) }, 'NOT_AUTHORIZABLE'],
      ['already evaluated', { cycle: cycle({ riskEvaluationId: IDS.evaluation as Uuid }) }, 'ALREADY_EXECUTED'],
      ['already intent', { cycle: cycle({ intentId: IDS.intent as Uuid }) }, 'ALREADY_EXECUTED'],
      ['missing cycle', { cycle: null }, 'CYCLE_NOT_FOUND'],
      ['missing proposal', { proposal: null }, 'PROPOSAL_MISSING'],
      ['proposal action differs', { proposal: proposal({ actionType: 'REDUCE', requestedFractionToReduce: 0.5 }) }, 'PROPOSAL_MISSING'],
      ['expired proposal', { proposal: proposal({}, T0) }, 'PROPOSAL_EXPIRED'],
      ['closed position', { position: null }, 'POSITION_GONE'],
      ['protection-only position', { position: position('PROTECTION_ONLY') }, 'POSITION_NOT_REVIEWED'],
    ];
    for (const [label, over, reason] of cases) {
      const { d, calls } = deps(over);
      expect(await handleClearedAction(d, envelope(goodPayload)), label).toEqual({ outcome: 'SKIPPED', reason });
      expect(calls, label).toEqual([]);
    }
    const { d, calls } = deps();
    expect(await handleClearedAction(d, envelope({ actionCycleId: 'nope' }))).toEqual({ outcome: 'SKIPPED', reason: 'MALFORMED_PAYLOAD' });
    expect(calls).toEqual([]);
  });

  it('ADJUST_PROTECTION can only tighten: a stop level goes through tightenStop, anything else is skipped', async () => {
    const adjust = deps({ cycle: cycle({ proposedAction: 'ADJUST_PROTECTION' }), proposal: proposal({ actionType: 'ADJUST_PROTECTION', protectionIntent: { mode: null, tightenStopToPrice: 0.95, enableTrailing: null, cancelProviderOrder: null, rationale: 'lock in' } }) });
    expect(await handleClearedAction(adjust.d, envelope({ ...goodPayload, action: 'ADJUST_PROTECTION' }))).toEqual({ outcome: 'PROTECTION_TIGHTENED', level: 0.95, applied: true });
    expect(adjust.calls).toEqual(['tighten:0.95']);
    const loosen = deps({ cycle: cycle({ proposedAction: 'ADJUST_PROTECTION' }), proposal: proposal({ actionType: 'ADJUST_PROTECTION', protectionIntent: { mode: null, tightenStopToPrice: 0.5, enableTrailing: null, cancelProviderOrder: null, rationale: 'loosen' } }), tightened: false });
    expect(await handleClearedAction(loosen.d, envelope({ ...goodPayload, action: 'ADJUST_PROTECTION' }))).toEqual({ outcome: 'PROTECTION_TIGHTENED', level: 0.5, applied: false });
    const none = deps({ cycle: cycle({ proposedAction: 'ADJUST_PROTECTION' }), proposal: proposal({ actionType: 'ADJUST_PROTECTION', protectionIntent: { mode: null, tightenStopToPrice: null, enableTrailing: true, cancelProviderOrder: null, rationale: 'trail' } }) });
    expect(await handleClearedAction(none.d, envelope({ ...goodPayload, action: 'ADJUST_PROTECTION' }))).toEqual({ outcome: 'SKIPPED', reason: 'NO_TIGHTER_STOP' });
    expect(none.calls).toEqual([]);
  });
});
