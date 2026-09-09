import { loadTradeHistory, type TradeRow } from './history';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Attribution / Economic P&L (§20.16, §19.4, D37; §31 "economic P&L includes direct strategy and
 * shared platform operating costs"). Three layers over a period: trading P&L from closed lots
 * (gross, router fees, priority/network fees, transfer fees, slippage, net); strategy economic
 * P&L (net trading minus attributable model calls and a data/RPC share); platform economic P&L
 * (aggregate strategies minus shared subscriptions and hosting). Unit costs per candidate, action
 * cycle, executed trade and profitable trade. Costs come from the ledger (agents.runs cost_usd,
 * ops.provider_spend) and the recorded tiers in docs/costs.md; every assumption is labelled.
 */

/** Monthly run-rate by provider as recorded in docs/costs.md (actual tiers, not projections). */
export const PLATFORM_SUBSCRIPTIONS: readonly { provider: string; tier: string; monthlyUsd: number; note: string }[] = [
  { provider: 'Birdeye', tier: 'Lite', monthlyUsd: 39, note: '2.5 M CU/month, 15 rps' },
  { provider: 'Helius', tier: 'Free', monthlyUsd: 0, note: '1 M credits/month' },
  { provider: 'Jupiter', tier: 'Lite', monthlyUsd: 0, note: 'quote API, keyless price' },
  { provider: 'Supabase', tier: 'Free', monthlyUsd: 0, note: 'Pro expected with storage growth' },
  { provider: 'Vercel', tier: 'Hobby', monthlyUsd: 0, note: 'Pro needed for the D57 cron' },
  { provider: 'Sentry', tier: 'Developer', monthlyUsd: 0, note: '' },
  { provider: 'GitHub', tier: 'Free', monthlyUsd: 0, note: 'Actions + GHCR' },
];
/** Birdeye Lite: USD 39 for 2.5 M CU. */
const BIRDEYE_USD_PER_CU = 39 / 2_500_000;

export interface TradingPnlRow {
  strategyVersionId: string;
  book: 'PAPER' | 'LIVE';
  trades: number;
  profitable: number;
  grossUsdc: number;
  routerFeesUsdc: number;
  transferFeesUsdc: number;
  slippageUsdc: number;
  networkLamports: number;
  priorityLamports: number;
  networkPriorityUsd: number | null;
  netUsdc: number;
}

export interface StrategyEconomicRow {
  strategyVersionId: string;
  book: 'PAPER' | 'LIVE';
  netTradingUsd: number;
  modelUsd: number;
  modelRuns: number;
  dataRpcShareUsd: number;
  contributionUsd: number;
}

export interface AttributionView {
  periodDays: number;
  from: string;
  to: string;
  solPriceUsd: number | null;
  trading: TradingPnlRow[];
  strategy: StrategyEconomicRow[];
  platform: {
    aggregateContributionUsd: number;
    subscriptionsUsd: number;
    subscriptions: { provider: string; tier: string; monthlyUsd: number; periodUsd: number; note: string }[];
    dataUsageUsd: number;
    providerSpend: { provider: string; month: string; usedCu: number; estimatedUsd: number }[];
    hostingUsd: number;
    finalOperatingResultUsd: number;
  };
  units: {
    candidates: number;
    actionCycles: number;
    executedTrades: number;
    profitableTrades: number;
    totalCostUsd: number;
    perCandidate: number | null;
    perActionCycle: number | null;
    perExecutedTrade: number | null;
    perProfitableTrade: number | null;
  };
  rows: TradeRow[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export async function loadAttribution(periodDays: number): Promise<AttributionView> {
  const to = new Date();
  const from = new Date(to.getTime() - periodDays * 86_400_000);
  const supabase = await createSupabaseServerClient();
  const rows = await loadTradeHistory({ strategy: '', book: '', result: '', exitReason: '', path: '', regime: '', family: '', verdict: '', symbol: '', from: from.toISOString(), to: to.toISOString(), includeOpen: false, limit: 2000 });
  const months = new Set<string>();
  for (let d = new Date(from); d <= to; d.setUTCMonth(d.getUTCMonth() + 1)) months.add(d.toISOString().slice(0, 7));
  months.add(to.toISOString().slice(0, 7));
  const [runs, spend, candidates, cycles, sol] = supabase
    ? await Promise.all([
        supabase.schema('agents').from('runs').select('action_cycle_id, cost_usd, created_at').gte('created_at', from.toISOString()).lte('created_at', to.toISOString()).limit(5000),
        supabase.schema('ops').from('provider_spend').select('provider, month, used_cu').in('month', [...months]),
        supabase.schema('signals').from('candidates').select('id', { count: 'exact', head: true }).gte('discovered_at', from.toISOString()).lte('discovered_at', to.toISOString()),
        supabase.schema('agents').from('action_cycles').select('id', { count: 'exact', head: true }).gte('started_at', from.toISOString()).lte('started_at', to.toISOString()),
        supabase.schema('signals').from('scanner').select('price_usd').eq('mint', 'So11111111111111111111111111111111111111112').maybeSingle(),
      ])
    : [{ data: [] }, { data: [] }, { count: 0 }, { count: 0 }, { data: null }];
  const runRows = (runs.data as { action_cycle_id: string | null; cost_usd: number }[] | null) ?? [];
  const cycleIds = [...new Set(runRows.map((r) => r.action_cycle_id).filter((x): x is string => !!x))];
  const cycleStrategy = new Map<string, string>();
  if (supabase && cycleIds.length) {
    const { data } = await supabase.schema('agents').from('action_cycles').select('id, strategy_version_id').in('id', cycleIds);
    for (const c of (data as { id: string; strategy_version_id: string }[] | null) ?? []) cycleStrategy.set(c.id, c.strategy_version_id);
  }
  const solPriceUsd = typeof (sol.data as { price_usd?: number | null } | null)?.price_usd === 'number' ? ((sol.data as { price_usd: number }).price_usd as number) : null;

  const tradingBy = new Map<string, TradingPnlRow>();
  for (const r of rows) {
    const key = `${r.strategyVersionId}|${r.book}`;
    const t = tradingBy.get(key) ?? { strategyVersionId: r.strategyVersionId, book: r.book, trades: 0, profitable: 0, grossUsdc: 0, routerFeesUsdc: 0, transferFeesUsdc: 0, slippageUsdc: 0, networkLamports: 0, priorityLamports: 0, networkPriorityUsd: null, netUsdc: 0 };
    const realized = Number(r.realizedPnlBaseUnits) / 1e6;
    t.trades++;
    if (realized > 0) t.profitable++;
    t.grossUsdc += realized + r.fees.routerSettlement + r.fees.transferSettlement;
    t.routerFeesUsdc += r.fees.routerSettlement;
    t.transferFeesUsdc += r.fees.transferSettlement;
    t.slippageUsdc += r.slippageSettlement;
    t.networkLamports += r.fees.networkLamports;
    t.priorityLamports += r.fees.priorityLamports;
    t.netUsdc += realized;
    tradingBy.set(key, t);
  }
  const trading = [...tradingBy.values()].map((t) => ({ ...t, networkPriorityUsd: solPriceUsd === null ? null : ((t.networkLamports + t.priorityLamports) / 1e9) * solPriceUsd })).sort((a, b) => (a.strategyVersionId < b.strategyVersionId ? -1 : 1));

  const modelBy = new Map<string, { usd: number; runs: number }>();
  for (const r of runRows) {
    const s = r.action_cycle_id ? cycleStrategy.get(r.action_cycle_id) : undefined;
    const key = s ?? 'unattributed';
    const m = modelBy.get(key) ?? { usd: 0, runs: 0 };
    m.usd += r.cost_usd;
    m.runs++;
    modelBy.set(key, m);
  }
  const providerSpend = ((spend.data as { provider: string; month: string; used_cu: number }[] | null) ?? []).map((p) => ({ provider: p.provider, month: p.month, usedCu: Number(p.used_cu), estimatedUsd: p.provider.toLowerCase() === 'birdeye' ? Number(p.used_cu) * BIRDEYE_USD_PER_CU : 0 }));
  const dataUsageUsd = sum(providerSpend.map((p) => p.estimatedUsd)) * Math.min(1, periodDays / 30);
  const turnoverTotal = sum(trading.map((t) => Math.abs(t.grossUsdc) + t.routerFeesUsdc)) || 0;
  const strategy: StrategyEconomicRow[] = trading.map((t) => {
    const m = modelBy.get(t.strategyVersionId) ?? { usd: 0, runs: 0 };
    const netTradingUsd = t.netUsdc - (t.networkPriorityUsd ?? 0);
    const share = trading.length ? (turnoverTotal > 0 ? (dataUsageUsd * (Math.abs(t.grossUsdc) + t.routerFeesUsdc)) / turnoverTotal : dataUsageUsd / trading.length) : 0;
    return { strategyVersionId: t.strategyVersionId, book: t.book, netTradingUsd, modelUsd: m.usd, modelRuns: m.runs, dataRpcShareUsd: share, contributionUsd: netTradingUsd - m.usd - share };
  });
  const unattributedModel = modelBy.get('unattributed') ?? { usd: 0, runs: 0 };
  const subscriptions = PLATFORM_SUBSCRIPTIONS.map((s) => ({ ...s, periodUsd: (s.monthlyUsd * periodDays) / 30 }));
  const subscriptionsUsd = sum(subscriptions.map((s) => s.periodUsd));
  const aggregateContributionUsd = sum(strategy.map((s) => s.contributionUsd)) - unattributedModel.usd;
  const hostingUsd = 0;
  const finalOperatingResultUsd = aggregateContributionUsd - subscriptionsUsd - hostingUsd;
  const executedTrades = rows.length;
  const profitableTrades = rows.filter((r) => Number(r.realizedPnlBaseUnits) > 0).length;
  const totalCostUsd = sum(strategy.map((s) => s.modelUsd + s.dataRpcShareUsd)) + unattributedModel.usd + subscriptionsUsd + hostingUsd;
  const candidatesN = candidates.count ?? 0;
  const cyclesN = cycles.count ?? 0;
  return {
    periodDays,
    from: from.toISOString(),
    to: to.toISOString(),
    solPriceUsd,
    trading,
    strategy,
    platform: { aggregateContributionUsd, subscriptionsUsd, subscriptions, dataUsageUsd, providerSpend, hostingUsd, finalOperatingResultUsd },
    units: {
      candidates: candidatesN,
      actionCycles: cyclesN,
      executedTrades,
      profitableTrades,
      totalCostUsd,
      perCandidate: candidatesN ? totalCostUsd / candidatesN : null,
      perActionCycle: cyclesN ? totalCostUsd / cyclesN : null,
      perExecutedTrade: executedTrades ? totalCostUsd / executedTrades : null,
      perProfitableTrade: profitableTrades ? totalCostUsd / profitableTrades : null,
    },
    rows,
  };
}
