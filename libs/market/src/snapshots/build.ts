import { addMs, instantToMs, type Candle, type DataProvenance, type Instant, type MarketSnapshot, type TokenOverview, type Uuid } from '@sol-agent-trader/contracts';
import { alignBucket, RESOLUTION_MS } from '../candles/resolution.js';

/**
 * Point-in-time market snapshot (blueprint §6.5) from what is actually known at `asOf`. Every
 * derived figure is null when its inputs are missing or insufficient; nothing is coerced to zero
 * (§32 "stale or missing market/risk data appear as a valid zero"). Only candles whose bucket
 * closed at or before `asOf` are used, so a snapshot can never see the future (point-in-time,
 * §31), which also makes it replay-safe.
 */

export interface SnapshotInputs {
  id: Uuid;
  assetId: Uuid;
  asOf: Instant;
  observedAt: Instant;
  provenance: DataProvenance;
  overview: TokenOverview | null;
  /** 1m candles, any order, any provenance. */
  candles1m: readonly Candle[];
  /** Optional 15s candles for the 15-second return. */
  candles15s?: readonly Candle[];
  /** Optional SOL 1m candles for the SOL-relative 1h return. */
  solCandles1m?: readonly Candle[];
}

const RETURN_WINDOWS_MIN = { m1: 1, m3: 3, m5: 5, m15: 15, m30: 30, h1: 60, h4: 240 } as const;

function closedBefore(candles: readonly Candle[], asOf: Instant, resolution: '1m' | '15s'): Map<number, Candle> {
  const ms = RESOLUTION_MS[resolution];
  const cutoff = instantToMs(asOf);
  const map = new Map<number, Candle>();
  for (const c of candles) {
    if (c.resolution !== resolution) continue;
    const t = instantToMs(c.bucketTime);
    if (t + ms <= cutoff) map.set(t, c);
  }
  return map;
}

function lastClosed(map: Map<number, Candle>): Candle | null {
  let best: Candle | null = null;
  for (const c of map.values()) if (!best || instantToMs(c.bucketTime) > instantToMs(best.bucketTime)) best = c;
  return best;
}

/** close(now) / close(now - windowBuckets) - 1, requiring both exact buckets. */
function windowReturn(map: Map<number, Candle>, latest: Candle | null, ms: number, buckets: number): number | null {
  if (!latest) return null;
  const ref = map.get(instantToMs(latest.bucketTime) - buckets * ms);
  if (!ref || !(ref.close > 0)) return null;
  return latest.close / ref.close - 1;
}

/** Sum over the last `buckets` consecutive buckets ending at `latest`; null if any is missing. */
function windowVolume(map: Map<number, Candle>, latest: Candle | null, ms: number, buckets: number): number | null {
  if (!latest) return null;
  let sum = 0;
  const end = instantToMs(latest.bucketTime);
  for (let i = 0; i < buckets; i++) {
    const c = map.get(end - i * ms);
    if (!c) return null;
    sum += c.volumeUsd;
  }
  return sum;
}

