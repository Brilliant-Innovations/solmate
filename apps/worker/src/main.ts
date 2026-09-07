import { getContractSetDigest, parseWorkerEnv, systemClock, type CandleResolution } from '@sol-agent-trader/contracts';
import { createSql, heldBucketTimes, insertSnapshot, LeaseManager, listTrackedAssets, loadCandles, runWithLease, upsertDiscoveredAssets, upsertFeedHealth, writeCandles } from '@sol-agent-trader/db/server';
import { BIRDEYE_TIERS, BirdeyeClient, defaultFreshnessContracts, fetchTransport, JupiterPriceClient } from '@sol-agent-trader/market';
import { redact } from '@sol-agent-trader/observability';
import { initTelemetry } from '@sol-agent-trader/observability/server';
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
 * Roles (WORKER_ROLES): `market-ingest` (M4) runs under the ops.worker_leases lease of the same
 * name so two workers never ingest the same universe twice; it needs BIRDEYE_API_KEY.
 */
const SERVICE = 'worker' as const;

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

  let env: ReturnType<typeof parseWorkerEnv>;
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
  if (roles.has('market-ingest')) {
    if (!env.BIRDEYE_API_KEY) {
      logger.warn('market_ingest_disabled', { reason: 'BIRDEYE_API_KEY not set; market feeds will report FAILED' });
    } else {
      await runMarketIngestRole(env, logger);
    }
  }
  await telemetry.shutdown();
}

async function runMarketIngestRole(env: ReturnType<typeof parseWorkerEnv>, logger: ReturnType<typeof initTelemetry>['logger']): Promise<void> {
  const tier = BIRDEYE_TIERS[env.BIRDEYE_TIER];
  const intervalMs = env.MARKET_INGEST_INTERVAL_MS;
  const cyclesPerMonth = (30 * 86_400_000) / intervalMs;
  // Smoothing only: the client's compute-unit ledger is the hard monthly cap.
  const cuBudgetPerCycle = Math.max(100, Math.floor(((tier.computeUnitsPerMonth ?? 0) * 0.9) / cyclesPerMonth));
  const requestBudgetPerCycle = Math.max(3, Math.floor(tier.requestsPerSecond * (intervalMs / 1000) * 0.5));
  const holder = env.SERVICE_INSTANCE_ID ?? `worker-${process.pid}`;

  const sql = createSql({ url: env.SUPABASE_DB_URL, applicationName: 'worker:market-ingest' });
  const birdeye = new BirdeyeClient({ apiKey: env.BIRDEYE_API_KEY as string, tier, transport: fetchTransport, clock: systemClock });
  const jupiter = new JupiterPriceClient({ transport: fetchTransport, clock: systemClock, apiKey: env.JUPITER_API_KEY, requestsPerSecond: env.JUPITER_API_KEY ? 10 : 1 });
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
    birdeye,
    jupiter,
    repo,
    clock: systemClock,
    logger,
    contracts: defaultFreshnessContracts(tier),
    config: { trackedLimit: tier.requestsPerSecond <= 1 ? 10 : 100, lookbackBuckets: LOOKBACK_BUCKETS, discoveryIntervalMs: Math.max(300_000, intervalMs), cuBudgetPerCycle, requestBudgetPerCycle },
  };
  logger.info('market_ingest_starting', { tier: tier.tier, intervalMs, cuBudgetPerCycle, requestBudgetPerCycle, trackedLimit: deps.config.trackedLimit, holder });

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const leases = new LeaseManager(sql, holder);
  const state = initialIngestState();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const ran = await runWithLease(leases, { role: 'market-ingest', ttlSeconds: 90, heartbeatIntervalMs: 30_000 }, async (isFenced) => {
    while (!stopping && !isFenced()) {
      const started = systemClock.nowMs();
      try {
        await runMarketIngestCycle(deps, state);
      } catch (err) {
        logger.error('market_ingest_cycle_failed', { error: err instanceof Error ? err.message : String(err) });
      }
      // Sleep the remainder of the interval in short slices so stop and fencing are honoured promptly.
      const deadline = started + intervalMs;
      while (!stopping && !isFenced() && systemClock.nowMs() < deadline) await sleep(Math.min(5_000, deadline - systemClock.nowMs()));
    }
    logger.info('market_ingest_stopped', { stopping, fenced: isFenced() });
  });
  if (!ran) logger.warn('market_ingest_lease_unavailable', { holder });
  await sql.end({ timeout: 5 });
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
