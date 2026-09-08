'use client';

import { useEffect, useRef, useState } from 'react';

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  text: string;
}

export interface ChartLevel {
  price: number;
  color: string;
  title: string;
}

/**
 * Multi-timeframe candle chart for the Asset Workspace (§20.5) on Lightweight Charts (pinned per
 * ADR-0005; its attribution link is kept visible as the licence requires). Markers carry
 * candidates, fills and cycle decisions; levels carry stops and protective orders. Overlays
 * (EMA 9/21, VWAP) are computed here from the candles the server sent; nothing is fetched by the
 * chart itself. An empty series renders "no candles" rather than a flat line at zero.
 */
export function CandleChart({ series, markers, levels }: { series: { resolution: string; rows: ChartCandle[] }[]; markers: ChartMarker[]; levels: ChartLevel[] }) {
  const el = useRef<HTMLDivElement>(null);
  const [resolution, setResolution] = useState(series.find((s) => s.rows.length > 0)?.resolution ?? series[0]?.resolution ?? '5m');
  const [overlays, setOverlays] = useState<{ ema: boolean; vwap: boolean; volume: boolean }>({ ema: true, vwap: false, volume: true });
  const rows = series.find((s) => s.resolution === resolution)?.rows ?? [];

  useEffect(() => {
    if (!el.current || rows.length === 0) return;
    let disposed = false;
    let chart: { remove(): void } | null = null;
    (async () => {
      const lw = await import('lightweight-charts');
      if (disposed || !el.current) return;
      const c = lw.createChart(el.current, {
        height: 360,
        layout: { background: { color: 'transparent' }, textColor: getComputedStyle(el.current).color, attributionLogo: true },
        grid: { vertLines: { color: 'rgba(128,128,128,0.15)' }, horzLines: { color: 'rgba(128,128,128,0.15)' } },
        timeScale: { timeVisible: true, secondsVisible: false },
        rightPriceScale: { borderVisible: false },
      });
      chart = c;
      const candles = c.addSeries(lw.CandlestickSeries, { upColor: '#2e9e6b', downColor: '#c94f4f', wickUpColor: '#2e9e6b', wickDownColor: '#c94f4f', borderVisible: false });
      candles.setData(rows.map((r) => ({ time: r.time as never, open: r.open, high: r.high, low: r.low, close: r.close })));
      if (overlays.volume) {
        const vol = c.addSeries(lw.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: 'rgba(120,120,160,0.4)' });
        c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        vol.setData(rows.map((r) => ({ time: r.time as never, value: r.volume, color: r.close >= r.open ? 'rgba(46,158,107,0.35)' : 'rgba(201,79,79,0.35)' })));
      }
      if (overlays.ema) {
        for (const [n, color] of [[9, '#d9a62e'], [21, '#4f7fc9']] as const) {
          const s = c.addSeries(lw.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: `EMA ${n}` });
          s.setData(ema(rows, n).map((v, i) => ({ time: rows[i]!.time as never, value: v })).filter((p) => Number.isFinite(p.value)));
        }
      }
      if (overlays.vwap) {
        const s = c.addSeries(lw.LineSeries, { color: '#9b59b6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'VWAP' });
        s.setData(vwap(rows).map((v, i) => ({ time: rows[i]!.time as never, value: v })).filter((p) => Number.isFinite(p.value)));
      }
      for (const l of levels) candles.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title });
      const first = rows[0]!.time;
      const last = rows.at(-1)!.time;
      const inRange = markers.filter((m) => m.time >= first && m.time <= last).sort((a, b) => a.time - b.time);
      if (inRange.length > 0) lw.createSeriesMarkers(candles, inRange.map((m) => ({ time: snap(m.time, rows) as never, position: m.position, color: m.color, shape: m.shape, text: m.text })));
      c.timeScale().fitContent();
      const ro = new ResizeObserver(() => c.applyOptions({ width: el.current?.clientWidth ?? 600 }));
      ro.observe(el.current);
    })();
    return () => {
      disposed = true;
      chart?.remove();
    };
  }, [rows, markers, levels, overlays]);

  return (
    <div>
      <div className="controls" style={{ marginBottom: '0.4rem', gap: '0.4rem' }}>
        {series.map((s) => (
          <button key={s.resolution} type="button" className="btn" aria-pressed={s.resolution === resolution} onClick={() => setResolution(s.resolution)} disabled={s.rows.length === 0} title={s.rows.length === 0 ? 'no candles at this resolution' : `${s.rows.length} candles`}>
            {s.resolution}
          </button>
        ))}
        <span className="muted mono" style={{ marginLeft: '0.6rem' }}>overlays</span>
        {(['ema', 'vwap', 'volume'] as const).map((k) => (
          <label key={k} className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <input type="checkbox" checked={overlays[k]} onChange={(e) => setOverlays({ ...overlays, [k]: e.target.checked })} /> {k.toUpperCase()}
          </label>
        ))}
      </div>
      {rows.length === 0 ? <p className="muted">No candles stored at {resolution} for this asset.</p> : <div ref={el} style={{ width: '100%', minHeight: 360 }} />}
    </div>
  );
}

function ema(rows: ChartCandle[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let prev = NaN;
  rows.forEach((r, i) => {
    prev = i === 0 ? r.close : i < n ? (prev * i + r.close) / (i + 1) : r.close * k + prev * (1 - k);
    out.push(i < n - 1 ? NaN : prev);
  });
  return out;
}

function vwap(rows: ChartCandle[]): number[] {
  let pv = 0;
  let v = 0;
  return rows.map((r) => {
    const typical = (r.high + r.low + r.close) / 3;
    pv += typical * r.volume;
    v += r.volume;
    return v > 0 ? pv / v : NaN;
  });
}

function snap(t: number, rows: ChartCandle[]): number {
  let best = rows[0]!.time;
  for (const r of rows) {
    if (r.time <= t) best = r.time;
    else break;
  }
  return best;
}
