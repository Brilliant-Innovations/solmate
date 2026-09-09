# Runbook — wallet reserve and manual funding

Blueprint D35 (replenishment is manual; monitoring is automatic), D56 (post-arm funding raises the blast radius and requires re-attestation), §20.18 Wallet / Custody, §3.7; plan M8a wallet reserve monitoring, M9 funding connector. The platform never pulls funds from a treasury; an operator moves capital into the dedicated trading wallet through their own wallet, and the ledger learns about it from the chain.

## Signals

| Signal | Where | Meaning |
| --- | --- | --- |
| `RESERVE_BELOW_THRESHOLD` (NOTICE) | Alert Center, Telegram if configured | gas SOL below `minGasLamports` (default 0.05 SOL) or settlement below `minSettlementBaseUnits` (default 10 USDC) of `wallet-reserve-v1` |
| `WALLET_RESERVES` readiness row | Live Readiness | red when reserves are below policy; blocks live arming |
| Wallet / Custody page | `/wallet` | balances at the last reconciliation, reserves, custody accounts, funding events with their confirmation state |
| `CAPITAL_ATTESTATION` readiness row and "RE-ATTESTATION REQUIRED" label on the funding review | Live Readiness, `/wallet` | recognized capital would exceed the attested ceiling of the armed Release |

## Procedure

1. **Read the reserve state before moving anything.** `/wallet` shows the reconciled SOL and USDC balances, the reserve thresholds and any unexplained movement. If reconciliation is not clean, resolve that first (unexplained movement pauses entries and a funding transfer on top of it only adds a second thing to explain).
2. **Decide the amount against the ceiling, not against appetite.** The funding review table on `/wallet` projects the post-transfer recognized capital against the attested ceiling of the armed Release (D56). If the projection crosses the ceiling the review shows `RE-ATTESTATION REQUIRED — NEW ENTRIES WILL PAUSE`; funding is still allowed, but new entries pause until an admin re-arms with a new ceiling (`ARM_RELEASE`, step-up). Fund the reserve shortfall, not a round number.
3. **Connect the operator wallet.** The Wallet Standard connector on `/wallet` is labelled `EXTERNAL OPERATOR WALLET — NOT USED FOR AUTONOMOUS TRADING`. It never becomes trading, approval or authentication authority and the autonomous runtime never depends on it (§31). The trading wallet card is labelled `AUTONOMOUS TRADING WALLET — KEY NON-EXPORTABLE / SIGNING POLICY ISOLATED`.
4. **Review the exact transfer.** Source, destination trading wallet (and its canonical settlement ATA for USDC), asset, amount, balances now and after, network fee including ATA rent if the destination ATA is missing, cluster. The typed funding guard (`validateFundingInstructions`) rejects any instruction set that is not exactly one transfer into the configured destination on the configured cluster before the wallet prompt appears; if the review refuses, stop and report — do not hand-craft a transfer.
5. **Sign in your wallet, then let the ledger catch up.** The wallet's own prompt is the signing authority (FAST control, D41). The browser files a `FUND_TRADING_WALLET` report with the transaction signature; the worker's `funding` role re-validates the report against `trading.accounts` and records a `SUBMITTED` funding event. Nothing authoritative changes yet.
6. **Confirmation comes from the chain only.** The `reconciliation` role classifies the movement from your reported source wallet into the trading wallet or its ATA as `EXPECTED / FUNDING` and marks the event confirmed with the observed deltas. A wallet-reported success that never lands stays `SUBMITTED` and is visible as such; an unreported deposit from an unknown source is an unexplained movement and pauses entries.
7. **Re-attest if the ceiling was crossed.** Admin: `/releases/[id]` arming review → `ARM_RELEASE` with the new capital ceiling (step-up). Until then the runtime refuses new entries; open positions stay managed.
8. **Verify and record.** `/wallet` shows the funding event confirmed and reserves above policy; the `WALLET_RESERVES` row turns green on the next readiness cycle. Record the drill when rehearsing: `node tools/record-readiness-evidence.mjs --row WALLET_RESERVES --kind DRILL --verdict PASS --evidence <tx signature>`.

## What never happens here

- No automated treasury pull, no scheduled top-up, no "auto-fund to target".
- No transfer to any address other than the configured trading wallet or its canonical settlement ATA; the guard has no override.
- No change to trading authority: funding does not arm, resume or approve anything, and the connected wallet cannot sign trades.
- Reserve alerts are NOTICE severity by design; they never disable deterministic exits or move capital.
