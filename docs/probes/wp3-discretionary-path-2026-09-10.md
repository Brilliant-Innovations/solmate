# WP3 — what in the discretionary path had never executed, and what still hasn't

Ten scripted cases over the **real** provider adapters, driven by scripted HTTP, through the **real**
runner. `libs/agents/src/runner/scripted-provider.spec.ts`. All ten pass; workspace green.

**Read the last section before treating this as reassurance.** A green run here means the path
executes and each branch is reachable. It does not mean the metrics are correct, and it does not mean
the parts of the path this exercise did not reach are sound.

## What was actually missing, and it was a composition rather than a gap

Neither layer was untested. Both were tested *alone*:

| Layer | Covered by | Against |
| --- | --- | --- |
| Provider adapters (`AnthropicReasoningModel`, `OpenAIReasoningModel`) | `gateway.spec.ts` | recorded bodies, no runner |
| Cycle runner (`runDiscretionaryCycle`) | `runner.spec.ts` | a fake `ReasoningModel`, no HTTP |

**The composition had never run.** A real adapter parsing a real provider body and handing the result
to the real runner is the seam where a shape the adapter tolerates but the runner rejects — or the
reverse — would live. `createReasoningModel` accepts a `transport`, so that seam is reachable without
a key, and it now is.

That is a smaller finding than DEFECT-1 through 4 and it is stated at its true size: nothing was
broken, but nothing had proved it wasn't.

## Why not one canned approval

A script that always returns a well-formed CONFIRM exercises the branch least likely to break and
reports green with every branch that matters untouched — and the "never executed" list would come back
short for the wrong reason. The cases below are the ones a real provider actually produces.

| # | Case | Scripted as | Outcome |
| --- | --- | --- | --- |
| 1 | Approve | tool_use + CONFIRM | `CLEARED`, both providers called in order |
| 2 | Veto | CONFIRM → REJECT | `REJECTED` |
| 3 | Challenge → revise | CHALLENGE at v1, CONFIRM at v2 | `CLEARED` at `clearedCutoffVersion: 2`, 4 runs |
| 4 | Revision exhausted | CHALLENGE at v1 and v2 | `UNRESOLVED` |
| 5 | **Refusal** | Anthropic prose, `stop_reason: end_turn`, no tool block | `UNRESOLVED(MALFORMED_OUTPUT)` with schema errors recorded on the run |
| 6 | **Truncated JSON** | `{"verdict":"CONF` | `UNRESOLVED` |
| 7 | **Out-of-scope** | schema-valid proposal naming an asset outside the cycle scope | `UNRESOLVED`, **and the adversary was never called** — one HTTP call, not two |
| 8 | **Non-2xx** | `503` | `UNRESOLVED(ADVERSARY_UNAVAILABLE)` |
| 9 | **Abort** | transport throws `AbortError` | `UNRESOLVED(TIMEOUT)`, not an unhandled rejection |
| 10 | **Budget exhausted** | spend gate blocks | `UNRESOLVED(BUDGET)`, **zero HTTP calls** |

Cases 5–10 are the ones the first metered key would otherwise have met first. Two are worth calling
out because they assert a *negative*: case 7 proves an out-of-scope proposal is refused before any
adversary spend, and case 10 proves an exhausted budget contacts no provider at all. Both would pass
vacuously if the assertion were only on the terminal state.

## Structural, not semantic — and this bounds what WP2 can conclude

A scripted model carries no information. `proposer_only_net` and `full_net` will differ by exactly
what the script makes them differ by. So this proves:

- every branch is **reachable** through real parsing;
- terminal states and `unresolvedReason` are **assigned correctly** per branch;
- the run ledger records schema failures rather than swallowing them.

It proves nothing about decision quality, and it does not validate that the §4 metrics in
`EVALUATION.md` compute *correct* values — only that the code paths feeding them execute. The
distinction matters because a green WP3 is exactly the kind of result that gets read as more than it
is.

## What still has not executed

Named rather than left for a later session to discover:

1. **The worker role's persistence of failure branches.** `agents.spec.ts` drives `runAgentsCycle`
   with a fake repo and covers the happy path, cooldown/skip, HOLD, cleared EXIT and a failing
   persist. It does **not** cover what the role writes when a cycle ends `UNRESOLVED(MALFORMED_OUTPUT)`
   or `TIMEOUT`. Those branches are proven in the runner; their *persistence* is not.
2. **The full chain past the cycle.** Nothing here reaches risk evaluation → intent → paper fill →
   position monitor → recorded cycle with cost. WP3's original scope named that chain; this covers the
   model-facing half of it. The rest runs against a real database and the paper adapter, and remains
   unexercised as one composed path.
3. **Real provider behaviour.** Rate-limit responses, partial streams, provider-side schema drift and
   token-limit truncation mid-tool-call are scripted here as their *effects*, not observed. A recorded
   fixture from a real call would be stronger evidence and needs a key.
4. **Cost accounting under failure.** Cases 5–9 produce runs with token usage; whether `costUsd`
   accrues correctly against `D43` budgets when a cycle fails partway is asserted nowhere.

~~Items 1 and 2 are the honest remainder.~~ **Items 1 and 4 were taken together on 2026-09-10** — they
are one event, not two, and splitting them would have visited the same code path twice. See below.
Item 2 remains, and is the only one that touches a real database.

## Items 1 and 4, done together: what the system records when a cycle does not resolve

**Item 1 turned out to be a test gap, not a code gap.** `runAgentsCycle` calls `repo.persist(...)` and
`repo.chargeSpend(...)` **unconditionally**, outside any branch on cycle state, so an UNRESOLVED cycle
was already persisted with its failed runs and already charged. Nothing had asserted it; now
`agents.spec.ts` does, including that the failed run keeps its schema errors rather than being dropped.

**Item 4 was a real accounting gap, and it pointed the way the others have.** `modelUsd` is
`sum(runs.costUsd)`, and `failedRun` recorded `costUsd: 0` for both timeout and outage. For an outage
that is probably right. For a **timeout it is not**: we abort on *our own* deadline, and the provider
may well have generated and billed the call. Worse, the undercount is biased toward the most expensive
calls, because a timeout is by definition a long generation.

Two consequences, both in the same direction:

| | Effect of recording 0 |
| --- | --- |
| D43 spend budgets | undercounted, so the budget lasts longer than it should |
| `EVALUATION.md` §7(2) | the threshold divides edge by **model cost per decision**; a small denominator inflates the measured edge |

So a failed cycle looked free, and the error pushed toward *proceeding* — the fourth time this week an
error has pointed at the comfortable answer.

**Fixed by recording the uncertainty rather than rounding it away.** `AgentRun` gains
`costAccrual: MEASURED | UNKNOWN`. MEASURED means the provider returned usage metadata and
`costUsd` is what it billed — which **includes malformed output**, since that call completed and was
billed, it merely failed to parse. UNKNOWN means the call ended without metadata and `costUsd` is a
floor, not a measurement. Migration `20260910004700` backfills existing rows from what they already
record: not successful and zero tokens means no metadata ever arrived.

**What this obliges `EVALUATION.md` to do:** any metric that divides by model cost must report the
UNKNOWN share alongside it, the same way the adversary stop reports its counterfactual coverage. A
denominator assembled partly from floors is not a measurement, and the pre-registration should not
treat it as one.

Still not decided, and flagged rather than silently chosen: **whether a D43 budget should charge a
conservative estimate for an UNKNOWN run** instead of zero. That is a spend-policy question for WP4,
and the recording change is what makes it answerable.
