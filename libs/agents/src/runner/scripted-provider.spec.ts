import { DEFAULT_DISCRETIONARY_CYCLE_POLICY, addMs, fixedClock, fixtures, type ActionCycle, type AdversarialReviewOutput, type EvidenceCutoff, type Instant, type ToolScope, type TradingActionProposal, type TradingSkillContext, type Uuid, type VersionId } from '@sol-agent-trader/contracts';
import { createReasoningModel } from '../gateway/providers.js';
import type { ModelHttpRequest, ModelHttpResponse } from '../gateway/transport.js';
import { runDiscretionaryCycle, type BuiltContext, type CycleRunInput, type CycleRunnerDeps } from './runner.js';

/**
 * WP3 — the discretionary path over the **real provider adapters**, driven by scripted HTTP.
 *
 * `runner.spec.ts` covers every branch of the runner against a fake `ReasoningModel`, and
 * `gateway.spec.ts` covers the provider adapters against recorded bodies. Nothing has ever run the
 * two **composed**: a real `AnthropicReasoningModel`/`OpenAIReasoningModel` parsing a provider body
 * and handing the result to the real runner. That seam is where a shape the adapter tolerates but the
 * runner rejects — or the reverse — would live, and the first real API key must not be the first time
 * it executes.
 *
 * Deliberately not one canned approval. A script that always returns a well-formed CONFIRM exercises
 * the one path least likely to break and reports green with the branches that matter untouched. The
 * cases below are the ones a real provider actually produces: refusals, truncation, schema-valid
 * output naming something out of scope, non-2xx, and an abort.
 *
 * **Structural, not semantic.** A scripted model carries no information, so this proves the path
 * executes and each branch is reachable through real parsing. It proves nothing about whether the
 * decisions are any good — that is what `EVALUATION.md` is for.
 */

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const EV_A = '12121212-1212-4121-8121-121212121212' as Uuid;
const OUT_OF_SCOPE_ASSET = '99999999-9999-4999-8999-999999999999' as Uuid;

