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

Items 1 and 2 are the honest remainder of WP3 as originally scoped and are the natural next step. Item
4 is the one most likely to matter with a metered key, since a failing cycle still spends.
