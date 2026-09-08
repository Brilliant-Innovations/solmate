# M8b evidence — `LIVE_AUTO` prerequisites (direct-pool emergency adapters), 2026-09-08

Blueprint: §14.6, §15.10, §35.17–18, D33. Plan: `Execution_Plan_v4.md` §4 M8b. Everything below was built and validated key-free from this workspace; nothing here signed or submitted a real transaction. Live validation used unsigned `simulateTransaction` against mainnet through the worker's RPC endpoint with a stand-in payer (simulation verifies no signatures), so the swap programs themselves judged every built transaction.

## Scope status

| M8b item | Status | Where |
| --- | --- | --- |
| Direct-pool emergency adapters behind one execution contract: Raydium AMM v4, CPMM, CLMM; Orca Whirlpools; Meteora DLMM | Done | `libs/execution/src/direct-pool/` (`types.ts` contract, one adapter per family, `token2022.ts`, `bytes.ts`) |
| Periodic unsigned build+simulate dry-runs | Done | worker role `emergency-dry-run` (`apps/worker/src/roles/emergency-dry-run.ts`), `runEmergencyDryRun` in `dry-run.ts`, `emergency-route-v1` policy |
| Stale dry-run blocks `LIVE_AUTO` entry for that asset | Done | `libs/risk/src/policy/emergency-route.ts`; risk-authorizer denies `EMERGENCY_ROUTE_NOT_READY` / `EMERGENCY_ROUTE_UNKNOWN` |
| Emergency-route snapshot consumption in the executor's `EMERGENCY_CLOSE` path | Done | `libs/execution/src/adapter/direct-pool-adapter.ts`, `libs/execution/src/chain/submit.ts`, `ExecutorPipeline.emergencyAction` fallback |
| Jito-style landing option | Open | needs a private landing endpoint and its credentials (operator); the RPC path is the approved default per §14.6 step 7 |

## Layout verification

Every account layout was decoded from live mainnet accounts before an adapter was written, and the decoded fields were checked against known facts (mints of the persisted route, Q64.64 prices equal to `(1 + bin_step/10000)^bin_id`, sqrt prices consistent with `1.0001^tick`, PDA constants such as the Raydium AMM authority `5Q544f…` and the CPMM authority `GpMZbS…`). Captured accounts live as deterministic fixtures under `libs/execution/src/direct-pool/fixtures/`.

| Family | Program | Verified accounts | Sources |
| --- | --- | --- | --- |
| Raydium CPMM | `CPMMoo8L…` | PoolState 637 B, AmmConfig 236 B | live decode |
| Raydium AMM v4 | `675kPX9M…` | AmmInfo 752 B, OpenBook market 388 B | live decode |
| Meteora DLMM | `LBUZKhRx…` | LbPair 904 B, BinArray 10136 B, Oracle | published IDL lb_clmm 0.12.0 + live decode |
| Raydium CLMM | `CAMMCzo5…` | PoolState 1544 B, TickArrayState 10240 B, bitmap extension 1832 B, AmmConfig | published IDL + program sources + live decode |
| Orca Whirlpool | `whirLbMi…` | Whirlpool 653 B, fixed tick array 9988 B, dynamic tick array (bitmap + packed ticks), Oracle | program sources + live decode |

## Live quote-versus-simulation results

Local quote and simulated output are compared exactly (the dry-run classifies a shortfall beyond the policy slippage as `SLIPPAGE_EXCEEDED`). All figures are base units; input 1e9 unless noted.