let counter = 0;
const newId = () => `${(++counter).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;

const strategy: CycleRunInput['strategy'] = { versionId: 'S1@1.0.0' as VersionId, speedTier: 'T2_CONTEXTUAL', maxDecisionLatencyMs: 60_000, skillVersionId: 'skill@1.0.0' as VersionId, guidelineVersionId: 'guide@1.0.0' as VersionId };
const candidateInput = (): CycleRunInput => ({ id: newId(), triggerId: IDS.trigger as Uuid, strategy, candidateId: IDS.candidate as Uuid });

async function buildContext(cycle: ActionCycle, cutoff: EvidenceCutoff, revision: { round: number; objections: AdversarialReviewOutput['objections'] }): Promise<BuiltContext> {
  const context: TradingSkillContext = {
    actionCycleId: cycle.id, candidateId: cycle.candidateId, positionId: cycle.positionId, assetId: IDS.asset as Uuid,
    strategyVersionId: cycle.strategyVersionId, skillVersionId: 'skill@1.0.0' as VersionId, guidelineVersionId: 'guide@1.0.0' as VersionId,
    speedTier: cycle.speedTier, triggerId: cycle.triggerId, allowedActions: ['ENTER', 'IGNORE'], cutoffVersion: cutoff.version, cutoffAt: cutoff.at,
    deadlineAt: addMs(cycle.startedAt, cycle.decisionBudgetMs),
    evidence: [{ id: EV_A, kind: 'EVENT', observedAt: addMs(T0, -60_000), quality: 'REPUTABLE_PUBLICATION', quoted: 'q', facts: {} }],
    strategyFacts: { chaseToleranceBps: 150 }, revisionRound: revision.round, priorObjections: revision.objections,
  };
  const scope: ToolScope = { actionCycleId: cycle.id, accountId: IDS.account as Uuid, candidateId: cycle.candidateId, positionId: cycle.positionId, assetIds: [IDS.asset as Uuid], strategyVersionId: cycle.strategyVersionId, skillVersionId: 'skill@1.0.0' as VersionId, supportedActionTypes: context.allowedActions, triggerId: cycle.triggerId, cutoffVersion: cutoff.version, cutoffAt: cutoff.at, evidenceIds: [EV_A] };
  return { context, scope };
}

/** A schema-valid proposal, as the model would author it. */
const proposal = (cutoffVersion: number, patch: Partial<TradingActionProposal> = {}): TradingActionProposal => ({
  ...fixtures.tradingActionProposal(), actionType: 'ENTER', candidateId: IDS.candidate as Uuid, positionId: null,
  strategyVersionId: 'S1@1.0.0' as VersionId, skillVersionId: 'skill@1.0.0' as VersionId, triggerId: IDS.trigger as Uuid,
  supportingEvidenceIds: [EV_A], contradictingEvidenceIds: [], expiresAt: addMs(T0, 600_000), evidenceCutoffVersion: cutoffVersion, ...patch,
});
const review = (verdict: AdversarialReviewOutput['verdict'], cutoffVersion: number): AdversarialReviewOutput => ({
  ...fixtures.adversarialReviewOutput(), verdict, evidenceCutoffVersion: cutoffVersion,
  objections: verdict === 'CONFIRM' ? [] : [{ code: 'MOVE_OVEREXTENDED', detail: 'chase', evidenceIds: [EV_A] }], counterEvidenceIds: [],
});

/** Anthropic forces a tool call; the proposal arrives as the tool input. */
const anthropicTool = (input: unknown) => ({ status: 200, body: JSON.stringify({ content: [{ type: 'tool_use', name: 'emit_proposal', input }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: 'tool_use' }) });
/** OpenAI returns the review as JSON text in the message content. */
const openaiJson = (value: unknown) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }], usage: { prompt_tokens: 90, completion_tokens: 10 } }) });

/** Dispenses a queued response per call, so proposer and adversary can be scripted independently. */
function scripted(responses: Array<ModelHttpResponse | ((req: ModelHttpRequest) => Promise<ModelHttpResponse>)>) {
  const urls: string[] = [];
  let i = 0;
  return {
    urls,
    transport: async (req: ModelHttpRequest): Promise<ModelHttpResponse> => {
      urls.push(req.url);
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next === undefined) throw new Error('script exhausted');
      return typeof next === 'function' ? next(req) : next;
    },
  };
}

const opts = { temperature: 0.2, maxOutputTokens: 1024, timeoutMs: 5_000, pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } };

function depsFor(script: ReturnType<typeof scripted>, extra: Partial<CycleRunnerDeps> = {}): CycleRunnerDeps {
  const p = createReasoningModel('anthropic:claude-sonnet-5', { anthropic: 'sk-test', openai: 'sk-test' }, { ...opts, transport: script.transport });
  const a = createReasoningModel('openai:gpt-5', { anthropic: 'sk-test', openai: 'sk-test' }, { ...opts, transport: script.transport });
  if (p.model === null || a.model === null) throw new Error('model construction failed');
  return { proposer: p.model, adversary: a.model, buildContext, spendGate: () => ({ ok: true, checked: 0 }), clock: fixedClock(T0), newId, policy: DEFAULT_DISCRETIONARY_CYCLE_POLICY, ...extra };
}

describe('WP3: the discretionary path over real provider adapters (scripted HTTP)', () => {
  it('CONFIRM clears, and the call actually went through both providers', async () => {
    const s = scripted([anthropicTool(proposal(1)), openaiJson(review('CONFIRM', 1))]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('CLEARED');
    expect(out.cycle.verdict).toBe('CONFIRM');
    expect(s.urls).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.openai.com/v1/chat/completions']);
    expect(out.runs).toHaveLength(2);
  });

  it('REJECT ends REJECTED', async () => {
    const s = scripted([anthropicTool(proposal(1)), openaiJson(review('REJECT', 1))]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('REJECTED');
  });

  it('CHALLENGE revises once at cutoff v2 and can then clear', async () => {
    const s = scripted([anthropicTool(proposal(1)), openaiJson(review('CHALLENGE', 1)), anthropicTool(proposal(2)), openaiJson(review('CONFIRM', 2))]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('CLEARED');
    expect(out.runs).toHaveLength(4);
    expect(out.cycle.clearedCutoffVersion).toBe(2);
  });

  it('a second CHALLENGE exhausts the revision budget', async () => {
    const s = scripted([anthropicTool(proposal(1)), openaiJson(review('CHALLENGE', 1)), anthropicTool(proposal(2)), openaiJson(review('CHALLENGE', 2))]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('UNRESOLVED');
  });

  /** The cases a real provider actually produces, and which one canned approval would never reach. */

  it('a refusal — Anthropic answering in prose with no tool block — is MALFORMED_OUTPUT, not a crash', async () => {
    const s = scripted([{ status: 200, body: JSON.stringify({ content: [{ type: 'text', text: 'I cannot help with that.' }], usage: {}, stop_reason: 'end_turn' }) }]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('UNRESOLVED');
    expect(out.cycle.unresolvedReason).toBe('MALFORMED_OUTPUT');
    expect(out.runs[0]?.schemaValidation).toMatchObject({ ok: false });
    expect(out.runs[0]?.schemaValidation.errors.length).toBeGreaterThan(0);
  });

  it('truncated JSON from the adversary is MALFORMED_OUTPUT', async () => {
    const s = scripted([anthropicTool(proposal(1)), openaiJson('{"verdict":"CONF')]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('UNRESOLVED');
  });

  it('schema-valid output naming an asset outside the cycle scope is refused', async () => {
    const s = scripted([anthropicTool(proposal(1, { candidateId: OUT_OF_SCOPE_ASSET })), openaiJson(review('CONFIRM', 1))]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('UNRESOLVED');
    // it never reached the adversary: one call, not two
    expect(s.urls).toEqual(['https://api.anthropic.com/v1/messages']);
  });

  it('a non-2xx provider response is ADVERSARY_UNAVAILABLE, and the key is not in the request body', async () => {
    const s = scripted([{ status: 503, body: '{"error":"overloaded"}' }]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('UNRESOLVED');
    expect(out.cycle.unresolvedReason).toBe('ADVERSARY_UNAVAILABLE');
  });

  it('an aborted call is TIMEOUT rather than an unhandled rejection', async () => {
    const s = scripted([async (req) => { const e = new Error('aborted'); e.name = 'AbortError'; void req; throw e; }]);
    const out = await runDiscretionaryCycle(depsFor(s), candidateInput());
    expect(out.cycle.state).toBe('UNRESOLVED');
    expect(out.cycle.unresolvedReason).toBe('TIMEOUT');
  });

  /**
   * WP3 item 4. A cycle that fails still spends: we abort a slow call on our own deadline, and the
   * provider may well have generated and billed for it. Recording 0 made a failed cycle look free,
   * which understates D43 spend AND - because EVALUATION.md 7(2) divides edge by model cost per
   * decision - inflates the measured edge. Both point toward proceeding, so the uncertainty is now
   * recorded rather than rounded away.
   */
  it("cost is MEASURED when the provider billed us, UNKNOWN when we never learned", async () => {
    // Malformed output: the call completed and was billed. It just did not parse.
    const malformed = scripted([anthropicTool({ actionType: "ENTER" })]);
    const m = await runDiscretionaryCycle(depsFor(malformed), candidateInput());
    expect(m.runs[0]).toMatchObject({ costAccrual: "MEASURED", success: false });
    expect(m.runs[0]!.costUsd).toBeGreaterThan(0);

    // Abort: we stopped waiting. Whether the provider billed is unknowable from here.
    const timeout = scripted([async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }]);
    const t = await runDiscretionaryCycle(depsFor(timeout), candidateInput());
    expect(t.runs[0]).toMatchObject({ costAccrual: "UNKNOWN", costUsd: 0 });

    // Outage: likewise unknown rather than known-free.
    const outage = scripted([{ status: 503, body: "{}" }]);
    const o = await runDiscretionaryCycle(depsFor(outage), candidateInput());
    expect(o.runs[0]).toMatchObject({ costAccrual: "UNKNOWN", costUsd: 0 });
  });

  it('an exhausted spend budget ends the cycle before any provider is contacted', async () => {
    const s = scripted([anthropicTool(proposal(1))]);
    const out = await runDiscretionaryCycle(depsFor(s, { spendGate: () => ({ ok: false, checked: 1, block: { code: 'DAILY_USD_EXCEEDED', scope: 'ACCOUNT', budgetId: 'b1' } as never }) }), candidateInput());
    expect(out.cycle.state).toBe('UNRESOLVED');
    expect(out.cycle.unresolvedReason).toBe('BUDGET');
    expect(s.urls).toEqual([]);
  });
});
