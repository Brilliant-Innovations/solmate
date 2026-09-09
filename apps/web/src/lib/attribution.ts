import { loadTradeHistory, type Book, type TradeRow } from './history';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Attribution / Economic P&L (§20.16, §19.4, D37; §31 "economic P&L includes direct strategy and
 * shared platform operating costs"). Three layers over a period: trading P&L from closed lots
 * (gross, router fees, priority/network fees, transfer fees, slippage, net); strategy economic
 * P&L (net trading minus attributable model calls and a data/RPC share); platform economic P&L
 * (aggregate strategies minus shared subscriptions and hosting). Unit costs per candidate, action
 * cycle, executed trade and profitable trade. Costs come from the ledger (agents.runs cost_usd,
 * ops.provider_spend) and the recorded tiers in docs/costs.md; every assumption is labelled.
 *
 * The period is a window on `closed_at`: realized P&L belongs to the period it settled in, and the
 * model and provider costs it is netted against are drawn from the same window (review 2026-09-09,
 * M-19). Model cost is charged to `strategy × book` exactly once — a version trading in both books
 * used to be charged its full model cost twice (H-5).
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
  book: Book;
  trades: number;
  profitable: number;
  /** `null` when a token-denominated fee in any lot could not be priced. */
  grossUsdc: number | null;
  routerFeesUsdc: number | null;
  transferFeesUsdc: number | null;
  slippageUsdc: number;
  networkLamports: number;
  priorityLamports: number;
  networkPriorityUsd: number | null;
  netUsdc: number;
}

export interface StrategyEconomicRow {
  strategyVersionId: string;
  book: Book;
  /** `null` when SOL-denominated fees were paid and the SOL price is unknown. */
  netTradingUsd: number | null;
  modelUsd: number;
  /** Model cost of cycles whose book is known from the intent's account. */
  modelUsdDirect: number;
  /** Model cost of this strategy's cycles that never produced an intent, allocated across its books. */
  modelUsdAllocated: number;
  modelRuns: number;
  dataRpcShareUsd: number;
  contributionUsd: number | null;
}

