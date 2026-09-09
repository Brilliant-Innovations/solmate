# ADR-0012 — A funding claim binds the amount and the source, and its post-hoc residual is accepted for now

**Status:** Accepted
**Date:** 2026-09-09
**Class (§31 taxonomy):** DEFECT for the missing amount binding; MISSING REQUIREMENT for the residual below.
**Blueprint text affected:** §20.18 (manual funding), §3.7, §6.16A, D56; §32 security questions "can funding UI/provider compromise substitute a destination, mint, cluster or unrelated instruction without the typed funding guard rejecting it" and "can a wallet-reported success change authoritative funding state before chain reconciliation".
**§31-protected decisions affected:** "trading-wallet replenishment is manual; automated monitoring/alerts only" — unchanged. "wallet/chain reconciliation is authoritative" — strengthened. "own-wallet/vault activity cannot become trading evidence" — strengthened.
**Source:** adversarial review 2026-09-09, findings M-1, M-2, M-3 (`docs/reviews/review-m9-m10-m11-adversarial-2026-09-09.md`).

## Context

Three defects sat between the typed funding guard and chain reconciliation.

1. **The guard never saw instruction data.** `PreparedInstruction` carried the program and the account addresses only, and `funding-wallet.tsx` dropped `ix.data` before validation. Everything the guard checked — destination, mint, ATA, cluster, source — could be correct while the encoded amount was anything at all. A compromised web bundle could also append a ComputeBudget instruction setting an arbitrary priority fee, accepted wholesale inside `maxInstructions: 4`. The wallet extension's own approval screen remains a real second control, which is why this was a gap in the guard's stated purpose rather than a direct fund-loss path.
2. **Nothing compared the claim to the chain.** The worker recorded `requestedAmount` verbatim; reconciliation matched a claim to a transaction by signature and endpoints, then confirmed the event from the observed delta without ever comparing the two numbers.
3. **A claim could relabel an inflow.** The matched branch `continue`d past `classifyMovement`, and the source was checked only against the claim's own `sourceWallet` — never against the owned-address registry — so an own wallet presented as an external funder produced an `EXPECTED / FUNDING` movement and a clean reconciliation.

## Decision

- `PreparedInstruction` carries `data` as lowercase hex, **required**, so a caller cannot disable the check by omission. `validateFundingInstructions` decodes the System `Transfer` (u32 discriminator 2, u64 lamports) and SPL `TransferChecked` (byte 12, u64 amount, u8 decimals) payloads and refuses `AMOUNT_MISMATCH` unless the encoded amount is the reviewed amount, `INSTRUCTION_DATA_INVALID` for any data it cannot read as the shape its program requires, and `PRIORITY_FEE_ABOVE_MAX` for a `SetComputeUnitPrice` above `FundingPolicy.maxPriorityFeeMicroLamports` (default 1 000 000). The policy version moves to `funding-v2`.
- `fundingClaimVerdict` is the single place reconciliation decides whether a movement is the reviewed transfer. It refuses `FUNDING_AMOUNT_MISMATCH` when the chain moved a different amount and `FUNDING_SOURCE_IS_OWNED` when the source is in the owned-address registry. A refused claim leaves the movement `UNKNOWN`, leaves the funding event `SUBMITTED`, and the reconciliation is not clean.
- `fundingEventBySignature` orders by `created_at desc limit 1`: `tx_signature` is not unique.

## The residual, accepted for now

A funding claim is filed **after** the wallet has already submitted — the operator reviews, signs, and the UI then files `FUND_TRADING_WALLET` with the signature the wallet reported. So an operator session that can read the dashboard already knows a real inflow's signature and amount, and can still file a claim describing it. The amount and owned-source bindings narrow the attack from "any unexplained inflow" to "an inflow whose exact signature and amount you already know, from an address that is not ours", but they do not close it.

Closing it needs a **pre-registered claim**: the operator files the intent (source, mint, amount, destination) and receives a claim id *before* signing, and the post-signature request may only attach a signature to an existing claim whose fields it does not change. That is an operator-flow change to §20.18 and to the `FUND_TRADING_WALLET` control kind, and it is deliberately not being made inside a review-remediation pass.

**This is a decision to defer, not a decision that the residual is acceptable at scale.** It is recorded as an open item for the M12 promotion review, and P1A carries no live custody, so nothing is exposed today.

## Consequences

- The contract-set digest changes (`PreparedInstruction`, `FundingPolicy`), so the three service images and the worker bundle must be rebuilt before readiness passes.
- A wallet library that does not expose instruction data cannot be used for funding, which is the intended constraint.
- `libs/contracts/src/policy/funding.spec.ts` carries the amount-substitution attack, the malformed-data cases, the priority-fee ceiling and the claim verdicts, including a property that no amount other than the reviewed one is ever accepted.
