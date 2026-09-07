import { DEFAULT_ELIGIBILITY_POLICY, getContractSetDigest, parseWorkerEnv, systemClock, type CandleResolution } from '@sol-agent-trader/contracts';
import {
  createSql,
  heldBucketTimes,
  insertEmergencyRouteSnapshot,
  insertSnapshot,
  LeaseManager,
  listAssetsForEvaluation,
  listTrackedAssets,
  loadCandles,
  recordEligibility,
  runWithLease,
  upsertDiscoveredAssets,
  upsertFeedHealth,
  writeCandles,
  type Sql,
} from '@sol-agent-trader/db/server';
import { JupiterSwapClient } from '@sol-agent-trader/execution';
import { BIRDEYE_TIERS, BirdeyeClient, defaultFreshnessContracts, fetchTransport, JupiterPriceClient } from '@sol-agent-trader/market';
import { redact, type Logger } from '@sol-agent-trader/observability';
import { initTelemetry } from '@sol-agent-trader/observability/server';
import { SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import { runEligibilityCycle } from './roles/eligibility.js';
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
  const wanted = [...roles].filter((r) => r === 'market-ingest' || r === 'eligibility');
  if (wanted.length > 0) await runRoles(env, logger, new Set(wanted));
  await telemetry.shutdown();
}

interface Shared {
  sql: Sql;
  birdeye: BirdeyeClient;
  leases: LeaseManager;
  holder: string;
  stopping: () => boolean;
}

async function runRoles(env: WorkerEnv, logger: Logger, roles: Set<string>): Promise<void> {
  if (!env.BIRDEYE_API_KEY) {
    logger.warn('roles_disabled', { roles: [...roles], reason: 'BIRDEYE_API_KEY not set; market feeds will report FAILED' });
    return;
  }
  const tier = BIRDEYE_TIERS[env.BIRDEYE_TIER];
  const holder = env.SERVICE_INSTANCE_ID ?? `worker-${process.pid}`;
  const sql = createSql({ url: env.SUPABASE_DB_URL, applicationName: 'worker' });
  const birdeye = new BirdeyeClient({ apiKey: env.BIRDEYE_API_KEY, tier, transport: fetchTransport, clock: systemClock });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const shared: Shared = { sql, birdeye, leases: new LeaseManager(sql, holder), holder, stopping: () => stopping };

  const loops: Promise<void>[] = [];
  if (roles.has('market-ingest')) loops.push(marketIngestLoop(env, logger, shared, tier));
  if (roles.has('eligibility')) {
    if (!env.SOLANA_RPC_URL) logger.warn('roles_disabled', { roles: ['eligibility'], reason: 'SOLANA_RPC_URL not set' });
    else loops.push(eligibilityLoop(env, logger, shared, env.SOLANA_RPC_URL));
  }
  await Promise.all(loops);
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

async function marketIngestLoop(env: WorkerEnv, logger: Logger, shared: Shared, tier: (typeof BIRDEYE_TIERS)[keyof typeof BIRDEYE_TIERS]): Promise<void> {
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

async function eligibilityLoop(env: WorkerEnv, logger: Logger, shared: Shared, rpcUrl: string): Promise<void> {
  const intervalMs = env.ELIGIBILITY_INTERVAL_MS;
  const rpc = new SolanaRpcClient({ url: rpcUrl, allowedOrigins: [new URL(rpcUrl).origin] });
  // The one shared Jupiter quote client (ADR-0003): keyless lite host at 1 rps, keyed host faster.
  const jupiter = new JupiterSwapClient({ clock: systemClock, apiKey: env.JUPITER_API_KEY, requestsPerSecond: env.JUPITER_REQUESTS_PER_SECOND });
  const { sql } = shared;
  const deps = {
    rpc,
    birdeye: shared.birdeye,
    jupiter,
    repo: {
      listAssetsForEvaluation: (opts: { limit: number; reevaluateAfter: ReturnType<typeof systemClock.now> }) => listAssetsForEvaluation(sql, opts),
      recordEligibility: (record: Parameters<typeof recordEligibility>[1], status: Parameters<typeof recordEligibility>[2]) => recordEligibility(sql, record, status),
      insertEmergencyRouteSnapshot: (snapshot: Parameters<typeof insertEmergencyRouteSnapshot>[1]) => insertEmergencyRouteSnapshot(sql, snapshot),
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_ELIGIBILITY_POLICY,
    cluster: env.SOLANA_CLUSTER,
    // Each evaluation costs 40 Birdeye CU (security 25 + overview 15) and about a dozen Jupiter quotes;
    // the ledger stops the batch when the Birdeye allowance is gone.
    config: { batchSize: 5, reevaluateAfterMs: 6 * 3_600_000 },
  };
  logger.info('eligibility_starting', { intervalMs, batchSize: deps.config.batchSize, policyVersion: DEFAULT_ELIGIBILITY_POLICY.version, rpcOrigin: new URL(rpcUrl).origin, jupiterHost: env.JUPITER_API_KEY ? 'api.jup.ag' : 'lite-api.jup.ag', holder: shared.holder });
  await loopUnderLease('eligibility', intervalMs, logger, shared, async () => {
    await runEligibilityCycle(deps);
  });
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
