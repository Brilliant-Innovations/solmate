import { DEFAULT_ELIGIBILITY_POLICY, DEFAULT_RECONCILIATION_POLICY, DEFAULT_SAFETY_POLICY, getContractSetDigest, parseWorkerEnv, systemClock, type CandleResolution, type MintAddress } from '@sol-agent-trader/contracts';
import {
  createSql,
  heldBucketTimes,
  insertEmergencyRouteSnapshot,
  insertSnapshot,
  latestEligibilityBaseline,
  latestEmergencySnapshot,
  LeaseManager,
  ledgerExpectations,
  chargeProviderSpend,
  ingestWalletEvents,
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
import { JupiterSwapClient } from '@sol-agent-trader/execution';
import { BIRDEYE_TIERS, BirdeyeClient, ComputeUnitLedger, defaultFreshnessContracts, fetchTransport, JupiterPriceClient } from '@sol-agent-trader/market';
import { redact, type Logger } from '@sol-agent-trader/observability';
import { HeliusClient } from '@sol-agent-trader/onchain';
import { initTelemetry } from '@sol-agent-trader/observability/server';
import { SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import { initialEligibilityHealthState, runEligibilityCycle } from './roles/eligibility.js';
import { runHeldAssetSafetyCycle } from './roles/held-asset-safety.js';
import { runReconciliationCycle } from './roles/reconciliation.js';
import { runTrackedWalletsCycle } from './roles/tracked-wallets.js';
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
  const wanted = [...roles].filter((r) => r === 'market-ingest' || r === 'eligibility' || r === 'held-asset-safety' || r === 'reconciliation' || r === 'tracked-wallets');
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
    contracts: defaultFreshnessContracts(tier),
    config: { trackedLimit: tier.requestsPerSecond <= 1 ? 10 : 100, lookbackBuckets: LOOKBACK_BUCKETS, discoveryIntervalMs: Math.max(300_000, intervalMs), cuBudgetPerCycle, requestBudgetPerCycle },
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
    config: { batchSize: 5, reevaluateAfterMs: 6 * 3_600_000, blockedReevaluateAfterMs: 24 * 3_600_000 },
    health: {
      contracts: defaultFreshnessContracts(BIRDEYE_TIERS[env.BIRDEYE_TIER]).filter((c) => c.dataClass === 'TOKEN_SECURITY' || c.dataClass === 'TOKEN_OVERVIEW'),
      state: initialEligibilityHealthState(),
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

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