| Family | Pool | Route | Quote | Simulated | Notes |
| --- | --- | --- | --- | --- | --- |
| Raydium CPMM | `AiP94aqc…` | HKJH → SOL | 43434 | 43434 | 30 bp fee |
| Raydium AMM v4 | `7yMhxapz…` | 463S → SOL | 104930 | 104930 | 25 bp fee |
| Raydium AMM v4 | `83G6VzJz…` | GtDZ → SOL | 51871 | 51871 | stand-in holder's real token account |
| Raydium CPMM | `J28smrHe…` | HtTY → SOL | 33433565 | 33433565 | |
| Meteora DLMM | `7gj8L6q7…` | BANK → USDC | 261617401 | 261617401 | bin walk, 68 bp impact, 2% base fee |
| Meteora DLMM | `2xQ69zDW…` | 8RAF → SOL | 2887687 | 2887687 | Token-2022 mint with a 3% transfer fee, volatility fee active |
| Raydium CLMM | `CZt61djg…` | HcRL → USDC | 102028 | 102028 | dynamic fee active (3.4% total), 3 tick arrays |
| Raydium CLMM | `9iS1ZKRP…` | DKu9 → USDC | 8701612 | 8701612 | |
| Raydium CLMM | `HpgV2jnz…` | Gbbe → USDC | 337521201 | 337521201 | 2 tick arrays |
| Orca Whirlpool | `7YGHXMBp…` | 31k8 → USDC | 291908 | 291908 | fixed + dynamic arrays |
| Orca Whirlpool | `AqJ5JYNb…` | mSOL → USDC | 144485935 | 144485935 | |
| Orca Whirlpool | `5hWJUNTt…` | JitoSOL → USDC | 133878796 | 133878796 | |

Honest refusals seen live: a size beyond the three loaded tick arrays (`insufficient liquidity within the 3 loaded tick array(s)`), a pool outside the default tick-array bitmap whose first array needs the extension before it can be located (`no tick array could be loaded`), and a paper wallet with no SOL (`PAYER_UNFUNDED`). None of these are guessed at; each records its class on the snapshot.

## Dry-run role, first full cycle with all five families (worker log `worker-p1a-30.log`, 21:29 UTC)

| Outcome | Count |
| --- | --- |
| OK | 25 |
| DECODE_FAILED (size beyond loaded arrays / array outside default bitmap) | 4 |
| POOL_REJECTED | 1 |
| PAYER_UNFUNDED (no stand-in holder, paper wallet) | 1 |
| targets due | 33 (31 ran, 2 without a snapshot) |

Per family: DLMM 15 OK, AMM v4 5 OK, CLMM 2 OK, Whirlpool 2 OK, CPMM 1 OK.

## Executor fallback (harness, `apps/execution-service/src/harness/emergency.spec.ts`)

- With the router unrouteable (`NO_ROUTE`), an out-of-band `EMERGENCY_CLOSE_ASSET` is rebuilt locally from the persisted route over a synthetic Raydium CPMM pool with the real byte layout, passes the structural check, independent simulation and semantic delta validation, is signed and journaled before submit, re-reads the mode gate, is submitted over RPC, confirms and finalizes; the exposure ledger releases and the local pause applies. Journal: `ATTEMPT_PREPARED` with `executionPath: DIRECT_POOL_RPC`, `fallbackFrom: NO_ROUTE` and the hop; `ATTEMPT_SUBMITTED` with `path: DIRECT_POOL_RPC`.
- Without a persisted route the primary refusal stands, `EMERGENCY_COMMAND_REJECTED` records `DIRECT_POOL_ROUTE_MISSING`, nothing is signed or sent.
- A route whose pool no longer trades is refused before signing (`ROUTE_NOT_TRADEABLE`) and recorded on the attempt row.
- The fallback never runs after a signature exists on the primary path: a signed-but-unconfirmed Jupiter attempt stays recovery's business (§21.3, INV-23), so one command cannot sell twice.

## Exit gate (P6)

| Acceptance | Evidence |
| --- | --- |
| Emergency adapter reduces risk when Jupiter is down | harness test above (unrouteable router → direct-pool close finalizes); live validation that the built transactions are accepted by all five programs |
| Same-mint lot attribution preserved | `ExecutorPipeline.record` releases open entries of the mint in proportion to the chain-held quantity sold, unchanged by the fallback path (`EXIT_CONFIRMED` per open intent) |
| Jito-style landing | open (operator credentials); RPC landing is the approved path when the private one is not configured |

## What remains before the box can close

1. Jito-style private landing option with a health check, and the choice logic of §14.6 step 7 (prefer private when healthy, else direct RPC).
2. A target-environment drill (Profile 2) that runs the fallback against a real held asset with the production signer unavailable to the primary path, recorded as a readiness row (operator).
3. ~~Loading the tick-array bitmap extension before choosing the first array~~ — done the same day: the extension now travels with the pool in the first fetch round; the pool that reported `no tick array could be loaded` (`277xLdcm…`, eL5f → USDC) validates with quote 8975591 = simulated 8975591 across two arrays under an active dynamic fee.
