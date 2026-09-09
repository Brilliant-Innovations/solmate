import { randomUUID } from 'node:crypto';
import {
  compareInstants,
  type DataClass,
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
  listTrackedAssets(limit: number): Promise<{ id: Uuid; mintAddress: string; priority?: 'POSITION' | 'WATCH' }[]>;
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
    /** Backoff for assets whose candle fetch adds nothing: base doubles per consecutive empty fetch up to the cap. */
    backoffBaseMs: number;
    backoffMaxMs: number;
    /**
     * Consecutive empty fetches after which an asset stops being requested at all this process.
     *
     * Backoff alone decays to a fixed retry and never stops: at the 6-hour cap a dead token still
     * costs four requests a day, forever, and 78% of measured OHLCV spend was requests that wrote
     * nothing. Eviction is the stop. It is deliberately in-process — eligibility re-promoting an asset
     * is what brings it back, and a restart re-tests everything once, which is cheap and self-healing.
     */
    evictAfterEmptyFetches: number;
  };
}

/** Published by the eligibility role from its own calls, never by ingestion. */
export const ELIGIBILITY_CLASSES: ReadonlySet<DataClass> = new Set<DataClass>(['TOKEN_SECURITY', 'TOKEN_OVERVIEW']);
/** Marker for a feed nothing in this deployment consumes yet (no positions, no candidates, no role). */
export const NO_DEMAND = 'NO_DEMAND: nothing in this deployment consumes this class yet';

export interface IngestState {
  lastDiscoveryAt: Instant | null;
  /** Assets whose last candle fetch wrote nothing new: exponential backoff so a dead token cannot monopolise the budget (review 2026-09-08). */
  candleBackoff: Record<string, { failures: number; until: Instant }>;
  lastSuccess: Partial<Record<string, Instant>>;
  lastError: Partial<Record<string, string>>;
  lastLatencyMs: Partial<Record<string, number>>;
}

export function initialIngestState(): IngestState {
  return { lastDiscoveryAt: null, candleBackoff: {}, lastSuccess: {}, lastError: {}, lastLatencyMs: {} };
}

export interface CycleReport {
  actions: number;
  deferred: number;
  candlesWritten: number;
  candlesRejected: number;
  /** Candle refreshes skipped this cycle because the asset is backed off. */
  candlesBackedOff: number;
  /** Assets dropped from tracking this cycle: repeated empty fetches (WP1b). */
  candlesEvicted: number;
  assetsDiscovered: number;
  snapshots: number;
  quotes: number;
  errors: { action: string; error: string }[];
  health: FeedHealth[];
}

const RESOLUTIONS: Readonly<Record<TrackedAsset['priority'], readonly CandleResolution[]>> = { POSITION: ['1m', '15s'], CANDIDATE: ['1m'], WATCH: ['1m'] };

/**
 * The newest 1m bucket held anywhere in the tracked set, or null when we hold none (DEFECT-4).
 *
 * Deliberately the newest across the set rather than the oldest: this answers "has the candle feed
 * stopped", which is the failure that has now occurred twice, and it cannot be masked by one dead
 * asset the way an oldest-of would trip on one. It equally cannot detect a single stale asset among
 * fresh ones — that needs a per-asset gate at the candidate, which is named as an open gap.
 */
function newerOf(a: Instant | null, b: Instant | null): Instant | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareInstants(a, b) >= 0 ? a : b;
}

function newestCandleHeld(tracked: readonly TrackedAsset[]): Instant | null {
  let newest: Instant | null = null;
  for (const t of tracked) {
    for (const bucket of t.held['1m'] ?? []) {
      if (newest === null || compareInstants(bucket, newest) > 0) newest = bucket;
    }
  }
  return newest;
}

