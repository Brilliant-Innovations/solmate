import { randomUUID } from 'node:crypto';
import { DEFAULT_ELIGIBILITY_POLICY, DEFAULT_FRESHNESS_REQUIREMENTS, DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_PAPER_FILL_POLICY, DEFAULT_RECONCILIATION_POLICY, DEFAULT_RISK_POLICY, DEFAULT_S0_SAFETY_GATE_POLICY, DEFAULT_SAFETY_POLICY, DEFAULT_SELF_INFLUENCE_POLICY, DEFAULT_SESSION_POLICY, FEATURE_ENGINE_V1, mulDiv, getContractSetDigest, parseWorkerEnv, systemClock, type CandleResolution, type MintAddress, type Uuid } from '@sol-agent-trader/contracts';
import {
  applyExit,
  coldStartFacts,
  createIntent,
  createRuntimeSession,
  createSql,
  ensurePaperAccount,
  ensureSleeve,
  ensureStrategyVersion,
  entryHealth,
  findOpenSession,
  finishAttempt,
  highSince,
  insertPortfolioSnapshot,
  journalAttempt,
  listCyclesAwaitingEntry,
  listOpenPositionsForAccount,
  loadFeedHealth,
  listPendingControlRequests,
  loadSession,
  openPosition,
  paperBook,
  persistRuntimeTransition,
  recordExitDecision,
  recordRiskEvaluation,
  resolveControlRequest,
  saveColdStartGates,
  sessionEntryGate,
  setIntentState,
  stepUpVerifiedFor,
  tightenStop,
  updateMark,
  windDownFacts,
  listCandidatesAwaitingStrategy,
  persistS0Decisions,
  heldBucketTimes,
  insertEmergencyRouteSnapshot,
  insertSnapshot,
  latestEligibilityBaseline,
  latestEmergencySnapshot,
  LeaseManager,
  ledgerExpectations,
  chargeProviderSpend,
  expireCandidates,
  ingestWalletEvents,
  insertCandidate,
  insertFeatureSnapshot,
  lastTerminalCandidateAt,
  listOpenCandidates,
  listScanInputs,
  latestEligibility,
  latestMarketSnapshotId,
  listAssetsForFeatures,
  listTrackedWallets,
  loadProviderSpend,
  walletCursor,
  lifecycleForSignature,
  listAssetsForEvaluation,
  listCustodyAccounts,
  listOpenPositions,
  listOwnedAddresses,
  listTrackedAssets,
  listTradingAccounts,
  loadCandles,
  previousSafetyBaseline,
  reconciliationCursor,
  recordEligibility,
  recordPositionSafety,
  recordReconciliation,
  registerOwnedAddress,
  runWithLease,
  upsertDiscoveredAssets,
  upsertFeedHealth,
  writeCandles,
  type Sql,
} from '@sol-agent-trader/db/server';
import { JupiterSwapClient, NoRouteError, PaperExecutionAdapter } from '@sol-agent-trader/execution';
import { s0StrategyVersion } from '@sol-agent-trader/strategies';
import { BIRDEYE_TIERS, BirdeyeClient, ComputeUnitLedger, defaultFreshnessContracts, fetchTransport, JupiterPriceClient } from '@sol-agent-trader/market';
import { redact, type Logger } from '@sol-agent-trader/observability';
import { HeliusClient } from '@sol-agent-trader/onchain';
import { initTelemetry } from '@sol-agent-trader/observability/server';
import { SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import { restoredEligibilityHealthState, runEligibilityCycle } from './roles/eligibility.js';
import { runHeldAssetSafetyCycle } from './roles/held-asset-safety.js';
import { runReconciliationCycle } from './roles/reconciliation.js';
import { runTrackedWalletsCycle } from './roles/tracked-wallets.js';
import { runFeaturesCycle } from './roles/features.js';
import { runCandidatesCycle } from './roles/candidates.js';
import { runS0Cycle } from './roles/s0.js';
import { runPaperEntryCycle } from './roles/paper-entry.js';
import { runPositionMonitorCycle } from './roles/position-monitor.js';
import { runSessionCycle } from './roles/session.js';
import { newEntriesAllowed } from '@sol-agent-trader/risk';
import { initialIngestState, runMarketIngestCycle, type MarketRepo } from './roles/market-ingest.js';

/**
 * worker entrypoint.
 *
 * Multi-role runtime: ingestion, signals, agents, trading orchestration and reconciliation over
 * durable pgmq queues drained in risk-first order (§5.4). Holds no signer credential and no
 * risk-authorization private key: the environment is validated by the fail-closed worker schema
 * before anything else runs (§26.1, GUARDRAILS Part 4). Reports its contract-set digest at
 * startup (D50). `--print-digest` prints the digest and exits without touching the environment.
 *
 * Roles (WORKER_ROLES, each under its own ops.worker_leases lease so two workers never do the
 * same job twice):
 *   market-ingest  discovery, candles, snapshots, feed health (needs BIRDEYE_API_KEY)
 *   eligibility    chain-truth reads + analytics corroboration → §6.2 records (needs SOLANA_RPC_URL and BIRDEYE_API_KEY)
 *   held-asset-safety  open positions: chain truth, sell probe, emergency-pool re-verification → §7.5 safety state (same needs)
 *   reconciliation  chain/custody truth per trading account, movements via Helius, unknown-movement pause (D9; needs SOLANA_RPC_URL; HELIUS_API_KEY to explain movements)
 *   tracked-wallets  Helius parsed history for intelligence.wallets → append-only wallet events, owned wallets skipped (§6.7, D26; needs HELIUS_API_KEY)
 *   features        versioned point-in-time feature vectors per eligible/evaluating asset from closed 1m candles (§6.8, D63 warm-up)
 *   candidates      deterministic momentum trigger over the latest vectors under the entry gate and the self-influence guard; dedupe, cooldown, expiry (§9.1, §9.7)
 * All roles share one Birdeye client so the purchased compute-unit allowance is one budget.
 */
const SERVICE = 'worker' as const;
type WorkerEnv = ReturnType<typeof parseWorkerEnv>;

function issuesOf(err: unknown): unknown {
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues.map((i: { path?: unknown[]; message?: string }) => ({ path: (i.path ?? []).join('.'), message: i.message })) : String(err);
}

const LOOKBACK_BUCKETS: Readonly<Record<CandleResolution, number>> = { '15s': 240, '1m': 300, '5m': 288, '15m': 192, '1h': 168, '4h': 180 };

async function main(): Promise<void> {
  const digest = await getContractSetDigest();
  if (process.argv.includes('--print-digest')) {
    console.log(JSON.stringify({ service: SERVICE, event: 'contract_digest', contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount }));
    return;
  }

  let env: WorkerEnv;
  try {
    env = parseWorkerEnv(process.env);
  } catch (err) {
    console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'env_invalid', issues: redact(issuesOf(err)) }));
    process.exit(1);
  }

  const telemetry = initTelemetry({ service: SERVICE, deploymentProfile: env.DEPLOYMENT_PROFILE, sentryDsn: env.SENTRY_DSN_WORKER, instanceId: env.SERVICE_INSTANCE_ID });
  const logger = telemetry.logger;
  logger.info('startup', { contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount, cluster: env.SOLANA_CLUSTER, roles: env.WORKER_ROLES });

  const roles = new Set(env.WORKER_ROLES.split(',').map((r) => r.trim()).filter(Boolean));
  const wanted = [...roles].filter((r) => r === 'market-ingest' || r === 'eligibility' || r === 'held-asset-safety' || r === 'reconciliation' || r === 'tracked-wallets' || r === 'features' || r === 'candidates' || r === 's0' || r === 'paper-entry' || r === 'position-monitor' || r === 'session');
  if (wanted.length > 0) await runRoles(env, logger, new Set(wanted));
  await telemetry.shutdown();
}

