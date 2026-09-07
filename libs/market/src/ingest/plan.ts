import { addMs, instantToMs, type CandleResolution, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import { lastClosedBucket, RESOLUTION_MS } from '../candles/resolution.js';
import { findCandleGaps, planBackfill, type BackfillRequest } from '../candles/gaps.js';
import { BIRDEYE_CU, BIRDEYE_ENDPOINT_LIMITS } from '../birdeye/tiers.js';

/**
 * One ingestion cycle as a plan (pure), executed by the worker. Priorities follow the risk order
 * of §5.4: assets with open positions first, then candidates, then the watch list, then discovery.
 * The plan is cut to the compute-unit and request budget available for this cycle, so a large
 * discovery universe can only ever starve itself, never the positions' price feed.
 */

export type TrackPriority = 'POSITION' | 'CANDIDATE' | 'WATCH';
const PRIORITY_RANK: Readonly<Record<TrackPriority, number>> = { POSITION: 0, CANDIDATE: 1, WATCH: 2 };

export interface TrackedAsset {
  assetId: Uuid;
  mintAddress: string;
  priority: TrackPriority;
  /** Bucket times we already hold per resolution within the lookback window. */
  held: Partial<Record<CandleResolution, readonly Instant[]>>;
  /** No candle request for this asset before this instant: its last fetch added nothing (a dead or delisted token). */
  candleBackoffUntil?: Instant | null;
}

export type IngestAction =
  | { kind: 'CANDLES'; assetId: Uuid; mintAddress: string; priority: TrackPriority; request: BackfillRequest; provenance: 'LIVE' | 'BACKFILL'; cu: number }
  | { kind: 'PRICES'; mints: string[]; priority: 'CRITICAL' | 'NORMAL'; cu: number }
  | { kind: 'DISCOVERY_TRENDING'; cu: number }
  | { kind: 'DISCOVERY_NEW_LISTINGS'; cu: number };

export interface IngestPlanInput {
  now: Instant;
  tracked: readonly TrackedAsset[];
  /** Resolutions to keep continuous per priority. */
  resolutions: Readonly<Record<TrackPriority, readonly CandleResolution[]>>;
  /** How far back to keep each resolution continuous (warm-up, D63). */
  lookbackBuckets: Readonly<Record<CandleResolution, number>>;
  /** Whether discovery is due this cycle. */
  discoveryDue: boolean;
  /** Compute units this cycle may spend (already net of the critical reserve for NORMAL work). */
  cuBudget: number;
  /** Requests this cycle may issue. */
  requestBudget: number;
}

export interface IngestPlan {
  actions: IngestAction[];
  deferred: number;
  /** Candle refreshes skipped because the asset is under backoff. */
  backedOff: number;
  cuPlanned: number;
}

/** Newest bucket held for the resolution, or null; the planner serves the stalest asset first so a tight budget rotates instead of starving. */
function newestHeld(t: TrackedAsset, resolution: CandleResolution): number | null {
  const held = t.held[resolution];
  if (!held || held.length === 0) return null;
  let max = -Infinity;
  for (const h of held) max = Math.max(max, instantToMs(h));
  return max;
}

/** A bucket run is "live" when it ends at the last closed bucket; older runs are backfill (D63). */
function provenanceFor(now: Instant, resolution: CandleResolution, req: BackfillRequest): 'LIVE' | 'BACKFILL' {
  const lastClosed = instantToMs(lastClosedBucket(now, resolution));
  const lastWanted = instantToMs(req.to) - RESOLUTION_MS[resolution];
  return lastWanted >= lastClosed - RESOLUTION_MS[resolution] ? 'LIVE' : 'BACKFILL';
}

export function planIngestCycle(input: IngestPlanInput): IngestPlan {
  const candidates: IngestAction[] = [];

  // Prices for positions are CRITICAL and come first, in batches of 100.
  const positionMints = input.tracked.filter((t) => t.priority === 'POSITION').map((t) => t.mintAddress);
  for (let i = 0; i < positionMints.length; i += BIRDEYE_ENDPOINT_LIMITS.multiPriceMaxAddresses) {
    const mints = positionMints.slice(i, i + BIRDEYE_ENDPOINT_LIMITS.multiPriceMaxAddresses);
    candidates.push({ kind: 'PRICES', mints, priority: 'CRITICAL', cu: BIRDEYE_CU.multiPrice(mints.length) });
  }

  // Priority first; within a priority the stalest asset first (nothing held sorts first), then id for determinism.
  const staleness = (t: TrackedAsset): number => {
    const newest = input.resolutions[t.priority].map((r) => newestHeld(t, r)).filter((n): n is number => n !== null);
    return newest.length ? Math.min(...newest) : -Infinity;
  };
  const sorted = [...input.tracked].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || staleness(a) - staleness(b) || a.assetId.localeCompare(b.assetId));
  let backedOff = 0;
  for (const t of sorted) {
    if (t.candleBackoffUntil && instantToMs(t.candleBackoffUntil) > instantToMs(input.now) && t.priority !== 'POSITION') {
      backedOff++;
      continue;
    }
    for (const resolution of input.resolutions[t.priority]) {
      const ms = RESOLUTION_MS[resolution];
      const to = lastClosedBucket(input.now, resolution);
      const from = addMs(to, -(input.lookbackBuckets[resolution] - 1) * ms);
      const gaps = findCandleGaps(t.held[resolution] ?? [], resolution, from, to);
      for (const req of planBackfill(gaps, BIRDEYE_ENDPOINT_LIMITS.ohlcvMaxItems)) {
        candidates.push({ kind: 'CANDLES', assetId: t.assetId, mintAddress: t.mintAddress, priority: t.priority, request: req, provenance: provenanceFor(input.now, resolution, req), cu: BIRDEYE_CU.ohlcvV3(req.buckets) });
      }
    }
  }

  const candidateMints = input.tracked.filter((t) => t.priority === 'CANDIDATE').map((t) => t.mintAddress);
  for (let i = 0; i < candidateMints.length; i += BIRDEYE_ENDPOINT_LIMITS.multiPriceMaxAddresses) {
    const mints = candidateMints.slice(i, i + BIRDEYE_ENDPOINT_LIMITS.multiPriceMaxAddresses);
    candidates.push({ kind: 'PRICES', mints, priority: 'NORMAL', cu: BIRDEYE_CU.multiPrice(mints.length) });
  }

  if (input.discoveryDue) {
    candidates.push({ kind: 'DISCOVERY_TRENDING', cu: BIRDEYE_CU.tokenTrending });
    candidates.push({ kind: 'DISCOVERY_NEW_LISTINGS', cu: BIRDEYE_CU.newListing });
  }

  const actions: IngestAction[] = [];
  let cu = 0;
  let deferred = 0;
  for (const a of candidates) {
    const critical = a.kind === 'PRICES' && a.priority === 'CRITICAL';
    if (!critical && (cu + a.cu > input.cuBudget || actions.length >= input.requestBudget)) {
      deferred++;
      continue;
    }
    actions.push(a);
    cu += a.cu;
  }
  return { actions, deferred, backedOff, cuPlanned: cu };
}
