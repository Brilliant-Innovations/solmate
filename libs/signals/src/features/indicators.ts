/**
 * Pure indicator arithmetic over ordered close/high/low/volume arrays (oldest first). Every
 * function returns null when the series is shorter than it needs: absence is never zero (§32
 * "provider zeros mistaken for real values"). No dates, no clocks, no I/O.
 */

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
  tradeCount: number | null;
}

const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

export function simpleReturn(closes: readonly number[], buckets: number): number | null {
  if (closes.length < buckets + 1) return null;
  const now = last(closes) as number;
  const ref = closes[closes.length - 1 - buckets] as number;
  return ref > 0 ? now / ref - 1 : null;
}

export function ema(values: readonly number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) e = (values[i] as number) * k + e * (1 - k);
  return e;
}

export function rsi(closes: readonly number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (gain + loss === 0) return 50;
  if (loss === 0) return 100;
  const rs = gain / period / (loss / period);
  return 100 - 100 / (1 + rs);
}

/** Average true range over `period` bars as a fraction of the last close. */
export function atrPct(bars: readonly Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const b = bars[i] as Bar;
    const prev = (bars[i - 1] as Bar).close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  }
  const close = (last(bars) as Bar).close;
  return close > 0 ? sum / period / close : null;
}

/** Standard deviation of log returns over `period` bars, per bar (not annualised). */
export function realizedVolatility(closes: readonly number[], period = 30): number | null {
  if (closes.length < period + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const a = closes[i - 1] as number;
    const b = closes[i] as number;
    if (!(a > 0) || !(b > 0)) return null;
    rets.push(Math.log(b / a));
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
}

export function macdHistogramPct(closes: readonly number[], fast = 12, slow = 26, signal = 9): number | null {
  if (closes.length < slow + signal) return null;
  const macdSeries: number[] = [];
  for (let end = slow; end <= closes.length; end++) {
    const window = closes.slice(0, end);
    const f = ema(window, fast);
    const s = ema(window, slow);
    if (f === null || s === null) return null;
    macdSeries.push(f - s);
  }
  const sig = ema(macdSeries, signal);
  const m = last(macdSeries);
  const close = last(closes) as number;
  if (sig === null || m === undefined || !(close > 0)) return null;
  return (m - sig) / close;
}

/** Bollinger position in [0,1]-ish (0 = lower band, 1 = upper band) and width as a fraction of the mean. */
export function bollinger(closes: readonly number[], period = 20, k = 2): { location: number; width: number } | null {
  if (closes.length < period) return null;
  const w = closes.slice(-period);
  const mean = w.reduce((s, v) => s + v, 0) / period;
  const sd = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  if (!(mean > 0)) return null;
  const upper = mean + k * sd;
  const lower = mean - k * sd;
  const close = last(closes) as number;
  const location = upper === lower ? 0.5 : (close - lower) / (upper - lower);
  return { location, width: (upper - lower) / mean };
}

/** Distance of the last close from the volume-weighted average price of the last `period` bars, as a fraction. */
export function vwapDistance(bars: readonly Bar[], period = 60): number | null {
  if (bars.length < period) return null;
  let pv = 0;
  let v = 0;
  for (const b of bars.slice(-period)) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volumeUsd;
    v += b.volumeUsd;
  }
  if (!(v > 0)) return null;
  const vwap = pv / v;
  const close = (last(bars) as Bar).close;
  return vwap > 0 ? close / vwap - 1 : null;
}

/** 1 when the last close exceeds the prior `period` highs, -1 below the prior lows, else 0. */
export function breakout(bars: readonly Bar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const prior = bars.slice(-(period + 1), -1);
  const close = (last(bars) as Bar).close;
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  return close > hi ? 1 : close < lo ? -1 : 0;
}

/** 1 when a breakout above the prior range occurred within the window and price has since retested (touched) that level and held above it. */
export function breakoutRetest(bars: readonly Bar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const window = bars.slice(-(period + 1));
  const level = Math.max(...window.slice(0, Math.ceil(period / 2)).map((b) => b.high));
  let broke = false;
  let retested = false;
  for (const b of window.slice(Math.ceil(period / 2))) {
    if (!broke && b.close > level) broke = true;
    else if (broke && b.low <= level && b.close >= level) retested = true;
  }
  return broke && retested ? 1 : 0;
}

/** Share of up-closes over the last `period` bars, centred on zero: +1 all up, -1 all down. */
export function trendPersistence(closes: readonly number[], period = 20): number | null {
  if (closes.length < period + 1) return null;
  let up = 0;
  for (let i = closes.length - period; i < closes.length; i++) if ((closes[i] as number) > (closes[i - 1] as number)) up++;
  return (2 * up) / period - 1;
}

export function drawdownFromHigh(bars: readonly Bar[], period = 60): number | null {
  if (bars.length < period) return null;
  const hi = Math.max(...bars.slice(-period).map((b) => b.high));
  const close = (last(bars) as Bar).close;
  return hi > 0 ? close / hi - 1 : null;
}

/** Last candle anatomy: body as a share of range, upper wick as a share of range. */
export function candleAnatomy(bar: Bar | undefined): { body: number; upperWick: number } | null {
  if (!bar) return null;
  const range = bar.high - bar.low;
  if (!(range > 0)) return { body: 0, upperWick: 0 };
  return { body: Math.abs(bar.close - bar.open) / range, upperWick: (bar.high - Math.max(bar.open, bar.close)) / range };
}

/** Last bar's volume over the median of the prior `period` bars. */
export function relativeVolume(bars: readonly Bar[], period = 60): number | null {
  if (bars.length < period + 1) return null;
  const prior = bars.slice(-(period + 1), -1).map((b) => b.volumeUsd).sort((a, b) => a - b);
  const median = prior.length % 2 ? (prior[(prior.length - 1) / 2] as number) : ((prior[prior.length / 2 - 1] as number) + (prior[prior.length / 2] as number)) / 2;
  const current = (last(bars) as Bar).volumeUsd;
  return median > 0 ? current / median : null;
}

/** Sum over the last `period` bars divided by the sum over the `period` before it, minus 1. */
export function acceleration(values: readonly (number | null)[], period: number): number | null {
  if (values.length < 2 * period) return null;
  const recent = values.slice(-period);
  const prior = values.slice(-2 * period, -period);
  if (recent.some((v) => v === null) || prior.some((v) => v === null)) return null;
  const a = (recent as number[]).reduce((s, v) => s + v, 0);
  const b = (prior as number[]).reduce((s, v) => s + v, 0);
  return b > 0 ? a / b - 1 : null;
}

export function averageTradeSize(bars: readonly Bar[], period = 15): number | null {
  if (bars.length < period) return null;
  let v = 0;
  let n = 0;
  for (const b of bars.slice(-period)) {
    if (b.tradeCount === null) return null;
    v += b.volumeUsd;
    n += b.tradeCount;
  }
  return n > 0 ? v / n : null;
}

/** Positive when price rose while volume fell (or vice versa) over `period` bars: sign(Δprice) × −sign(Δvolume) × |Δprice|. */
export function volumePriceDivergence(bars: readonly Bar[], period = 15): number | null {
  if (bars.length < period + 1) return null;
  const closes = bars.map((b) => b.close);
  const ret = simpleReturn(closes, period);
  const volAccel = acceleration(
    bars.map((b) => b.volumeUsd),
    Math.floor(period / 2),
  );
  if (ret === null || volAccel === null) return null;
  return Math.sign(ret) !== Math.sign(volAccel) && ret !== 0 && volAccel !== 0 ? Math.abs(ret) : 0;
}
