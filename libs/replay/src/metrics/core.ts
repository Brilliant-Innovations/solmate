import type { ExecutionPath, Instant, MarketRegime, MarketSession, TriggerFamily, VersionId } from '@sol-agent-trader/contracts';

/**
 * Core trading metrics (blueprint §19.1) and signal attribution groups (§19.2), pure over closed
 * trades expressed in settlement units. Every number is derived from the same trade rows the
 * ledger holds, so paper, replay and live-shadow results are comparable when their fidelity
 * level is shown beside them (§18.1: never conflated, always labelled).
 */

export interface TradeAttributes {
  candidateFamily: TriggerFamily | null;
  regime: MarketRegime | null;
  sessions: MarketSession[];
  tokenAgeBand: string | null;
  liquidityBand: string | null;
  marketCapBand: string | null;
  relativeVolumeBand: string | null;
  smartMoneyPresent: boolean | null;
  newsCatalystPresent: boolean | null;
  socialAccelerationPresent: boolean | null;
  proposerConfidence: number | null;
  adversaryVerdict: 'CONFIRM' | 'CHALLENGE' | 'REJECT' | null;
}

export interface ClosedTrade {
  id: string;
  strategyVersionId: VersionId;
  assetId: string;
  candidateId: string | null;
  openedAt: Instant;
  closedAt: Instant;
  /** Settlement units (e.g. USDC), not base units: the metrics layer is decimal. */
  cost: number;
  proceeds: number;
  fees: number;
  /**
   * SOL-denominated network and priority fees for this trade, in lamports. They are real costs the
   * settlement-denominated `fees` field cannot hold, and leaving them out of the reported numbers
   * made `netPnl` identical to `grossPnl` under the default fill policy, whose router and
   * transfer basis points are legitimately zero (review 2026-09-09, M-14).
   */
  feesLamports?: number;
  /** Slippage/price impact paid versus the decision quote, in settlement units (≥ 0). */
  slippageCost: number;
  /** Realized shortfall versus the contemporaneous executable expectation in bps; negative = improved (D48). */
  executionShortfallBps: number | null;
  executionPath: ExecutionPath;
  exitReason: string;
  decisionToFillMs: number | null;
  attributes: TradeAttributes;
}

export interface CoreMetrics {
  trades: number;
  grossPnl: number;
  fees: number;
  /** Total SOL-denominated fees across these trades, in lamports. */
  feesLamports: number;
  /** Those lamports converted at the supplied SOL price; null when no price was available. */
  feesLamportsAsSettlement: number | null;
  /** False when `netPnl` could not include the SOL fees because no SOL price was supplied. */
  netIncludesSolFees: boolean;
  slippageCost: number;
  netPnl: number;
  /** Mean realized shortfall in bps across trades that carry one. */
  executionShortfallBps: number | null;
  executionShortfallByPath: Record<string, { trades: number; meanBps: number }>;
  winRate: number | null;
  averageWinner: number | null;
  averageLoser: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  maxDrawdownFraction: number | null;
  timeInMarketMs: number;
  timeInMarketFraction: number | null;
  turnover: number;
  sharpe: number | null;
  sortino: number | null;
  /** Worst 5 % of trade outcomes: mean net P&L of that tail. */
  tailLoss: number | null;
  failedExecutionRate: number | null;
  averageDecisionToFillMs: number | null;
}

export interface MetricsInput {
  trades: readonly ClosedTrade[];
  /** Attempts that never became a fill (chase, expiry, not landed); drives failed execution rate. */
  failedExecutions: number;
  startingEquity: number;
  window: { from: Instant; to: Instant };
  /** Settlement units per SOL, for charging network and priority fees; null = not available. */
  solPriceSettlement?: number | null;
  /** Minimum sample before Sharpe/Sortino are reported (§19.1 "where sample supports it"). */
  minSampleForRatios?: number;
}

