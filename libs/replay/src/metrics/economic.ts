import type { Instant, VersionId } from '@sol-agent-trader/contracts';

/**
 * Three-layer economic P&L (blueprint §19.4, D37, §31 "economic P&L includes direct strategy and
 * shared platform operating costs"; §30 Q19). Layer 1 is what the ledger realized after fees and
 * slippage. Layer 2 subtracts what the strategy itself consumed: model calls, provider data and
 * RPC attributable to its cycles. Layer 3 subtracts its share of the platform's run-rate for the
 * window (hosting, data tiers, alerting), allocated either equally or by turnover. A strategy is
 * only "profitable" at the layer the reader chooses to look at, and the UI shows all three.
 */

export interface DirectCosts {
  modelUsd: number;
  dataUsd: number;
  rpcUsd: number;
}

export interface EconomicInput {
  window: { from: Instant; to: Instant };
  strategies: { strategyVersionId: VersionId; tradingNetUsd: number; turnoverUsd: number; direct: DirectCosts }[];
  /** Platform run-rate for the window's providers, USD per 30 days (docs/costs.md). */
  platformMonthlyUsd: number;
  allocation: 'EQUAL' | 'BY_TURNOVER';
}

export interface EconomicRow {
  strategyVersionId: VersionId;
  tradingNetUsd: number;
  directCostUsd: number;
  strategyEconomicUsd: number;
  platformShareUsd: number;
  platformEconomicUsd: number;
  /** Direct cost per USD of trading net; null when trading net is not positive. */
  costToEdgeRatio: number | null;
}

export interface EconomicPnl {
  windowDays: number;
  platformCostForWindowUsd: number;
  allocation: EconomicInput['allocation'];
  rows: EconomicRow[];
  totals: Omit<EconomicRow, 'strategyVersionId' | 'costToEdgeRatio'>;
}

const DAY_MS = 86_400_000;

export function economicPnl(input: EconomicInput): EconomicPnl {
  const windowDays = Math.max(0, (Date.parse(input.window.to) - Date.parse(input.window.from)) / DAY_MS);
  const platformCostForWindowUsd = (input.platformMonthlyUsd * windowDays) / 30;
  const n = input.strategies.length;
  const turnoverTotal = input.strategies.reduce((a, s) => a + s.turnoverUsd, 0);
  const rows: EconomicRow[] = input.strategies.map((s) => {
    const share = n === 0 ? 0 : input.allocation === 'EQUAL' || turnoverTotal <= 0 ? platformCostForWindowUsd / n : (platformCostForWindowUsd * s.turnoverUsd) / turnoverTotal;
    const directCostUsd = s.direct.modelUsd + s.direct.dataUsd + s.direct.rpcUsd;
    const strategyEconomicUsd = s.tradingNetUsd - directCostUsd;
    return {
      strategyVersionId: s.strategyVersionId,
      tradingNetUsd: s.tradingNetUsd,
      directCostUsd,
      strategyEconomicUsd,
      platformShareUsd: share,
      platformEconomicUsd: strategyEconomicUsd - share,
      costToEdgeRatio: s.tradingNetUsd > 0 ? directCostUsd / s.tradingNetUsd : null,
    };
  });
  const totals = rows.reduce(
    (t, r) => ({ tradingNetUsd: t.tradingNetUsd + r.tradingNetUsd, directCostUsd: t.directCostUsd + r.directCostUsd, strategyEconomicUsd: t.strategyEconomicUsd + r.strategyEconomicUsd, platformShareUsd: t.platformShareUsd + r.platformShareUsd, platformEconomicUsd: t.platformEconomicUsd + r.platformEconomicUsd }),
    { tradingNetUsd: 0, directCostUsd: 0, strategyEconomicUsd: 0, platformShareUsd: 0, platformEconomicUsd: 0 },
  );
  return { windowDays, platformCostForWindowUsd, allocation: input.allocation, rows, totals };
}