/** Wilder ATR over `period` closed candles; null without period+1 consecutive candles. */
export function atr(map: Map<number, Candle>, latest: Candle | null, ms: number, period = 14): number | null {
  if (!latest) return null;
  const end = instantToMs(latest.bucketTime);
  const trs: number[] = [];
  for (let i = period - 1; i >= 0; i--) {
    const c = map.get(end - i * ms);
    const prev = map.get(end - (i + 1) * ms);
    if (!c || !prev) return null;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** Standard deviation of 1m log returns over `n` consecutive closes, scaled to a daily figure. */
export function realizedVolatility(map: Map<number, Candle>, latest: Candle | null, ms: number, n = 60): number | null {
  if (!latest) return null;
  const end = instantToMs(latest.bucketTime);
  const rets: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const c = map.get(end - i * ms);
    const prev = map.get(end - (i + 1) * ms);
    if (!c || !prev || !(prev.close > 0) || !(c.close > 0)) return null;
    rets.push(Math.log(c.close / prev.close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(1440);
}

/** Volume of the last 5 minutes relative to the median 5-minute volume over the trailing 4 hours. */
export function relativeVolume(map: Map<number, Candle>, latest: Candle | null, ms: number): number | null {
  if (!latest) return null;
  const end = instantToMs(latest.bucketTime);
  const windows: number[] = [];
  for (let w = 0; w < 48; w++) {
    let sum = 0;
    let complete = true;
    for (let i = 0; i < 5; i++) {
      const c = map.get(end - (w * 5 + i) * ms);
      if (!c) {
        complete = false;
        break;
      }
      sum += c.volumeUsd;
    }
    if (complete) windows.push(sum);
  }
  if (windows.length < 12) return null;
  const current = windows[0] as number;
  const trailing = windows.slice(1).sort((a, b) => a - b);
  const median = trailing.length % 2 ? (trailing[(trailing.length - 1) / 2] as number) : ((trailing[trailing.length / 2 - 1] as number) + (trailing[trailing.length / 2] as number)) / 2;
  if (!(median > 0)) return null;
  return current / median;
}

export function buildMarketSnapshot(input: SnapshotInputs): MarketSnapshot {
  const m1 = closedBefore(input.candles1m, input.asOf, '1m');
  const s15 = closedBefore(input.candles15s ?? [], input.asOf, '15s');
  const latest1m = lastClosed(m1);
  const latest15s = lastClosed(s15);
  const ms1 = RESOLUTION_MS['1m'];
  const ms15 = RESOLUTION_MS['15s'];
  const ov = input.overview;
  const w = (k: 'h1' | 'h4' | 'h24') => ov?.windows[k];

  let solRelativeReturn: number | null = null;
  if (input.solCandles1m && latest1m) {
    const sol = closedBefore(input.solCandles1m, input.asOf, '1m');
    const solLatest = sol.get(instantToMs(latest1m.bucketTime)) ?? null;
    const own = windowReturn(m1, latest1m, ms1, 60);
    const solRet = windowReturn(sol, solLatest, ms1, 60);
    if (own !== null && solRet !== null) solRelativeReturn = own - solRet;
  }

  // The snapshot's price is the last closed 1m close when it is current (within 2 buckets of asOf);
  // otherwise the overview price if the provider updated it after that candle. Never a stale one.
  let priceUsd: number | null = null;
  if (latest1m && instantToMs(alignBucket(input.asOf, '1m')) - instantToMs(latest1m.bucketTime) <= 2 * ms1) priceUsd = latest1m.close;
  if (priceUsd === null && ov?.priceUsd && ov.providerUpdatedAt && instantToMs(input.asOf) - instantToMs(ov.providerUpdatedAt) <= 2 * ms1) priceUsd = ov.priceUsd;

  return {
    id: input.id,
    assetId: input.assetId,
    asOf: input.asOf,
    observedAt: input.observedAt,
    provenance: input.provenance,
    priceUsd,
    liquidityUsd: ov?.liquidityUsd ?? null,
    volumeUsd: {
      m5: windowVolume(m1, latest1m, ms1, 5),
      m15: windowVolume(m1, latest1m, ms1, 15),
      h1: w('h1')?.volumeUsd ?? null,
      h4: w('h4')?.volumeUsd ?? null,
      h24: w('h24')?.volumeUsd ?? null,
    },
    buyVolumeUsd: { m5: null, m15: null, h1: w('h1')?.buyVolumeUsd ?? null, h4: w('h4')?.buyVolumeUsd ?? null, h24: w('h24')?.buyVolumeUsd ?? null },
    sellVolumeUsd: { m5: null, m15: null, h1: w('h1')?.sellVolumeUsd ?? null, h4: w('h4')?.sellVolumeUsd ?? null, h24: w('h24')?.sellVolumeUsd ?? null },
    buyCount: { m5: null, m15: null, h1: w('h1')?.buyCount ?? null, h4: w('h4')?.buyCount ?? null, h24: w('h24')?.buyCount ?? null },
    sellCount: { m5: null, m15: null, h1: w('h1')?.sellCount ?? null, h4: w('h4')?.sellCount ?? null, h24: w('h24')?.sellCount ?? null },
    relativeVolume: relativeVolume(m1, latest1m, ms1),
    atr: atr(m1, latest1m, ms1),
    realizedVolatility: realizedVolatility(m1, latest1m, ms1),
    returns: {
      s15: windowReturn(s15, latest15s, ms15, 1),
      m1: windowReturn(m1, latest1m, ms1, RETURN_WINDOWS_MIN.m1),
      m3: windowReturn(m1, latest1m, ms1, RETURN_WINDOWS_MIN.m3),
      m5: windowReturn(m1, latest1m, ms1, RETURN_WINDOWS_MIN.m5),
      m15: windowReturn(m1, latest1m, ms1, RETURN_WINDOWS_MIN.m15),
      m30: windowReturn(m1, latest1m, ms1, RETURN_WINDOWS_MIN.m30),
      h1: windowReturn(m1, latest1m, ms1, RETURN_WINDOWS_MIN.h1),
      h4: windowReturn(m1, latest1m, ms1, RETURN_WINDOWS_MIN.h4),
    },
    marketCapUsd: ov?.marketCapUsd ?? null,
    fdvUsd: ov?.fdvUsd ?? null,
    solRelativeReturn,
    universeRelativeStrength: null,
    routeProbes: [],
  };
}

/** Convenience for callers that snapshot "now": the asOf is aligned to the last closed minute. */
export function snapshotAsOf(now: Instant): Instant {
  return addMs(alignBucket(now, '1m'), 0);
}
