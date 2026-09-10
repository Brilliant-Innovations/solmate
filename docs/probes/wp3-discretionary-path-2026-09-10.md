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

### Which branch could do better than UNKNOWN, checked rather than assumed

UNKNOWN should be a fallback, not an automatic classification: some providers return usage on error
responses. Checking what the transport actually retains splits the two branches, and they differ:

- **Abort / timeout** (`providers.ts:77`). `fetchModelTransport` is non-streaming and `fetch` *rejects*
  on abort, so there is no response object, no body and no usage. With this transport UNKNOWN is not a
  fallback — it is the only answer available. Doing better would require a streaming transport that
  retains what arrived before the abort, which is a different design, not a fix.
- **Non-2xx / outage** (`providers.ts:80`). The body **is** in hand — it is sliced into the error
  message and then discarded. If a provider returns usage on an error response, it is being thrown
  away, and UNKNOWN here really is automatic rather than a fallback.

**Deliberately not fixed by speculation.** Writing a parser for error-body usage across two providers
without a recorded response from either is the "unexecuted code shipped as evidence" trap this
repository has already been caught by. The burn-in run (`EVALUATION.md` §5a) is exactly when real
error bodies become available; capturing them as fixtures is what should precede that change.

### The open WP4 question, with a recommendation

**Whether a D43 budget should charge an estimate for an UNKNOWN run instead of zero.** Recommended:
**charge a per-run floor with a bounded estimate on top** — which is better than the high percentile
this section first proposed, and better for a specific reason.

~~Charge at a high percentile of measured cost rather than the mean.~~ A percentile applies one number
to a heterogeneous population. There is more information available than that:

> **The input half is known locally.** We built the prompt, so its token count does not depend on the
> provider answering. Only the **output** half is unknown when a call times out. So an aborted call is
> never worth zero and never has to be guessed in full — it is *known input cost* plus an unknown
> output component.

And the output half has a principled estimator rather than a convention: **observed tokens-per-second
on MEASURED runs of the same model, times the elapsed time to our abort deadline.** That uses data
already being collected (`tokens` and `latencyMs` are on every MEASURED run), it is per-model rather
than pooled, and it degrades sensibly — a call aborted at 2 s is charged less than one aborted at 30 s,
which a percentile cannot express.

The percentile argument survives only as a fallback for the case where too few MEASURED runs of a
model exist to fit a rate.

**What the burn-in must confirm:** whether providers actually bill input tokens on an aborted
generation. If they do not, the floor is zero after all and only the estimator applies. That is a
question about billing behaviour, not about code, and it is answerable from the first real invoice.

The percentile matters because of the bias already identified: UNKNOWN is concentrated on timeouts,
timeouts are by definition long generations, so the mean of MEASURED calls systematically understates
exactly the population that goes UNKNOWN. A mean would be an estimate built from the wrong sample.

The argument for charging rather than zeroing is that **both consumers err toward stopping**, which is
the correct way to be wrong about an unmeasurable quantity:

| Consumer | Effect of charging an estimate | Direction |
| --- | --- | --- |
| D43 spend budgets | exhausts the budget sooner | conservative for a spend bound |
| `EVALUATION.md` §7(2) | inflates the cost denominator, deflating measured edge — and since the baseline arm carries **no** model cost, it penalises only the LLM arms | conservative for a proceed decision |

Zeroing errs toward proceeding in both. Charging errs toward stopping in both.

**Report both figures regardless**: measured-only and estimate-inclusive, with the UNKNOWN share
beside them, and have the pre-registered rule read the conservative one. That keeps the choice visible
rather than baked into a single number nobody can later interrogate.

Not implemented here — it changes spend behaviour and belongs to WP4 with the rest of the budget
work. The `costAccrual` recording is what makes it answerable.