export async function runMarketIngestCycle(deps: MarketIngestDeps, state: IngestState): Promise<CycleReport> {
  const now = deps.clock.now();
  const report: CycleReport = { actions: 0, deferred: 0, candlesWritten: 0, candlesRejected: 0, candlesBackedOff: 0, candlesEvicted: 0, assetsDiscovered: 0, snapshots: 0, quotes: 0, errors: [], health: [] };
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
    // Evicted: repeated empty fetches mean this asset has no candles to give (dead or delisted), and
    // a held position is never evicted however quiet it is.
    const failures = state.candleBackoff[a.id]?.failures ?? 0;
    if (a.priority !== 'POSITION' && failures >= deps.config.evictAfterEmptyFetches) {
      report.candlesEvicted++;
      continue;
    }
    tracked.push({ assetId: a.id, mintAddress: a.mintAddress, priority: a.priority ?? 'WATCH', held, candleBackoffUntil: state.candleBackoff[a.id]?.until ?? null });
  }

  const discoveryDue = state.lastDiscoveryAt === null || Date.parse(now) - Date.parse(state.lastDiscoveryAt) >= deps.config.discoveryIntervalMs;
  const plan = planIngestCycle({ now, tracked, resolutions: RESOLUTIONS, lookbackBuckets: deps.config.lookbackBuckets, discoveryDue, cuBudget: deps.config.cuBudgetPerCycle, requestBudget: deps.config.requestBudgetPerCycle });
  report.actions = plan.actions.length;
  report.deferred = plan.deferred;
  report.candlesBackedOff = plan.backedOff;

  // 2. Execute in plan order.
  const discovered: DiscoveredToken[][] = [];
  const quotes: PriceQuote[] = [];
  const touchedAssets = new Set<Uuid>();
  // DEFECT-4: health is published at the end of the cycle, so it must account for what this cycle
  // just wrote; `tracked[].held` was read before the fetch and would report one cycle stale.
  let newestWritten: Instant | null = null;
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
        for (const c of res.candles) if (newestWritten === null || compareInstants(c.bucketTime, newestWritten) > 0) newestWritten = c.bucketTime;
        // A fetch that adds nothing new means the provider has no more for this gap: back the asset off (doubling, capped) so the budget rotates to assets that still move.
        if (w.inserted + w.replacedOpen === 0) {
          const failures = (state.candleBackoff[action.assetId]?.failures ?? 0) + 1;
          state.candleBackoff[action.assetId] = { failures, until: addMs(now, Math.min(deps.config.backoffBaseMs * 2 ** (failures - 1), deps.config.backoffMaxMs)) };
        } else {
          delete state.candleBackoff[action.assetId];
        }
        // Health means usable data arrived: a 200 whose every candle was rejected is a failure.
        if (res.candles.length > 0) ok('CANDLES', res.meta.latencyMs);
        else fail('CANDLES', 'CANDLES', new Error(`no accepted candles (${res.rejected.length} rejected)`));
        return;
      }
      case 'PRICES': {
        const res = await deps.birdeye.prices(action.mints, action.priority);
        quotes.push(...res.quotes);
        report.quotes += res.quotes.length;
        if (res.quotes.length > 0) ok(action.priority === 'CRITICAL' ? 'ACTIVE_POSITION_PRICE' : 'CANDIDATE_PRICE', res.meta.latencyMs);
        else fail(action.priority === 'CRITICAL' ? 'ACTIVE_POSITION_PRICE' : 'CANDIDATE_PRICE', 'PRICES', new Error('no usable prices returned'));
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

  // 5. Publish health. Classes another role serves (security, overview: the eligibility role) are
  //    not this role's to report. A class nothing in this deployment consumes yet is still FAILED
  //    (never fetched is never "healthy") but carries no effect, so an empty position book cannot
  //    block entries through a price feed nobody asked for.
  const rateLimitState = deps.birdeye.ledger.snapshot().remaining === 0 ? 'EXHAUSTED' : 'OK';
  const demand: Partial<Record<DataClass, boolean>> = {
    ACTIVE_POSITION_PRICE: tracked.some((t) => t.priority === 'POSITION'),
    CANDIDATE_PRICE: tracked.some((t) => t.priority === 'CANDIDATE'),
    CANDLES: tracked.length > 0,
    DISCOVERY_LIST: true,
  };
  for (const c of deps.contracts) {
    if (ELIGIBILITY_CLASSES.has(c.dataClass)) continue;
    const cls = c.provider === 'JUPITER_PRICE_V3' ? `JUPITER:${c.dataClass}` : c.dataClass;
    const health = evaluateFreshness(c, {
      lastSuccessAt: state.lastSuccess[cls] ?? null,
      now: deps.clock.now(),
      latencyMs: state.lastLatencyMs[cls] ?? null,
      rateLimitState: c.provider === 'BIRDEYE' ? rateLimitState : null,
      lastError: state.lastError[cls] ?? null,
      // DEFECT-4: candles are backed by a store, so their age is the newest bucket we hold, not the
      // recency of our last call. `tracked[].held` already carries it; nothing had ever read it here.
      //
      // Its honest limit: `ops.provider_health` is one row per (provider, class), so it can only say
      // whether the feed as a whole has stopped — which is the failure that actually happened, twice.
      // It cannot say that one asset among many is stale. A per-asset check belongs at the candidate
      // gate and does not exist yet; see the WP1 report.
      ...(c.dataClass === 'CANDLES' ? { newestDatumAt: newerOf(newestCandleHeld(tracked), newestWritten) } : {}),
    });
    if (!(demand[c.dataClass] ?? false)) {
      health.effectOnEntries = 'NONE';
      health.effectOnExits = 'NONE';
      health.lastError = health.lastError ?? NO_DEMAND;
    }
    await deps.repo.upsertFeedHealth(health);
    report.health.push(health);
  }
  deps.logger.info('market_ingest_cycle', { actions: report.actions, deferred: report.deferred, candlesWritten: report.candlesWritten, candlesRejected: report.candlesRejected, candlesBackedOff: report.candlesBackedOff, backedOffAssets: Object.keys(state.candleBackoff).length, candlesEvicted: report.candlesEvicted, tracked: tracked.length, assetsDiscovered: report.assetsDiscovered, snapshots: report.snapshots, quotes: report.quotes, errors: report.errors.length, cu: deps.birdeye.ledger.snapshot().used });
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