const ms = (i: Instant) => Date.parse(i);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const stddev = (xs: number[]) => {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function netOf(t: ClosedTrade, solPriceSettlement: number | null = null): number {
  const sol = solPriceSettlement !== null && t.feesLamports ? (t.feesLamports / 1e9) * solPriceSettlement : 0;
  return t.proceeds - t.cost - t.fees - sol;
}

export function coreMetrics(input: MetricsInput): CoreMetrics {
  const trades = [...input.trades].sort((a, b) => ms(a.closedAt) - ms(b.closedAt));
  const solPrice = input.solPriceSettlement ?? null;
  const nets = trades.map((t) => netOf(t, solPrice));
  const grossPnl = trades.reduce((a, t) => a + (t.proceeds - t.cost), 0);
  const fees = trades.reduce((a, t) => a + t.fees, 0);
  const feesLamports = trades.reduce((a, t) => a + (t.feesLamports ?? 0), 0);
  const feesLamportsAsSettlement = solPrice === null ? null : (feesLamports / 1e9) * solPrice;
  const slippageCost = trades.reduce((a, t) => a + t.slippageCost, 0);
  const netPnl = grossPnl - fees - (feesLamportsAsSettlement ?? 0);
  const winners = nets.filter((n) => n > 0);
  const losers = nets.filter((n) => n <= 0);
  const grossWins = winners.reduce((a, b) => a + b, 0);
  const grossLosses = -losers.reduce((a, b) => a + b, 0);

  let equity = input.startingEquity;
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownFraction: number | null = input.startingEquity > 0 ? 0 : null;
  for (const n of nets) {
    equity += n;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      if (peak > 0) maxDrawdownFraction = dd / peak;
    }
  }

  const windowMs = Math.max(0, ms(input.window.to) - ms(input.window.from));
  const timeInMarketMs = unionDurationMs(trades.map((t) => [ms(t.openedAt), ms(t.closedAt)] as const));
  const turnover = trades.reduce((a, t) => a + t.cost + t.proceeds, 0);

  const minSample = input.minSampleForRatios ?? 20;
  const returns = trades.map((t) => (t.cost > 0 ? netOf(t, solPrice) / t.cost : 0));
  const rMean = mean(returns);
  const rStd = stddev(returns);
  const downside = returns.filter((r) => r < 0);
  const downsideDev = downside.length ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / returns.length) : 0;
  const sharpe = trades.length >= minSample && rMean !== null && rStd !== null && rStd > 0 ? (rMean / rStd) * Math.sqrt(trades.length) : null;
  const sortino = trades.length >= minSample && rMean !== null && downsideDev > 0 ? (rMean / downsideDev) * Math.sqrt(trades.length) : null;

  const sortedNets = [...nets].sort((a, b) => a - b);
  const tailCount = Math.max(1, Math.floor(sortedNets.length * 0.05));
  const tailLoss = sortedNets.length ? mean(sortedNets.slice(0, tailCount)) : null;

  const shortfalls = trades.filter((t) => t.executionShortfallBps !== null);
  const byPath: Record<string, { trades: number; meanBps: number }> = {};
  for (const t of shortfalls) {
    const cur = byPath[t.executionPath] ?? { trades: 0, meanBps: 0 };
    const n = cur.trades + 1;
    byPath[t.executionPath] = { trades: n, meanBps: cur.meanBps + ((t.executionShortfallBps as number) - cur.meanBps) / n };
  }
  const attempts = trades.length + input.failedExecutions;
  const latencies = trades.map((t) => t.decisionToFillMs).filter((x): x is number => x !== null);

  return {
    trades: trades.length,
    grossPnl,
    fees,
    feesLamports,
    feesLamportsAsSettlement,
    netIncludesSolFees: solPrice !== null,
    slippageCost,
    netPnl,
    executionShortfallBps: mean(shortfalls.map((t) => t.executionShortfallBps as number)),
    executionShortfallByPath: byPath,
    winRate: trades.length ? winners.length / trades.length : null,
    averageWinner: mean(winners),
    averageLoser: mean(losers),
    expectancy: mean(nets),
    // No losses yet is not an infinite factor: the sample is too small to say, and a canonical record cannot hold Infinity.
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : null,
    maxDrawdown,
    maxDrawdownFraction,
    timeInMarketMs,
    timeInMarketFraction: windowMs > 0 ? Math.min(1, timeInMarketMs / windowMs) : null,
    turnover,
    sharpe,
    sortino,
    tailLoss,
    failedExecutionRate: attempts > 0 ? input.failedExecutions / attempts : null,
    averageDecisionToFillMs: mean(latencies),
  };
}