export interface AttributionView {
  periodDays: number;
  from: string;
  to: string;
  solPriceUsd: number | null;
  trading: TradingPnlRow[];
  strategy: StrategyEconomicRow[];
  platform: {
    aggregateContributionUsd: number | null;
    subscriptionsUsd: number;
    subscriptions: { provider: string; tier: string; monthlyUsd: number; periodUsd: number; note: string }[];
    dataUsageUsd: number;
    providerSpend: { provider: string; month: string; usedCu: number; estimatedUsd: number; periodUsd: number; coveredDays: number; monthDays: number }[];
    hostingUsd: number;
    finalOperatingResultUsd: number | null;
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
  /** Sub-queries that failed anywhere below this view; non-empty means the numbers are incomplete. */
  problems: string[];
  /** True when the lot scan was cut short, so the trading layer is a prefix of the period. */
  truncated: boolean;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

/** UTC months touched by [from, to], built from month starts so a 31st never skips a month. */
export function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const lastY = to.getUTCFullYear();
  const lastM = to.getUTCMonth();
  while (y < lastY || (y === lastY && m <= lastM)) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/** Days of `month` (YYYY-MM) that fall inside [from, to], and the month's own length. */
export function monthOverlapDays(month: string, from: Date, to: Date): { covered: number; monthDays: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  const monthDays = (end - start) / 86_400_000;
  const covered = Math.max(0, Math.min(end, to.getTime()) - Math.max(start, from.getTime())) / 86_400_000;
  return { covered, monthDays };
}

export async function loadAttribution(periodDays: number): Promise<AttributionView> {
  const to = new Date();
  const from = new Date(to.getTime() - periodDays * 86_400_000);
  const supabase = await createSupabaseServerClient();
  const history = await loadTradeHistory({ strategy: '', book: '', result: '', exitReason: '', path: '', regime: '', family: '', verdict: '', symbol: '', from: '', to: '', closedFrom: from.toISOString(), closedTo: to.toISOString(), includeOpen: false, limit: 2000 });
  const rows = history.rows;
  const problems = [...history.problems];
  const months = monthsBetween(from, to);

  const [runs, spend, candidates, cycles, sol] = supabase
    ? await Promise.all([
        supabase.schema('agents').from('runs').select('action_cycle_id, cost_usd, created_at').gte('created_at', from.toISOString()).lte('created_at', to.toISOString()).limit(5000),
        supabase.schema('ops').from('provider_spend').select('provider, month, used_cu').in('month', months),
        supabase.schema('signals').from('candidates').select('id', { count: 'exact', head: true }).gte('discovered_at', from.toISOString()).lte('discovered_at', to.toISOString()),
        supabase.schema('agents').from('action_cycles').select('id', { count: 'exact', head: true }).gte('started_at', from.toISOString()).lte('started_at', to.toISOString()),
        supabase.schema('signals').from('scanner').select('price_usd').eq('mint', 'So11111111111111111111111111111111111111112').maybeSingle(),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { count: 0, error: null }, { count: 0, error: null }, { data: null, error: null }];
  for (const [label, res] of [['model runs', runs], ['provider spend', spend], ['candidate count', candidates], ['action-cycle count', cycles], ['SOL price', sol]] as const) {
    const e = (res as { error?: { message: string } | null }).error;
    if (e) problems.push(`${label}: ${e.message}`);
  }
  const runRows = (runs.data as { action_cycle_id: string | null; cost_usd: number }[] | null) ?? [];
  const cycleIds = [...new Set(runRows.map((r) => r.action_cycle_id).filter((x): x is string => !!x))];

  // A cycle's book is the mode of the account its intent charged. Cycles that never produced an
  // intent (rejected candidates, the bulk of model spend) have a strategy but no book.
  const cycleStrategy = new Map<string, string>();
  const cycleBook = new Map<string, Book>();
  if (supabase && cycleIds.length) {
    const cyc: { id: string; strategy_version_id: string; intent_id: string | null }[] = [];
    for (let i = 0; i < cycleIds.length; i += 120) {
      const { data, error } = await supabase.schema('agents').from('action_cycles').select('id, strategy_version_id, intent_id').in('id', cycleIds.slice(i, i + 120));
      if (error) problems.push(`cycle strategies: ${error.message}`);
      cyc.push(...((data as { id: string; strategy_version_id: string; intent_id: string | null }[] | null) ?? []));
    }
    for (const c of cyc) cycleStrategy.set(c.id, c.strategy_version_id);
    const intentIds = [...new Set(cyc.map((c) => c.intent_id).filter((x): x is string => !!x))];
    const intentAccount = new Map<string, string>();
    for (let i = 0; i < intentIds.length; i += 120) {
      const { data, error } = await supabase.schema('trading').from('intents').select('id, account_id').in('id', intentIds.slice(i, i + 120));
      if (error) problems.push(`cycle intents: ${error.message}`);
      for (const x of (data as { id: string; account_id: string }[] | null) ?? []) intentAccount.set(x.id, x.account_id);
    }
    const accountIds = [...new Set([...intentAccount.values()])];
    const accountMode = new Map<string, Book>();
    for (let i = 0; i < accountIds.length; i += 120) {
      const { data, error } = await supabase.schema('trading').from('accounts').select('id, mode').in('id', accountIds.slice(i, i + 120));
      if (error) problems.push(`cycle accounts: ${error.message}`);
      for (const a of (data as { id: string; mode: Book }[] | null) ?? []) accountMode.set(a.id, a.mode);
    }
    for (const c of cyc) {
      const acc = c.intent_id ? intentAccount.get(c.intent_id) : undefined;
      const mode = acc ? accountMode.get(acc) : undefined;
      if (mode) cycleBook.set(c.id, mode);
    }
  }
  const solPriceUsd = typeof (sol.data as { price_usd?: number | null } | null)?.price_usd === 'number' ? ((sol.data as { price_usd: number }).price_usd as number) : null;

  const tradingBy = new Map<string, TradingPnlRow>();
  for (const r of rows) {
    const key = `${r.strategyVersionId}|${r.book}`;
    const t = tradingBy.get(key) ?? { strategyVersionId: r.strategyVersionId, book: r.book, trades: 0, profitable: 0, grossUsdc: 0 as number | null, routerFeesUsdc: 0 as number | null, transferFeesUsdc: 0 as number | null, slippageUsdc: 0, networkLamports: 0, priorityLamports: 0, networkPriorityUsd: null, netUsdc: 0 };
    const realized = Number(r.realizedPnlBaseUnits) / 1e6;
    t.trades++;
    if (realized > 0) t.profitable++;
    t.grossUsdc = add(t.grossUsdc, add(add(realized, r.fees.routerSettlement), r.fees.transferSettlement));
    t.routerFeesUsdc = add(t.routerFeesUsdc, r.fees.routerSettlement);
    t.transferFeesUsdc = add(t.transferFeesUsdc, r.fees.transferSettlement);
    t.slippageUsdc += r.slippageSettlement;
    t.networkLamports += r.fees.networkLamports;
    t.priorityLamports += r.fees.priorityLamports;
    t.netUsdc += realized;
    tradingBy.set(key, t);
  }
  const trading = [...tradingBy.values()]
    .map((t) => ({ ...t, networkPriorityUsd: solPriceUsd === null ? null : ((t.networkLamports + t.priorityLamports) / 1e9) * solPriceUsd }))
    .sort((a, b) => (a.strategyVersionId === b.strategyVersionId ? (a.book < b.book ? -1 : 1) : a.strategyVersionId < b.strategyVersionId ? -1 : 1));

  // Model cost: direct where the cycle's book is known, per-strategy where it is not, and
  // unattributed where even the strategy is unknown. Nothing is counted twice.
  const modelDirect = new Map<string, { usd: number; runs: number }>();
  const modelUnbooked = new Map<string, { usd: number; runs: number }>();
  const modelUnattributed = { usd: 0, runs: 0 };
  for (const r of runRows) {
    const s = r.action_cycle_id ? cycleStrategy.get(r.action_cycle_id) : undefined;
    if (!s) {
      modelUnattributed.usd += r.cost_usd;
      modelUnattributed.runs++;
      continue;
    }
    const book = r.action_cycle_id ? cycleBook.get(r.action_cycle_id) : undefined;
    const bucket = book ? modelDirect : modelUnbooked;
    const key = book ? `${s}|${book}` : s;
    const m = bucket.get(key) ?? { usd: 0, runs: 0 };
    m.usd += r.cost_usd;
    m.runs++;
    bucket.set(key, m);
  }

  const providerSpend = ((spend.data as { provider: string; month: string; used_cu: number }[] | null) ?? []).map((p) => {
    const { covered, monthDays } = monthOverlapDays(p.month, from, to);
    const estimatedUsd = p.provider.toLowerCase() === 'birdeye' ? Number(p.used_cu) * BIRDEYE_USD_PER_CU : 0;
    // A month row is a whole-month total; only the part of it inside the window belongs to this period.
    return { provider: p.provider, month: p.month, usedCu: Number(p.used_cu), estimatedUsd, periodUsd: estimatedUsd * (covered / monthDays), coveredDays: covered, monthDays };
  });
  const dataUsageUsd = sum(providerSpend.map((p) => p.periodUsd));

  // Allocation weights, not measurements: an unpriced gross falls back to realized so a lot with an
  // unknown fee still carries weight rather than disappearing from the share.
  const weightOf = (t: TradingPnlRow) => Math.abs(t.grossUsdc ?? t.netUsdc) + (t.routerFeesUsdc ?? 0);
  const turnoverTotal = sum(trading.map(weightOf));
  const booksByStrategy = new Map<string, TradingPnlRow[]>();
  for (const t of trading) booksByStrategy.set(t.strategyVersionId, [...(booksByStrategy.get(t.strategyVersionId) ?? []), t]);

  const strategy: StrategyEconomicRow[] = trading.map((t) => {
    const direct = modelDirect.get(`${t.strategyVersionId}|${t.book}`) ?? { usd: 0, runs: 0 };
    const unbooked = modelUnbooked.get(t.strategyVersionId) ?? { usd: 0, runs: 0 };
    const siblings = booksByStrategy.get(t.strategyVersionId) ?? [t];
    // Split this strategy's book-less model cost across its books by direct model spend, falling
    // back to trade count and then to an even split. The total is conserved either way.
    const directTotal = sum(siblings.map((s) => (modelDirect.get(`${s.strategyVersionId}|${s.book}`)?.usd ?? 0)));
    const tradeTotal = sum(siblings.map((s) => s.trades));
    const share = directTotal > 0 ? direct.usd / directTotal : tradeTotal > 0 ? t.trades / tradeTotal : 1 / siblings.length;
    const allocated = unbooked.usd * share;
    const allocatedRuns = Math.round(unbooked.runs * share);
    const netTradingUsd = t.networkLamports + t.priorityLamports === 0 ? t.netUsdc : t.networkPriorityUsd === null ? null : t.netUsdc - t.networkPriorityUsd;
    const dataShare = trading.length ? (turnoverTotal > 0 ? (dataUsageUsd * weightOf(t)) / turnoverTotal : dataUsageUsd / trading.length) : 0;
    const modelUsd = direct.usd + allocated;
    return {
      strategyVersionId: t.strategyVersionId,
      book: t.book,
      netTradingUsd,
      modelUsd,
      modelUsdDirect: direct.usd,
      modelUsdAllocated: allocated,
      modelRuns: direct.runs + allocatedRuns,
      dataRpcShareUsd: dataShare,
      contributionUsd: netTradingUsd === null ? null : netTradingUsd - modelUsd - dataShare,
    };
  });

  const subscriptions = PLATFORM_SUBSCRIPTIONS.map((s) => ({ ...s, periodUsd: (s.monthlyUsd * periodDays) / 30 }));
  const subscriptionsUsd = sum(subscriptions.map((s) => s.periodUsd));
  const contributionTotal = strategy.reduce<number | null>((a, s) => add(a, s.contributionUsd), 0);
  const aggregateContributionUsd = contributionTotal === null ? null : contributionTotal - modelUnattributed.usd;
  const hostingUsd = 0;
  const finalOperatingResultUsd = aggregateContributionUsd === null ? null : aggregateContributionUsd - subscriptionsUsd - hostingUsd;
  const executedTrades = rows.length;
  const profitableTrades = rows.filter((r) => Number(r.realizedPnlBaseUnits) > 0).length;
  const totalCostUsd = sum(strategy.map((s) => s.modelUsd + s.dataRpcShareUsd)) + modelUnattributed.usd + subscriptionsUsd + hostingUsd;
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
    problems,
    truncated: history.truncated,
  };
}
