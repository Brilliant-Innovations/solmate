# recoveryctl runbook (skeleton) — signer/custody break-glass, D25 plane 2

Status: **skeleton** (plan M3). The read-only enumeration and the ordered checklist exist in `tools/recoveryctl.mjs`. Every signing step is performed at the signer provider's control plane by the break-glass principal and is shaped by Probe A/C (plan MP); the tool gains those verbs only after the probe results are recorded and reviewed. Nothing on this plane routes through `execution-service`, `worker`, `risk-authorizer` or `web` (D53).

## Two planes, two credentials

| Plane | Tool | Reaches | Credential | Can |
| --- | --- | --- | --- | --- |
| 1. Application emergency control | `tools/traderctl.mjs` | executor out-of-band endpoint | emergency operator Ed25519 key (operator machine only) | `PAUSE_NEW_ENTRIES`, `EMERGENCY_CLOSE_ASSET`, `EMERGENCY_CLOSE_ALL` — settlement-only, chain-capped |
| 2. Signer/custody break-glass | `tools/recoveryctl.mjs` + provider control plane | signer backend | break-glass principal (MFA/quorum, incident-scoped) | revoke executor identity, incident signing identity, provider vault recovery, `SWEEP_TO_COLD_RECOVERY` |

Compromise or outage of the executor must not prevent plane 2. The two planes never share a key.

## Ordered steps (D54: revoke first, then recover, then sweep)

1. Declare the incident: who, when, suspected scope. Nothing below is routine trading.
2. `PAUSE_NEW_ENTRIES` through `traderctl` if the executor still answers. The pause is not a precondition for step 3.
3. **Revoke first.** At the signer provider, disable the executor workload identity's signing permission. Record the policy/version identity changed. A Solana public key cannot be rotated in place; cutting off the requester is the containment.
4. **Chain first.** `node tools/recoveryctl.mjs <recovery-env> enumerate`: wallet SOL and SPL balances, recent signatures, plus provider vault balances from the provider. Reconstruct exposure from chain and custody truth, never from the database.
5. Activate the break-glass principal for a declared, time-boxed window under the provider's MFA/quorum. It may sign only: held-asset → SOL/USDC risk-reducing swaps; provider vault cancel/withdraw/recovery; `SWEEP_TO_COLD_RECOVERY`. It cannot promote a Release, widen policy or become an autonomous trading identity.
6. Close or recover risk with the break-glass principal. Every signature is separately logged and alerted.
7. `SWEEP_TO_COLD_RECOVERY` to the single pre-registered cold wallet and its canonical token accounts. The recipient is pinned in the signer control plane and documented offline; no CLI argument, environment variable on the executor host, database row or browser supplies it.
8. Rotate credentials, redeploy from a clean build, verify the signer policy digest, then reconcile chain/custody into the application (executor journal `RECONCILED_INTO_DB` lines, `traderctl`'s pause cleared only after operator review through the executor's authenticated plane).
9. Operator closure: the incident is live-blocking until steps 3–8 are complete and reviewed. Live Readiness is re-run before any live arming.

## What the skeleton deliberately lacks

- No signing capability of any kind. `enumerate` uses a closed read-only RPC method set (`getBalance`, `getSlot`, `getTokenAccountsByOwner`, `getSignaturesForAddress`).
- No cold-recovery address anywhere in the repository or in any env file this tool reads.
- No provider SDK. The provider-side verbs (revocation, incident identity, vault recovery, sweep) are added after Probe A/C, as a reviewed change to operator tooling only.

## Env file (operator's recovery material, outside every deployable)

```
SOLANA_RPC_URL=https://...
TRADING_WALLET=<trading wallet public key>
```

Public data only. Break-glass credentials never live in a file this tool reads.
