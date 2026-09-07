import { randomUUID } from 'node:crypto';
import {
  addMs,
  type CandleResolution,
  type Clock,
  type DiscoveredToken,
  type FeedHealth,
  type FreshnessContract,
  type Instant,
  type PriceQuote,
  type Uuid,
} from '@sol-agent-trader/contracts';
import type { Logger } from '@sol-agent-trader/observability';
import {
  BudgetExhaustedError,
  buildMarketSnapshot,
  evaluateFreshness,
  healthKey,
  lastClosedBucket,
  mergeDiscovery,
  planIngestCycle,
  RESOLUTION_MS,
  snapshotAsOf,
  type BirdeyeClient,
  type IngestAction,
  type JupiterPriceClient,
  type TrackedAsset,
} from '@sol-agent-trader/market';

/**
 * Worker role `market-ingest` (blueprint §5.4, §6.4, §6.5, §7.1, §21.1; execution plan M4).
 * One cycle: plan from what the database holds, execute the plan against Birdeye (and Jupiter for
 * the secondary price), persist candles/assets/snapshots, and publish feed health. Every provider
 * failure lands in ops.provider_health; nothing here retries beyond the client's bounded policy.
 * Depends on ports so it runs against fakes in tests and against the real stack in production.
 */

export interface MarketRepo {
  listTrackedAssets(limit: number): Promise<{ id: Uuid; mintAddress: string }[]>;
  heldBucketTimes(assetId: Uuid, resolution: CandleResolution, from: Instant, to: Instant): Promise<Instant[]>;
  writeCandles(candles: Parameters<typeof buildMarketSnapshot>[0]['candles1m']): Promise<{ inserted: number; replacedOpen: number; ignored: number }>;
  loadCandles(assetId: Uuid, resolution: CandleResolution, from: Instant, to: Instant): Promise<Parameters<typeof buildMarketSnapshot>[0]['candles1m']>;
  upsertDiscoveredAssets(tokens: readonly DiscoveredToken[], now: Instant): Promise<{ id: Uuid; mintAddress: string }[]>;
  insertSnapshot(snapshot: ReturnType<typeof buildMarketSnapshot>): Promise<void>;
  upsertFeedHealth(health: FeedHealth): Promise<void>;
}

export interface MarketIngestDeps {
  birdeye: BirdeyeClient;
  jupiter: JupiterPriceClient | null;
  repo: MarketRepo;
  clock: Clock;
  logger: Logger;
  contracts: readonly FreshnessContract[];
  /** Tracked-asset cap and continuity lookbacks for this deployment. */
  config: {
    trackedLimit: number;
    lookbackBuckets: Readonly<Record<CandleResolution, number>>;
    discoveryIntervalMs: number;
    /** Compute units this cycle may spend on NORMAL work. */
    cuBudgetPerCycle: number;
    requestBudgetPerCycle: number;
  };
}

export interface IngestState {
  lastDiscoveryAt: Instant | null;
  lastSuccess: Partial<Record<string, Instant>>;
  lastError: Partial<Record<string, string>>;
  lastLatencyMs: Partial<Record<string, number>>;
}

export function initialIngestState(): IngestState {
  return { lastDiscoveryAt: null, lastSuccess: {}, lastError: {}, lastLatencyMs: {} };
}

export interface CycleReport {
  actions: number;
  deferred: number;
  candlesWritten: number;
  candlesRejected: number;
  assetsDiscovered: number;
  snapshots: number;
  quotes: number;
  errors: { action: string; error: string }[];
  health: FeedHealth[];
}

const RESOLUTIONS: Readonly<Record<TrackedAsset['priority'], readonly CandleResolution[]>> = { POSITION: ['1m', '15s'], CANDIDATE: ['1m'], WATCH: ['1m'] };