/** Total time covered by at least one open interval (overlapping positions do not double count). */
export function unionDurationMs(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  for (const [a, b] of sorted) {
    if (curStart === null || a > curEnd) {
      if (curStart !== null) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else curEnd = Math.max(curEnd, b);
  }
  if (curStart !== null) total += curEnd - curStart;
  return total;
}

// --- §19.2 signal attribution -------------------------------------------------------------------

export type AttributionDimension =
  | 'candidateFamily'
  | 'regime'
  | 'tokenAgeBand'
  | 'liquidityBand'
  | 'marketCapBand'
  | 'relativeVolumeBand'
  | 'smartMoneyPresent'
  | 'newsCatalystPresent'
  | 'socialAccelerationPresent'
  | 'confidenceBin'
  | 'adversaryVerdict'
  | 'hourOfDayUtc'
  | 'dayOfWeekUtc'
  | 'session'
  | 'durationBand'
  | 'executionPath';

export const DURATION_BANDS: readonly { label: string; maxMs: number }[] = [
  { label: '<5m', maxMs: 5 * 60_000 },
  { label: '5m–30m', maxMs: 30 * 60_000 },
  { label: '30m–2h', maxMs: 2 * 3_600_000 },
  { label: '2h–8h', maxMs: 8 * 3_600_000 },
  { label: '8h–24h', maxMs: 24 * 3_600_000 },
  { label: '>24h', maxMs: Number.POSITIVE_INFINITY },
];

export function durationBand(openedAt: Instant, closedAt: Instant): string {
  const d = ms(closedAt) - ms(openedAt);
  return (DURATION_BANDS.find((b) => d < b.maxMs) ?? DURATION_BANDS[DURATION_BANDS.length - 1]!).label;
}

/** Keys a trade falls under for one dimension; a trade with several sessions counts once per session. */
export function attributionKeys(t: ClosedTrade, dim: AttributionDimension, confidenceBin: (c: number) => string): string[] {
  const a = t.attributes;
  const one = (v: string | boolean | null | undefined) => [v === null || v === undefined ? 'unknown' : String(v)];
  switch (dim) {
    case 'candidateFamily': return one(a.candidateFamily);
    case 'regime': return one(a.regime);
    case 'tokenAgeBand': return one(a.tokenAgeBand);
    case 'liquidityBand': return one(a.liquidityBand);
    case 'marketCapBand': return one(a.marketCapBand);
    case 'relativeVolumeBand': return one(a.relativeVolumeBand);
    case 'smartMoneyPresent': return one(a.smartMoneyPresent);
    case 'newsCatalystPresent': return one(a.newsCatalystPresent);
    case 'socialAccelerationPresent': return one(a.socialAccelerationPresent);
    case 'confidenceBin': return one(a.proposerConfidence === null ? null : confidenceBin(a.proposerConfidence));
    case 'adversaryVerdict': return one(a.adversaryVerdict);
    case 'hourOfDayUtc': return [String(new Date(ms(t.openedAt)).getUTCHours()).padStart(2, '0')];
    case 'dayOfWeekUtc': return [String(new Date(ms(t.openedAt)).getUTCDay())];
    case 'session': return a.sessions.length ? a.sessions : ['unknown'];
    case 'durationBand': return [durationBand(t.openedAt, t.closedAt)];
    case 'executionPath': return [t.executionPath];
  }
}

export interface AttributionGroup {
  key: string;
  metrics: CoreMetrics;
  /** Below this the group is shown as under-sampled rather than as a conclusion (§19.2 "if sample supports it"). */
  sampleSupported: boolean;
}

export function attributeBy(input: MetricsInput, dim: AttributionDimension, confidenceBin: (c: number) => string, minSample = 10): AttributionGroup[] {
  const groups = new Map<string, ClosedTrade[]>();
  for (const t of input.trades) for (const k of attributionKeys(t, dim, confidenceBin)) groups.set(k, [...(groups.get(k) ?? []), t]);
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, trades]) => ({ key, metrics: coreMetrics({ ...input, trades, failedExecutions: 0 }), sampleSupported: trades.length >= minSample }));
}