interface Shared {
  sql: Sql;
  /** Null without BIRDEYE_API_KEY: market roles are disabled, chain roles keep running (review R4-12). */
  birdeye: BirdeyeClient | null;
  /** One Jupiter quote client per process (ADR-0003; review R4-17): one rate bucket for every role. */
  jupiter: JupiterSwapClient;
  /** One read-only RPC client per process at `confirmed` for operational reads, plus one at `finalized` for reconciliation (review R4-13). */
  rpc: SolanaRpcClient | null;
  rpcFinalized: SolanaRpcClient | null;
  leases: LeaseManager;
  holder: string;
  stopping: () => boolean;
}

const MARKET_ROLES = new Set(['market-ingest', 'eligibility', 'held-asset-safety']);

async function runRoles(env: WorkerEnv, logger: Logger, roles: Set<string>): Promise<void> {
  const tier = BIRDEYE_TIERS[env.BIRDEYE_TIER];
  const holder = env.SERVICE_INSTANCE_ID ?? `worker-${process.pid}`;
  const sql = createSql({ url: env.SUPABASE_DB_URL, applicationName: 'worker' });
  let writes: Promise<void> = Promise.resolve();
  let birdeye: BirdeyeClient | null = null;
  if (!env.BIRDEYE_API_KEY) {
    const disabled = [...roles].filter((r) => MARKET_ROLES.has(r));
    if (disabled.length) logger.warn('roles_disabled', { roles: disabled, reason: 'BIRDEYE_API_KEY not set; market feeds will report FAILED' });
  } else {
  // The purchased Birdeye allowance is metered per calendar month by the provider, so the ledger
  // resumes from the persisted spend instead of resetting on every restart (a restart loop could
  // otherwise burn the whole month). Charges are written through in order; a failed write is
  // logged and the in-memory ledger stays the stricter of the two.
  const ledger = new ComputeUnitLedger(systemClock, tier.computeUnitsPerMonth);
  const month = ComputeUnitLedger.monthKeyFor(systemClock.nowMs());
  const persisted = await loadProviderSpend(sql, 'BIRDEYE', month);
  if (persisted) ledger.restore({ month, used: persisted.usedCu, byEndpoint: persisted.byEndpoint });
  logger.info('birdeye_ledger_restored', { month, used: ledger.snapshot().used, allowance: tier.computeUnitsPerMonth });
  ledger.onCharge((c) => {
    writes = writes
      .then(async () => {
        const total = await chargeProviderSpend(sql, 'BIRDEYE', c.month, c.endpoint, c.cu);
        ledger.sync(c.month, total);
      })
      .catch((err: unknown) => {
        logger.error('birdeye_ledger_persist_failed', { error: err instanceof Error ? err.message : String(err) });
      });
  });
  birdeye = new BirdeyeClient({ apiKey: env.BIRDEYE_API_KEY, tier, transport: fetchTransport, clock: systemClock, ledger });
  }
  const jupiter = new JupiterSwapClient({ clock: systemClock, apiKey: env.JUPITER_API_KEY, requestsPerSecond: env.JUPITER_REQUESTS_PER_SECOND });
  const rpc = env.SOLANA_RPC_URL ? new SolanaRpcClient({ url: env.SOLANA_RPC_URL, allowedOrigins: [new URL(env.SOLANA_RPC_URL).origin], nowMs: () => systemClock.nowMs() }) : null;
  const rpcFinalized = env.SOLANA_RPC_URL ? new SolanaRpcClient({ url: env.SOLANA_RPC_URL, allowedOrigins: [new URL(env.SOLANA_RPC_URL).origin], commitment: 'finalized', nowMs: () => systemClock.nowMs() }) : null;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const shared: Shared = { sql, birdeye, jupiter, rpc, rpcFinalized, leases: new LeaseManager(sql, holder), holder, stopping: () => stopping };

  const loops: Promise<void>[] = [];
  const noRpc = (role: string) => logger.warn('roles_disabled', { roles: [role], reason: 'SOLANA_RPC_URL not set' });
  if (roles.has('market-ingest') && birdeye) loops.push(marketIngestLoop(env, logger, { ...shared, birdeye }, tier));
  if (roles.has('eligibility') && birdeye) {
    if (!rpc || !env.SOLANA_RPC_URL) noRpc('eligibility');
    else loops.push(eligibilityLoop(env, logger, { ...shared, birdeye }, rpc, env.SOLANA_RPC_URL));
  }
  if (roles.has('held-asset-safety') && birdeye) {
    if (!rpc || !env.SOLANA_RPC_URL) noRpc('held-asset-safety');
    else loops.push(heldAssetSafetyLoop(env, logger, { ...shared, birdeye }, rpc, env.SOLANA_RPC_URL));
  }
  if (roles.has('reconciliation')) {
    if (!rpcFinalized || !env.SOLANA_RPC_URL) noRpc('reconciliation');
    else loops.push(reconciliationLoop(env, logger, shared, rpcFinalized, env.SOLANA_RPC_URL));
  }
  if (roles.has('features')) loops.push(featuresLoop(env, logger, shared));
  if (roles.has('candidates')) loops.push(candidatesLoop(env, logger, shared));
  if (roles.has('s0')) loops.push(s0Loop(env, logger, shared));
  if (roles.has('paper-entry')) loops.push(paperEntryLoop(env, logger, shared));
  if (roles.has('position-monitor')) loops.push(positionMonitorLoop(env, logger, shared));
  if (roles.has('session')) loops.push(sessionLoop(env, logger, shared));
  if (roles.has('tracked-wallets')) {
    if (!env.HELIUS_API_KEY) logger.warn('roles_disabled', { roles: ['tracked-wallets'], reason: 'HELIUS_API_KEY not set' });
    else loops.push(trackedWalletsLoop(env, logger, shared, env.HELIUS_API_KEY));
  }
  await Promise.all(loops);
  await writes;
  await sql.end({ timeout: 5 });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs `cycle` every `intervalMs` under the named lease until stop or fencing. */
async function loopUnderLease(role: string, intervalMs: number, logger: Logger, shared: Shared, cycle: () => Promise<void>): Promise<void> {
  const ran = await runWithLease(shared.leases, { role, ttlSeconds: 90, heartbeatIntervalMs: 30_000 }, async (isFenced) => {
    while (!shared.stopping() && !isFenced()) {
      const started = systemClock.nowMs();
      try {
        await cycle();
      } catch (err) {
        logger.error(`${role.replace('-', '_')}_cycle_failed`, { error: err instanceof Error ? err.message : String(err) });
      }
      const deadline = started + intervalMs;
      while (!shared.stopping() && !isFenced() && systemClock.nowMs() < deadline) await sleep(Math.min(5_000, deadline - systemClock.nowMs()));
    }
    logger.info(`${role.replace('-', '_')}_stopped`, { stopping: shared.stopping(), fenced: isFenced() });
  });
  if (!ran) logger.warn(`${role.replace('-', '_')}_lease_unavailable`, { holder: shared.holder });
}

type SharedWithBirdeye = Shared & { birdeye: BirdeyeClient };

async function marketIngestLoop(env: WorkerEnv, logger: Logger, shared: SharedWithBirdeye, tier: (typeof BIRDEYE_TIERS)[keyof typeof BIRDEYE_TIERS]): Promise<void> {
  const intervalMs = env.MARKET_INGEST_INTERVAL_MS;
  const cyclesPerMonth = (30 * 86_400_000) / intervalMs;
  // Smoothing only: the client's compute-unit ledger is the hard monthly cap.
  const cuBudgetPerCycle = Math.max(100, Math.floor(((tier.computeUnitsPerMonth ?? 0) * 0.9) / cyclesPerMonth));
  const requestBudgetPerCycle = Math.max(3, Math.floor(tier.requestsPerSecond * (intervalMs / 1000) * 0.5));
  const { sql } = shared;
  const jupiter = new JupiterPriceClient({ transport: fetchTransport, clock: systemClock, apiKey: env.JUPITER_API_KEY, requestsPerSecond: env.JUPITER_REQUESTS_PER_SECOND });
  const repo: MarketRepo = {
    listTrackedAssets: (limit) => listTrackedAssets(sql, limit),
    heldBucketTimes: (assetId, resolution, from, to) => heldBucketTimes(sql, assetId, resolution, from, to),
    writeCandles: (candles) => writeCandles(sql, candles),
    loadCandles: (assetId, resolution, from, to) => loadCandles(sql, assetId, resolution, from, to),
    upsertDiscoveredAssets: (tokens, now) => upsertDiscoveredAssets(sql, tokens, now),
    insertSnapshot: (snapshot) => insertSnapshot(sql, snapshot),
    upsertFeedHealth: (health) => upsertFeedHealth(sql, health),
  };
  const deps = {
    birdeye: shared.birdeye,
    jupiter,
    repo,
    clock: systemClock,
    logger,
    // ADR-0011: requirements come from the strategy speed tier (T1_STANDARD until a Release binds one), never from the provider tier.
    contracts: defaultFreshnessContracts(DEFAULT_FRESHNESS_REQUIREMENTS),
    config: { trackedLimit: tier.requestsPerSecond <= 1 ? 10 : 100, lookbackBuckets: LOOKBACK_BUCKETS, discoveryIntervalMs: Math.max(300_000, intervalMs), cuBudgetPerCycle, requestBudgetPerCycle, backoffBaseMs: Math.max(intervalMs, 300_000), backoffMaxMs: 6 * 3_600_000 },
  };
  logger.info('market_ingest_starting', { tier: tier.tier, intervalMs, cuBudgetPerCycle, requestBudgetPerCycle, trackedLimit: deps.config.trackedLimit, holder: shared.holder });
  const state = initialIngestState();
  await loopUnderLease('market-ingest', intervalMs, logger, shared, async () => {
    await runMarketIngestCycle(deps, state);
  });
}

async function eligibilityLoop(env: WorkerEnv, logger: Logger, shared: SharedWithBirdeye, rpc: SolanaRpcClient, rpcUrl: string): Promise<void> {
  const intervalMs = env.ELIGIBILITY_INTERVAL_MS;
  // The one shared Jupiter quote client (ADR-0003): keyless lite host at 1 rps, keyed host faster.
  const { sql, jupiter } = shared;
  const deps = {
    rpc,
    birdeye: shared.birdeye,
    jupiter,
    repo: {
      listAssetsForEvaluation: (opts: { limit: number; reevaluateAfter: ReturnType<typeof systemClock.now>; blockedReevaluateAfter: ReturnType<typeof systemClock.now> }) => listAssetsForEvaluation(sql, opts),
      recordEligibility: (record: Parameters<typeof recordEligibility>[1], status: Parameters<typeof recordEligibility>[2]) => recordEligibility(sql, record, status),
      insertEmergencyRouteSnapshot: (snapshot: Parameters<typeof insertEmergencyRouteSnapshot>[1]) => insertEmergencyRouteSnapshot(sql, snapshot),
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_ELIGIBILITY_POLICY,
    cluster: env.SOLANA_CLUSTER,
    // Each evaluation costs 40 Birdeye CU (security 25 + overview 15) and about a dozen Jupiter quotes;
    // the ledger stops the batch when the Birdeye allowance is gone.
    config: { batchSize: 5, reevaluateAfterMs: env.ELIGIBILITY_REEVALUATE_AFTER_MS, blockedReevaluateAfterMs: env.ELIGIBILITY_BLOCKED_REEVALUATE_AFTER_MS },
    health: {
      contracts: defaultFreshnessContracts(DEFAULT_FRESHNESS_REQUIREMENTS).filter((c) => c.dataClass === 'TOKEN_SECURITY' || c.dataClass === 'TOKEN_OVERVIEW'),
      state: restoredEligibilityHealthState(await loadFeedHealth(sql, ['BIRDEYE:TOKEN_SECURITY', 'BIRDEYE:TOKEN_OVERVIEW'])),
      upsert: (h: Parameters<typeof upsertFeedHealth>[1]) => upsertFeedHealth(sql, h),
    },
  };
  logger.info('eligibility_starting', { intervalMs, batchSize: deps.config.batchSize, policyVersion: DEFAULT_ELIGIBILITY_POLICY.version, rpcOrigin: new URL(rpcUrl).origin, jupiterHost: env.JUPITER_API_KEY ? 'api.jup.ag' : 'lite-api.jup.ag', holder: shared.holder });
  await loopUnderLease('eligibility', intervalMs, logger, shared, async () => {
    await runEligibilityCycle(deps);
  });
}

async function heldAssetSafetyLoop(env: WorkerEnv, logger: Logger, shared: SharedWithBirdeye, rpc: SolanaRpcClient, rpcUrl: string): Promise<void> {
  const intervalMs = env.HELD_ASSET_SAFETY_INTERVAL_MS;
  const { sql, jupiter } = shared;
  const deps = {
    rpc,
    birdeye: shared.birdeye,
    jupiter,
    repo: {
      listOpenPositions: (limit: number) => listOpenPositions(sql, limit),
      previousSafetyBaseline: (positionId: Parameters<typeof previousSafetyBaseline>[1]) => previousSafetyBaseline(sql, positionId),
      latestEligibilityBaseline: (assetId: Parameters<typeof latestEligibilityBaseline>[1]) => latestEligibilityBaseline(sql, assetId),
      latestEmergencySnapshot: (assetId: Parameters<typeof latestEmergencySnapshot>[1]) => latestEmergencySnapshot(sql, assetId),
      recordPositionSafety: (evaluation: Parameters<typeof recordPositionSafety>[1]) => recordPositionSafety(sql, evaluation),
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_SAFETY_POLICY,
    cluster: env.SOLANA_CLUSTER,
    settlementMint: DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress,
    // Each position costs 40 Birdeye CU and one Jupiter quote per cycle; held assets are CRITICAL priority
    // in the ledger so entry-side discovery runs out of allowance before safety does.
    config: { batchSize: 50 },
  };
  logger.info('held_asset_safety_starting', { intervalMs, batchSize: deps.config.batchSize, policyVersion: DEFAULT_SAFETY_POLICY.version, rpcOrigin: new URL(rpcUrl).origin, holder: shared.holder });
  await loopUnderLease('held-asset-safety', intervalMs, logger, shared, async () => {
    await runHeldAssetSafetyCycle(deps);
  });
}

async function reconciliationLoop(env: WorkerEnv, logger: Logger, shared: Shared, rpc: SolanaRpcClient, rpcUrl: string): Promise<void> {
  const intervalMs = env.RECONCILIATION_INTERVAL_MS;
  const helius = env.HELIUS_API_KEY ? new HeliusClient({ apiKey: env.HELIUS_API_KEY, clock: systemClock }) : null;
  if (!helius) logger.warn('reconciliation_without_helius', { effect: 'any signature touching a trading wallet pauses new entries until HELIUS_API_KEY is set' });
  const { sql } = shared;
  const deps = {
    rpc,
    helius,
    repo: {
      listTradingAccounts: () => listTradingAccounts(sql),
      listCustodyAccounts: (accountId: Parameters<typeof listCustodyAccounts>[1], now: Parameters<typeof listCustodyAccounts>[2]) => listCustodyAccounts(sql, accountId, now),
      ledgerExpectations: (accountId: Parameters<typeof ledgerExpectations>[1]) => ledgerExpectations(sql, accountId),
      reconciliationCursor: (accountId: Parameters<typeof reconciliationCursor>[1]) => reconciliationCursor(sql, accountId),
      lifecycleForSignature: (signature: Parameters<typeof lifecycleForSignature>[1]) => lifecycleForSignature(sql, signature),
      recordReconciliation: (report: Parameters<typeof recordReconciliation>[1]) => recordReconciliation(sql, report),
      listOwnedAddresses: () => listOwnedAddresses(sql),
      registerOwnedAddress: (a: Parameters<typeof registerOwnedAddress>[1]) => registerOwnedAddress(sql, a),
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_RECONCILIATION_POLICY,
  };
  logger.info('reconciliation_starting', { intervalMs, policyVersion: DEFAULT_RECONCILIATION_POLICY.version, rpcOrigin: new URL(rpcUrl).origin, helius: helius !== null, holder: shared.holder });
  await loopUnderLease('reconciliation', intervalMs, logger, shared, async () => {
    await runReconciliationCycle(deps);
  });
}

async function trackedWalletsLoop(env: WorkerEnv, logger: Logger, shared: Shared, heliusKey: string): Promise<void> {
  const intervalMs = env.TRACKED_WALLETS_INTERVAL_MS;
  const helius = new HeliusClient({ apiKey: heliusKey, clock: systemClock });
  const { sql } = shared;
  const deps = {
    helius,
    repo: {
      listTrackedWallets: () => listTrackedWallets(sql),
      listOwnedAddresses: () => listOwnedAddresses(sql),
      walletCursor: (wallet: Parameters<typeof walletCursor>[1]) => walletCursor(sql, wallet),
      ingestWalletEvents: (wallet: Parameters<typeof ingestWalletEvents>[1], events: Parameters<typeof ingestWalletEvents>[2], cursor: Parameters<typeof ingestWalletEvents>[3]) => ingestWalletEvents(sql, wallet, events, cursor),
    },
    clock: systemClock,
    logger,
    config: { pageSize: 100, maxPagesPerWallet: 3 },
  };
  logger.info('tracked_wallets_starting', { intervalMs, pageSize: deps.config.pageSize, holder: shared.holder });
  await loopUnderLease('tracked-wallets', intervalMs, logger, shared, async () => {
    await runTrackedWalletsCycle(deps);
  });
}

async function featuresLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.FEATURES_INTERVAL_MS;
  const { sql } = shared;
  const deps = {
    repo: {
      listAssetsForFeatures: (limit: number) => listAssetsForFeatures(sql, limit),
      loadCandles: (assetId: Parameters<typeof loadCandles>[1], resolution: '1m', from: Parameters<typeof loadCandles>[3], to: Parameters<typeof loadCandles>[4]) => loadCandles(sql, assetId, resolution, from, to),
      latestEligibility: (assetId: Parameters<typeof latestEligibility>[1]) => latestEligibility(sql, assetId),
      latestMarketSnapshotId: (assetId: Parameters<typeof latestMarketSnapshotId>[1], asOf: Parameters<typeof latestMarketSnapshotId>[2]) => latestMarketSnapshotId(sql, assetId, asOf),
      insertFeatureSnapshot: (snapshot: Parameters<typeof insertFeatureSnapshot>[1]) => insertFeatureSnapshot(sql, snapshot),
    },
    clock: systemClock,
    logger,
    spec: FEATURE_ENGINE_V1,
    config: { batchSize: 200 },
  };
  logger.info('features_starting', { intervalMs, engine: FEATURE_ENGINE_V1.version, holder: shared.holder });
  await loopUnderLease('features', intervalMs, logger, shared, async () => {
    await runFeaturesCycle(deps);
  });
}

async function candidatesLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.CANDIDATES_INTERVAL_MS;
  const { sql } = shared;
  const deps = {
    repo: {
      listScanInputs: (limit: number) => listScanInputs(sql, limit),
      latestEligibility: (assetId: Parameters<typeof latestEligibility>[1]) => latestEligibility(sql, assetId),
      listOpenCandidates: (assetId: Parameters<typeof listOpenCandidates>[1], family: Parameters<typeof listOpenCandidates>[2]) => listOpenCandidates(sql, assetId, family),
      lastTerminalCandidateAt: (assetId: Parameters<typeof lastTerminalCandidateAt>[1], family: Parameters<typeof lastTerminalCandidateAt>[2]) => lastTerminalCandidateAt(sql, assetId, family),
      insertCandidate: (candidate: Parameters<typeof insertCandidate>[1]) => insertCandidate(sql, candidate),
      expireCandidates: (now: Parameters<typeof expireCandidates>[1]) => expireCandidates(sql, now),
      // No fills exist before the paper adapter lands; the guard still runs with an empty set.
      recentOwnFills: async () => [],
      listOwnedAddresses: () => listOwnedAddresses(sql),
      // SOL relative strength waits on a tracked SOL series (wSOL is BLOCKED by SUPPLY_ZERO today); null = no evidence either way.
      solReturn1h: async () => null,
    },
    clock: systemClock,
    logger,
    spec: FEATURE_ENGINE_V1,
    trigger: DEFAULT_MOMENTUM_TRIGGER_POLICY,
    eligibility: DEFAULT_ELIGIBILITY_POLICY,
    selfInfluence: DEFAULT_SELF_INFLUENCE_POLICY,
    config: { batchSize: 200 },
  };
  logger.info('candidates_starting', { intervalMs, trigger: DEFAULT_MOMENTUM_TRIGGER_POLICY.version, holder: shared.holder });
  await loopUnderLease('candidates', intervalMs, logger, shared, async () => {
    await runCandidatesCycle(deps);
  });
}

async function s0Loop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.S0_INTERVAL_MS;
  const { sql } = shared;
  const activeFrom = systemClock.now();
  const strategies = { RAW: s0StrategyVersion('RAW', env.GIT_SHA, activeFrom), SAFE: s0StrategyVersion('SAFE', env.GIT_SHA, activeFrom) };
  for (const v of [strategies.RAW, strategies.SAFE]) {
    const outcome = await ensureStrategyVersion(sql, v);
    logger.info('strategy_version', { versionId: v.versionId, outcome, gitSha: v.gitSha });
  }
  if (env.GIT_SHA === '0000000') logger.warn('git_sha_unknown', { hint: 'set GIT_SHA so registered strategy versions carry the build commit' });
  const deps = {
    repo: {
      listAwaiting: (versionId: Parameters<typeof listCandidatesAwaitingStrategy>[1], now: Parameters<typeof listCandidatesAwaitingStrategy>[2], limit: number) => listCandidatesAwaitingStrategy(sql, versionId, now, limit),
      persist: (candidateId: Parameters<typeof persistS0Decisions>[1], decisions: Parameters<typeof persistS0Decisions>[2], status: Parameters<typeof persistS0Decisions>[3], reason: Parameters<typeof persistS0Decisions>[4]) => persistS0Decisions(sql, candidateId, decisions, status, reason),
    },
    clock: systemClock,
    logger,
    strategies,
    gatePolicy: DEFAULT_S0_SAFETY_GATE_POLICY,
    config: { batchSize: 100 },
  };
  logger.info('s0_starting', { intervalMs, gate: DEFAULT_S0_SAFETY_GATE_POLICY.version, holder: shared.holder });
  await loopUnderLease('s0', intervalMs, logger, shared, async () => {
    await runS0Cycle(deps);
  });
}

async function paperEntryLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.PAPER_ENTRY_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('paper_entry_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const taker = env.PAPER_TRADING_WALLET;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const startingCapital = env.PAPER_STARTING_CAPITAL_BASE_UNITS;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: taker, settlementMint });
  const activeFrom = systemClock.now();
  const versions = [s0StrategyVersion('RAW', env.GIT_SHA, activeFrom), s0StrategyVersion('SAFE', env.GIT_SHA, activeFrom)];
  const strategies: Record<string, (typeof versions)[number]> = {};
  const sleeves: Record<string, Awaited<ReturnType<typeof ensureSleeve>>> = {};
  for (const v of versions) {
    await ensureStrategyVersion(sql, v);
    strategies[v.versionId] = v;
    sleeves[v.versionId] = await ensureSleeve(sql, {
      id: randomUUID() as Uuid,
      accountId: account.id,
      strategyVersionId: v.versionId,
      versionId: 'sleeve-v1' as (typeof v)['versionId'],
      settlementMint,
      capitalCapBaseUnits: mulDiv(startingCapital, 40n, 100n, 'FLOOR'),
      riskBudgetBaseUnits: mulDiv(startingCapital, 5n, 100n, 'FLOOR'),
      committedBaseUnits: '0' as typeof startingCapital,
      riskUsedBaseUnits: '0' as typeof startingCapital,
      active: true,
      createdAt: activeFrom,
    });
  }
  const adapter = new PaperExecutionAdapter({
    quotes: shared.jupiter,
    clock: systemClock,
    policy: DEFAULT_PAPER_FILL_POLICY,
    taker,
    cluster: env.SOLANA_CLUSTER,
    newId: () => randomUUID() as Uuid,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    journal: ({ order, attempt }) => journalAttempt(sql, order, attempt),
  });
  const deps = {
    repo: {
      listAwaiting: (ids: Parameters<typeof listCyclesAwaitingEntry>[1], limit: number) => listCyclesAwaitingEntry(sql, ids, limit),
      book: (now: Parameters<typeof paperBook>[4]) => paperBook(sql, account.id, settlementMint, startingCapital, now),
      health: async () => {
        const h = await entryHealth(sql);
        const gate = await sessionEntryGate(sql, account.id);
        return { ...h, sessionAllowsEntries: gate !== null && newEntriesAllowed({ activity: gate.activity, authority: gate.authority, paused: gate.paused, pausedBy: null, attended: gate.attended, liveCapabilityEnabled: false }) };
      },
      recordRiskEvaluation: (e: Parameters<typeof recordRiskEvaluation>[1]) => recordRiskEvaluation(sql, e),
      createIntent: (i: Parameters<typeof createIntent>[1], lifecycle: 'AUTHORIZED') => createIntent(sql, i, lifecycle),
      setIntentState: (id: Parameters<typeof setIntentState>[1], state: Parameters<typeof setIntentState>[2]) => setIntentState(sql, id, state),
      finishAttempt: (order: Parameters<typeof finishAttempt>[1], attempt: Parameters<typeof finishAttempt>[2], fill: Parameters<typeof finishAttempt>[3]) => finishAttempt(sql, order, attempt, fill),
      openPosition: (p: Parameters<typeof openPosition>[1], lot: Parameters<typeof openPosition>[2]) => openPosition(sql, p, lot),
      writeSnapshot: (s: Parameters<typeof insertPortfolioSnapshot>[1]) => insertPortfolioSnapshot(sql, s),
    },
    adapter,
    referenceQuote: async (inputMint: MintAddress, outputMint: MintAddress, inputAmount: typeof startingCapital, maxSlippageBps: Parameters<typeof shared.jupiter.quote>[0]['maxSlippageBps'], now: Parameters<typeof paperBook>[4]) => {
      try {
        const { quote } = await shared.jupiter.quote({ inputMint, outputMint, inputAmount, maxSlippageBps, taker, cluster: env.SOLANA_CLUSTER, requestedAt: now });
        return { impactBps: quote.priceImpactBps, expectedOutputAmount: quote.expectedOutputAmount, slippageBps: quote.slippageBps, quotedAt: quote.quotedAt };
      } catch (err) {
        if (err instanceof NoRouteError) return null;
        throw err;
      }
    },
    clock: systemClock,
    logger,
    account: { id: account.id, settlementMint, settlementDecimals: 6, startingCapital, virtualSolLamports: '1000000000' as typeof startingCapital },
    strategies,
    sleeves,
    policy: DEFAULT_RISK_POLICY,
    config: { batchSize: 20, featureMaxAgeMs: DEFAULT_S0_SAFETY_GATE_POLICY.maxFeatureAgeMs },
  };
  logger.info('paper_entry_starting', { intervalMs, accountId: account.id, strategies: Object.keys(strategies), fillModel: DEFAULT_PAPER_FILL_POLICY.version, riskPolicy: DEFAULT_RISK_POLICY.version, holder: shared.holder });
  await loopUnderLease('paper-entry', intervalMs, logger, shared, async () => {
    await runPaperEntryCycle(deps);
  });
}

async function positionMonitorLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.POSITION_MONITOR_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('position_monitor_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const taker = env.PAPER_TRADING_WALLET;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const startingCapital = env.PAPER_STARTING_CAPITAL_BASE_UNITS;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: taker, settlementMint });
  const activeFrom = systemClock.now();
  const strategies: Record<string, ReturnType<typeof s0StrategyVersion>> = {};
  for (const v of [s0StrategyVersion('RAW', env.GIT_SHA, activeFrom), s0StrategyVersion('SAFE', env.GIT_SHA, activeFrom)]) strategies[v.versionId] = v;
  const adapter = new PaperExecutionAdapter({
    quotes: shared.jupiter,
    clock: systemClock,
    policy: DEFAULT_PAPER_FILL_POLICY,
    taker,
    cluster: env.SOLANA_CLUSTER,
    newId: () => randomUUID() as Uuid,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    journal: ({ order, attempt }) => journalAttempt(sql, order, attempt),
  });
  const deps = {
    repo: {
      listOpenPositions: (limit: number) => listOpenPositionsForAccount(sql, account.id, limit),
      highSince: (assetId: Uuid, since: Parameters<typeof highSince>[2], until: Parameters<typeof highSince>[3]) => highSince(sql, assetId, since, until),
      updateMark: (positionId: Uuid, pnl: Parameters<typeof updateMark>[2], next: Parameters<typeof updateMark>[3]) => updateMark(sql, positionId, pnl, next),
      tightenStop: (positionId: Uuid, level: number) => tightenStop(sql, positionId, level),
      recordExitDecision: (c: Parameters<typeof recordExitDecision>[1], p: Parameters<typeof recordExitDecision>[2], r: Parameters<typeof recordExitDecision>[3], e: Parameters<typeof recordExitDecision>[4]) => recordExitDecision(sql, c, p, r, e),
      createIntent: (i: Parameters<typeof createIntent>[1], lifecycle: 'AUTHORIZED') => createIntent(sql, i, lifecycle),
      setIntentState: (id: Parameters<typeof setIntentState>[1], state: Parameters<typeof setIntentState>[2]) => setIntentState(sql, id, state),
      finishAttempt: (order: Parameters<typeof finishAttempt>[1], attempt: Parameters<typeof finishAttempt>[2], fill: Parameters<typeof finishAttempt>[3]) => finishAttempt(sql, order, attempt, fill),
      applyExit: (x: Parameters<typeof applyExit>[1]) => applyExit(sql, x),
      book: (now: Parameters<typeof paperBook>[4]) => paperBook(sql, account.id, settlementMint, startingCapital, now),
      writeSnapshot: (s: Parameters<typeof insertPortfolioSnapshot>[1]) => insertPortfolioSnapshot(sql, s),
      sessionActivity: async () => (await sessionEntryGate(sql, account.id))?.activity ?? null,
    },
    adapter,
    exitQuote: async (inputMint: MintAddress, outputMint: MintAddress, inputAmount: typeof startingCapital, maxSlippageBps: Parameters<typeof shared.jupiter.quote>[0]['maxSlippageBps'], now: Parameters<typeof paperBook>[4]) => {
      try {
        const { quote } = await shared.jupiter.quote({ inputMint, outputMint, inputAmount, maxSlippageBps, taker, cluster: env.SOLANA_CLUSTER, requestedAt: now });
        return { expectedOutputAmount: quote.expectedOutputAmount, impactBps: quote.priceImpactBps };
      } catch (err) {
        if (err instanceof NoRouteError) return null;
        throw err;
      }
    },
    clock: systemClock,
    logger,
    account: { id: account.id, settlementMint, settlementDecimals: 6 },
    strategies,
    policy: DEFAULT_RISK_POLICY,
    config: { batchSize: 50, reassessMs: intervalMs },
  };
  logger.info('position_monitor_starting', { intervalMs, accountId: account.id, riskPolicy: DEFAULT_RISK_POLICY.version, holder: shared.holder });
  await loopUnderLease('position-monitor', intervalMs, logger, shared, async () => {
    await runPositionMonitorCycle(deps);
  });
}

async function sessionLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.SESSION_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('session_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: env.PAPER_TRADING_WALLET, settlementMint });
  const attended = env.DEPLOYMENT_PROFILE === 'P1A' || env.DEPLOYMENT_PROFILE === 'P2';
  const deps = {
    repo: {
      findOpenSession: (accountId: Uuid) => findOpenSession(sql, accountId),
      createSession: async (input: { accountId: Uuid; profile: Parameters<typeof createRuntimeSession>[1]['profile']; attended: boolean; capitalAuthority: Parameters<typeof createRuntimeSession>[1]['capitalAuthority'] }) => (await createRuntimeSession(sql, input)) as Uuid,
      loadSession: (id: Uuid) => loadSession(sql, id),
      persistTransition: async (t: Parameters<typeof persistRuntimeTransition>[1]) => {
        await persistRuntimeTransition(sql, t);
      },
      saveColdStartGates: (id: Uuid, gates: Parameters<typeof saveColdStartGates>[2]) => saveColdStartGates(sql, id, gates),
      coldStartFacts: (now: Parameters<typeof coldStartFacts>[1]) => coldStartFacts(sql, now, { requiredFeatures: FEATURE_ENGINE_V1.requiredForScoring, featureWindowMs: DEFAULT_SESSION_POLICY.safetyMaxAgeMs, safetyMaxAgeMs: DEFAULT_SESSION_POLICY.safetyMaxAgeMs }),
      windDownFacts: (accountId: Uuid) => windDownFacts(sql, accountId),
      listPendingControlRequests: (kinds: Parameters<typeof listPendingControlRequests>[1], limit: number) => listPendingControlRequests(sql, kinds, limit),
      stepUpVerifiedFor: (id: Uuid, now: Parameters<typeof stepUpVerifiedFor>[2]) => stepUpVerifiedFor(sql, id, now),
      resolveControlRequest: (id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Parameters<typeof resolveControlRequest>[4]) => resolveControlRequest(sql, id, state, resolution, at),
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_SESSION_POLICY,
    account: { id: account.id },
    profile: env.DEPLOYMENT_PROFILE,
    attended,
    authority: 'PAPER' as const,
    autoStart: env.SESSION_AUTOSTART === 'true',
  };
  logger.info('session_starting', { intervalMs, accountId: account.id, profile: env.DEPLOYMENT_PROFILE, attended, autoStart: deps.autoStart, policy: DEFAULT_SESSION_POLICY.version, holder: shared.holder });
  await loopUnderLease('session', intervalMs, logger, shared, async () => {
    await runSessionCycle(deps);
  });
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