export async function runMarketIngestCycle(deps: MarketIngestDeps, state: IngestState): Promise<CycleReport> {
  const now = deps.clock.now();
  const report: CycleReport = { actions: 0, deferred: 0, candlesWritten: 0, candlesRejected: 0, assetsDiscovered: 0, snapshots: 0, quotes: 0, errors: [], health: [] };
  const ok = (cls: string, latencyMs: number) => {
    state.lastSuccess[cls] = deps.clock.now();
    state.lastLatencyMs[cls] = latencyMs;
    delete state.lastError[cls];
  };
  const fail = (cls: string, action: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError[cls] = msg.slice(0, 512);
    report.errors.push({ action, error: msg });
    deps.logger.warn('market_ingest_action_failed', { action, error: msg });
  };

  // 1. What do we track, and what do we already hold?
  const assets = await deps.repo.listTrackedAssets(deps.config.trackedLimit);
  const tracked: TrackedAsset[] = [];
  for (const a of assets) {
    const held: TrackedAsset['held'] = {};
    for (const res of RESOLUTIONS.WATCH) {
      const to = lastClosedBucket(now, res);
      const from = addMs(to, -(deps.config.lookbackBuckets[res] - 1) * RESOLUTION_MS[res]);
      held[res] = await deps.repo.heldBucketTimes(a.id, res, from, to);
    }
    tracked.push({ assetId: a.id, mintAddress: a.mintAddress, priority: 'WATCH', held });
  }

  const discoveryDue = state.lastDiscoveryAt === null || Date.parse(now) - Date.parse(state.lastDiscoveryAt) >= deps.config.discoveryIntervalMs;
  const plan = planIngestCycle({ now, tracked, resolutions: RESOLUTIONS, lookbackBuckets: deps.config.lookbackBuckets, discoveryDue, cuBudget: deps.config.cuBudgetPerCycle, requestBudget: deps.config.requestBudgetPerCycle });
  report.actions = plan.actions.length;
  report.deferred = plan.deferred;

  // 2. Execute in plan order.
  const discovered: DiscoveredToken[][] = [];
  const quotes: PriceQuote[] = [];
  const touchedAssets = new Set<Uuid>();
  for (const action of plan.actions) {
    try {
      await executeAction(action);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        fail('CANDLES', action.kind, err);
        break;
      }
      fail(classOf(action), action.kind, err);
    }
  }

  async function executeAction(action: IngestAction): Promise<void> {
    switch (action.kind) {
      case 'CANDLES': {
        const res = await deps.birdeye.candles({ assetId: action.assetId, mintAddress: action.mintAddress, resolution: action.request.resolution, from: action.request.from, to: action.request.to, provenance: action.provenance, priority: action.priority === 'POSITION' ? 'CRITICAL' : 'NORMAL' });
        const w = await deps.repo.writeCandles(res.candles);
        report.candlesWritten += w.inserted + w.replacedOpen;
        report.candlesRejected += res.rejected.length;
        touchedAssets.add(action.assetId);
        ok('CANDLES', res.meta.latencyMs);
        return;
      }
      case 'PRICES': {
        const res = await deps.birdeye.prices(action.mints, action.priority);
        quotes.push(...res.quotes);
        report.quotes += res.quotes.length;
        ok(action.priority === 'CRITICAL' ? 'ACTIVE_POSITION_PRICE' : 'CANDIDATE_PRICE', res.meta.latencyMs);
        if (deps.jupiter && action.priority === 'CRITICAL') {
          try {
            const j = await deps.jupiter.prices(action.mints.slice(0, 50));
            quotes.push(...j.quotes);
            state.lastSuccess['JUPITER:ACTIVE_POSITION_PRICE'] = deps.clock.now();
            state.lastLatencyMs['JUPITER:ACTIVE_POSITION_PRICE'] = j.latencyMs;
          } catch (err) {
            fail('JUPITER:ACTIVE_POSITION_PRICE', 'JUPITER_PRICES', err);
          }
        }
        return;
      }
      case 'DISCOVERY_TRENDING': {
        const res = await deps.birdeye.trending({ limit: 50 });
        discovered.push(res.tokens);
        ok('DISCOVERY_LIST', res.meta.latencyMs);
        return;
      }
      case 'DISCOVERY_NEW_LISTINGS': {
        const res = await deps.birdeye.newListings({ limit: 20 });
        discovered.push(res.tokens);
        ok('DISCOVERY_LIST', res.meta.latencyMs);
        return;
      }
    }
  }

  // 3. Persist discovery (identity by mint, first-seen preserved by the repository).
  if (discovered.length > 0) {
    const merged = mergeDiscovery(discovered);
    const upserted = await deps.repo.upsertDiscoveredAssets(merged, now);
    report.assetsDiscovered = upserted.length;
    state.lastDiscoveryAt = now;
  }

  // 4. Snapshot every asset whose candles moved this cycle (§6.5 "persisted whenever scored"; here: whenever refreshed).
  for (const assetId of touchedAssets) {
    const asOf = snapshotAsOf(now);
    const from = addMs(asOf, -300 * RESOLUTION_MS['1m']);
    const candles1m = await deps.repo.loadCandles(assetId, '1m', from, asOf);
    const snapshot = buildMarketSnapshot({ id: randomUUID() as Uuid, assetId, asOf, observedAt: deps.clock.now(), provenance: 'LIVE', overview: null, candles1m });
    await deps.repo.insertSnapshot(snapshot);
    report.snapshots++;
  }

  // 5. Publish health for every contract from what this and earlier cycles observed.
  const rateLimitState = deps.birdeye.ledger.snapshot().remaining === 0 ? 'EXHAUSTED' : 'OK';
  for (const c of deps.contracts) {
    const cls = c.provider === 'JUPITER_PRICE_V3' ? `JUPITER:${c.dataClass}` : c.dataClass;
    const health = evaluateFreshness(c, {
      lastSuccessAt: state.lastSuccess[cls] ?? null,
      now: deps.clock.now(),
      latencyMs: state.lastLatencyMs[cls] ?? null,
      rateLimitState: c.provider === 'BIRDEYE' ? rateLimitState : null,
      lastError: state.lastError[cls] ?? null,
    });
    await deps.repo.upsertFeedHealth(health);
    report.health.push(health);
  }
  deps.logger.info('market_ingest_cycle', { actions: report.actions, deferred: report.deferred, candlesWritten: report.candlesWritten, candlesRejected: report.candlesRejected, assetsDiscovered: report.assetsDiscovered, snapshots: report.snapshots, quotes: report.quotes, errors: report.errors.length, cu: deps.birdeye.ledger.snapshot().used });
  return report;
}

function classOf(action: IngestAction): string {
  switch (action.kind) {
    case 'CANDLES':
      return 'CANDLES';
    case 'PRICES':
      return action.priority === 'CRITICAL' ? 'ACTIVE_POSITION_PRICE' : 'CANDIDATE_PRICE';
    default:
      return 'DISCOVERY_LIST';
  }
}

export { healthKey };
