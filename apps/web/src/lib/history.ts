import { createSupabaseServerClient } from './supabase/server';

/**
 * Trade History (§20.10): every closed strategy lot with its entry and exit fills, fee breakdown,
 * shortfall, execution path, the action cycles that produced and closed it, the candidate's
 * family and regime, proposer confidence and adversary verdict, and the versions it ran under.
 * Filterable and exportable; every row drills into the Action Inspector. Ledger facts under RLS,
 * paper and live labelled by account.
 */

export interface FillLite {
  id: string;
  side: 'ENTRY' | 'EXIT';
  filled_at: string;
  input_amount: string;
  output_amount: string;
  execution_shortfall_bps: number | null;
  execution_path: string;
  tx_signature: string;
  fees: { network: string; priority: string; router: string; transfer: string };
}

export interface TradeRow {
  lotId: string;
  positionId: string;
  accountId: string;
  book: 'PAPER' | 'LIVE';
  assetId: string;
  symbol: string;
  decimals: number;
  strategyVersionId: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  quantity: string;
  costBasisBaseUnits: string;
  realizedPnlBaseUnits: string;
  proceedsBaseUnits: string;
  entryFills: FillLite[];
  exitFills: FillLite[];
  fees: { networkLamports: number; priorityLamports: number; routerSettlement: number; transferSettlement: number };
  slippageSettlement: number;
  entryShortfallBps: number | null;
  executionPaths: string[];
  entryCycleId: string | null;
  exitCycleIds: string[];
  exitReason: string | null;
  candidate: { family: string; regime: string | null; scannerScore: number | null; sessions: string[] } | null;
  proposerConfidence: number | null;
  adversaryVerdict: string | null;
  speedTier: string | null;
  skillVersionId: string | null;
  guidelineVersionId: string | null;
  holdMs: number | null;
}

export interface TradeFilters {
  strategy: string;
  book: '' | 'PAPER' | 'LIVE';
  result: '' | 'win' | 'loss';
  exitReason: string;
  path: string;
  regime: string;
  family: string;
  verdict: string;
  symbol: string;
  from: string;
  to: string;
  includeOpen: boolean;
  limit: number;
}

export function parseTradeFilters(params: Record<string, string | string[] | undefined>): TradeFilters {
  const s = (k: string) => (typeof params[k] === 'string' ? (params[k] as string).trim() : '');
  const book = s('book');
  const result = s('result');
  const limit = Number(s('limit') || 300);
  return {
    strategy: s('strategy'),
    book: book === 'PAPER' || book === 'LIVE' ? book : '',
    result: result === 'win' || result === 'loss' ? result : '',
    exitReason: s('exit'),
    path: s('path'),
    regime: s('regime'),
    family: s('family'),
    verdict: s('verdict'),
    symbol: s('symbol').toUpperCase(),
    from: s('from'),
    to: s('to'),
    includeOpen: s('open') === '1',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 300,
  };
}

const n = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : 0);
const feeOf = (fees: Record<string, unknown> | null | undefined, key: string): string => {
  if (!fees) return '0';
  const v = fees[key] ?? fees[`${key}BaseUnits`] ?? fees[`${key}Lamports`];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '0';
};

export async function loadTradeHistory(f: TradeFilters): Promise<TradeRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  let q = supabase.schema('trading').from('position_lots').select('id, position_id, sleeve_id, strategy_version_id, asset_id, quantity, cost_basis_base_units, entry_intent_id, entry_fill_ids, exit_fill_ids, realized_pnl_base_units, status, opened_at, closed_at').order('opened_at', { ascending: false }).limit(f.limit);
  if (!f.includeOpen) q = q.eq('status', 'CLOSED');
  if (f.strategy) q = q.eq('strategy_version_id', f.strategy);
  if (f.from) q = q.gte('opened_at', new Date(f.from).toISOString());
  if (f.to) q = q.lte('opened_at', new Date(f.to).toISOString());
  const { data: lotsData } = await q;
  const lots = (lotsData as unknown as { id: string; position_id: string; sleeve_id: string; strategy_version_id: string; asset_id: string; quantity: string; cost_basis_base_units: string; entry_intent_id: string; entry_fill_ids: string[] | null; exit_fill_ids: string[] | null; realized_pnl_base_units: string; status: 'OPEN' | 'CLOSED'; opened_at: string; closed_at: string | null }[] | null) ?? [];
  if (lots.length === 0) return [];
  const positionIds = [...new Set(lots.map((l) => l.position_id))];
  const assetIds = [...new Set(lots.map((l) => l.asset_id))];
  const fillIds = [...new Set(lots.flatMap((l) => [...(l.entry_fill_ids ?? []), ...(l.exit_fill_ids ?? [])]))];
  const intentIds = [...new Set(lots.map((l) => l.entry_intent_id))];
  const [positions, assets, fills, intents, exitCycles] = await Promise.all([
    supabase.schema('trading').from('positions').select('id, account_id, opened_at, closed_at').in('id', positionIds),
    supabase.schema('core').from('assets').select('id, symbol, decimals').in('id', assetIds),
    fillIds.length ? supabase.schema('trading').from('fills').select('id, tx_signature, input_mint, output_mint, input_amount, output_amount, fees, execution_shortfall_bps, execution_path, filled_at').in('id', fillIds) : Promise.resolve({ data: [] }),
    supabase.schema('trading').from('intents').select('id, action_cycle_id, account_id').in('id', intentIds),
    supabase.schema('agents').from('action_cycles').select('id, position_id, proposed_action, reason_codes, intent_id, started_at').in('position_id', positionIds).not('intent_id', 'is', null).order('started_at', { ascending: true }),
  ]);
  const intentById = new Map(((intents.data as { id: string; action_cycle_id: string; account_id: string }[] | null) ?? []).map((i) => [i.id, i]));
  const entryCycleIds = [...new Set([...intentById.values()].map((i) => i.action_cycle_id))];
  const accountIds = [...new Set([...intentById.values()].map((i) => i.account_id))];
  const [cycles, proposals, accounts] = await Promise.all([
    entryCycleIds.length ? supabase.schema('agents').from('action_cycles').select('id, candidate_id, verdict, speed_tier, skill_version_id, guideline_version_id').in('id', entryCycleIds) : Promise.resolve({ data: [] }),
    entryCycleIds.length ? supabase.schema('trading').from('proposals').select('action_cycle_id, proposal').in('action_cycle_id', entryCycleIds) : Promise.resolve({ data: [] }),
    accountIds.length ? supabase.schema('trading').from('accounts').select('id, name').in('id', accountIds) : Promise.resolve({ data: [] }),
  ]);
  const cycleById = new Map(((cycles.data as { id: string; candidate_id: string | null; verdict: string | null; speed_tier: string; skill_version_id: string | null; guideline_version_id: string | null }[] | null) ?? []).map((c) => [c.id, c]));
  const candidateIds = [...new Set([...cycleById.values()].map((c) => c.candidate_id).filter((x): x is string => !!x))];
  const { data: candidatesData } = candidateIds.length ? await supabase.schema('signals').from('candidates').select('id, trigger_family, trigger_details, scanner_score').in('id', candidateIds) : { data: [] };
  const candidateById = new Map(((candidatesData as { id: string; trigger_family: string; trigger_details: Record<string, unknown>; scanner_score: number }[] | null) ?? []).map((c) => [c.id, c]));
  const confidenceByCycle = new Map<string, number | null>();
  for (const p of (proposals.data as { action_cycle_id: string; proposal: Record<string, unknown> }[] | null) ?? []) {
    const c = p.proposal?.['confidence'];
    if (!confidenceByCycle.has(p.action_cycle_id)) confidenceByCycle.set(p.action_cycle_id, typeof c === 'number' ? c : null);
  }
  const accountById = new Map(((accounts.data as { id: string; name: string }[] | null) ?? []).map((a) => [a.id, a]));
  const positionById = new Map(((positions.data as { id: string; account_id: string; opened_at: string; closed_at: string | null }[] | null) ?? []).map((p) => [p.id, p]));
  const assetById = new Map(((assets.data as { id: string; symbol: string; decimals: number }[] | null) ?? []).map((a) => [a.id, a]));
  const fillById = new Map(((fills.data as unknown as { id: string; tx_signature: string; input_mint: string; output_mint: string; input_amount: string; output_amount: string; fees: Record<string, unknown>; execution_shortfall_bps: number | null; execution_path: string; filled_at: string }[] | null) ?? []).map((x) => [x.id, x]));
  const exitCyclesByPosition = new Map<string, { id: string; reason_codes: string[]; proposed_action: string | null }[]>();
  for (const c of (exitCycles.data as { id: string; position_id: string; proposed_action: string | null; reason_codes: string[]; intent_id: string | null }[] | null) ?? []) exitCyclesByPosition.set(c.position_id, [...(exitCyclesByPosition.get(c.position_id) ?? []), { id: c.id, reason_codes: c.reason_codes ?? [], proposed_action: c.proposed_action }]);

  const rows: TradeRow[] = lots.map((l) => {
    const lite = (id: string, side: 'ENTRY' | 'EXIT'): FillLite | null => {
      const x = fillById.get(id);
      if (!x) return null;
      return { id: x.id, side, filled_at: x.filled_at, input_amount: x.input_amount, output_amount: x.output_amount, execution_shortfall_bps: x.execution_shortfall_bps, execution_path: x.execution_path, tx_signature: x.tx_signature, fees: { network: feeOf(x.fees, 'network'), priority: feeOf(x.fees, 'priority'), router: feeOf(x.fees, 'router'), transfer: feeOf(x.fees, 'transferFee') } };
    };
    const entryFills = (l.entry_fill_ids ?? []).map((id) => lite(id, 'ENTRY')).filter((x): x is FillLite => x !== null);
    const exitFills = (l.exit_fill_ids ?? []).map((id) => lite(id, 'EXIT')).filter((x): x is FillLite => x !== null);
    const proceeds = exitFills.reduce((a, x) => a + n(x.output_amount), 0);
    const asset = assetById.get(l.asset_id);
    const decimals = asset?.decimals ?? 6;
    const entryPrice = entryFills.length && n(entryFills[0]!.output_amount) > 0 ? (n(entryFills[0]!.input_amount) / 1e6) / (n(entryFills[0]!.output_amount) / 10 ** decimals) : null;
    const exitPrice = exitFills.length && n(exitFills[0]!.input_amount) > 0 ? (n(exitFills[0]!.output_amount) / 1e6) / (n(exitFills[0]!.input_amount) / 10 ** decimals) : entryPrice;
    const toSettlement = (tokenBase: number): number => (exitPrice !== null ? (tokenBase / 10 ** decimals) * exitPrice : 0);
    const routerSettlement = entryFills.reduce((a, x) => a + n(x.fees.router) / 1e6, 0) + exitFills.reduce((a, x) => a + toSettlement(n(x.fees.router)), 0);
    const transferSettlement = entryFills.reduce((a, x) => a + toSettlement(n(x.fees.transfer)), 0) + exitFills.reduce((a, x) => a + n(x.fees.transfer) / 1e6, 0);
    const slippage = entryFills.reduce((a, x) => a + Math.max(0, x.execution_shortfall_bps ?? 0) * (n(x.input_amount) / 1e6) / 10_000, 0) + exitFills.reduce((a, x) => a + Math.max(0, x.execution_shortfall_bps ?? 0) * (n(x.output_amount) / 1e6) / 10_000, 0);
    const intent = intentById.get(l.entry_intent_id);
    const cycle = intent ? cycleById.get(intent.action_cycle_id) : undefined;
    const cand = cycle?.candidate_id ? candidateById.get(cycle.candidate_id) : undefined;
    const details = (cand?.trigger_details ?? {}) as Record<string, unknown>;
    const position = positionById.get(l.position_id);
    const account = intent ? accountById.get(intent.account_id) : undefined;
    const exits = exitCyclesByPosition.get(l.position_id) ?? [];
    const lastExit = exits.filter((c) => c.proposed_action === 'EXIT' || c.proposed_action === 'REDUCE').slice(-1)[0] ?? null;
    return {
      lotId: l.id,
      positionId: l.position_id,
      accountId: intent?.account_id ?? position?.account_id ?? '',
      book: account?.name?.startsWith('paper') ? 'PAPER' : account ? 'LIVE' : 'PAPER',
      assetId: l.asset_id,
      symbol: asset?.symbol ?? l.asset_id.slice(0, 8),
      decimals,
      strategyVersionId: l.strategy_version_id,
      status: l.status,
      openedAt: l.opened_at,
      closedAt: l.closed_at,
      quantity: l.quantity,
      costBasisBaseUnits: l.cost_basis_base_units,
      realizedPnlBaseUnits: l.realized_pnl_base_units,
      proceedsBaseUnits: String(Math.round(proceeds)),
      entryFills,
      exitFills,
      fees: { networkLamports: [...entryFills, ...exitFills].reduce((a, x) => a + n(x.fees.network), 0), priorityLamports: [...entryFills, ...exitFills].reduce((a, x) => a + n(x.fees.priority), 0), routerSettlement, transferSettlement },
      slippageSettlement: slippage,
      entryShortfallBps: entryFills[0]?.execution_shortfall_bps ?? null,
      executionPaths: [...new Set([...entryFills, ...exitFills].map((x) => x.execution_path))],
      entryCycleId: intent?.action_cycle_id ?? null,
      exitCycleIds: exits.map((c) => c.id),
      exitReason: lastExit ? (lastExit.reason_codes[lastExit.reason_codes.length - 1] ?? lastExit.proposed_action) : l.status === 'CLOSED' ? 'UNKNOWN' : null,
      candidate: cand ? { family: cand.trigger_family, regime: typeof details['regime'] === 'string' ? (details['regime'] as string) : null, scannerScore: cand.scanner_score, sessions: Array.isArray(details['marketSessions']) ? (details['marketSessions'] as string[]) : [] } : null,
      proposerConfidence: intent ? (confidenceByCycle.get(intent.action_cycle_id) ?? null) : null,
      adversaryVerdict: cycle?.verdict ?? null,
      speedTier: cycle?.speed_tier ?? null,
      skillVersionId: cycle?.skill_version_id ?? null,
      guidelineVersionId: cycle?.guideline_version_id ?? null,
      holdMs: l.closed_at ? Date.parse(l.closed_at) - Date.parse(l.opened_at) : null,
    };
  });
  return rows.filter((r) => {
    if (f.book && r.book !== f.book) return false;
    if (f.result === 'win' && !(n(r.realizedPnlBaseUnits) > 0)) return false;
    if (f.result === 'loss' && !(n(r.realizedPnlBaseUnits) <= 0 && r.status === 'CLOSED')) return false;
    if (f.exitReason && r.exitReason !== f.exitReason) return false;
    if (f.path && !r.executionPaths.includes(f.path)) return false;
    if (f.regime && r.candidate?.regime !== f.regime) return false;
    if (f.family && r.candidate?.family !== f.family) return false;
    if (f.verdict && r.adversaryVerdict !== f.verdict) return false;
    if (f.symbol && r.symbol.toUpperCase() !== f.symbol) return false;
    return true;
  });
}

const CSV_COLUMNS: [string, (r: TradeRow) => string | number | null][] = [
  ['lot_id', (r) => r.lotId],
  ['position_id', (r) => r.positionId],
  ['account_id', (r) => r.accountId],
  ['book', (r) => r.book],
  ['symbol', (r) => r.symbol],
  ['asset_id', (r) => r.assetId],
  ['strategy_version_id', (r) => r.strategyVersionId],
  ['skill_version_id', (r) => r.skillVersionId],
  ['guideline_version_id', (r) => r.guidelineVersionId],
  ['speed_tier', (r) => r.speedTier],
  ['status', (r) => r.status],
  ['opened_at', (r) => r.openedAt],
  ['closed_at', (r) => r.closedAt],
  ['hold_ms', (r) => r.holdMs],
  ['quantity_base_units', (r) => r.quantity],
  ['cost_basis_base_units', (r) => r.costBasisBaseUnits],
  ['proceeds_base_units', (r) => r.proceedsBaseUnits],
  ['realized_pnl_base_units', (r) => r.realizedPnlBaseUnits],
  ['fees_network_lamports', (r) => r.fees.networkLamports],
  ['fees_priority_lamports', (r) => r.fees.priorityLamports],
  ['fees_router_settlement', (r) => r.fees.routerSettlement],
  ['fees_transfer_settlement', (r) => r.fees.transferSettlement],
  ['slippage_settlement', (r) => r.slippageSettlement],
  ['entry_shortfall_bps', (r) => r.entryShortfallBps],
  ['execution_paths', (r) => r.executionPaths.join('|')],
  ['entry_cycle_id', (r) => r.entryCycleId],
  ['exit_cycle_ids', (r) => r.exitCycleIds.join('|')],
  ['exit_reason', (r) => r.exitReason],
  ['candidate_family', (r) => r.candidate?.family ?? null],
  ['regime', (r) => r.candidate?.regime ?? null],
  ['scanner_score', (r) => r.candidate?.scannerScore ?? null],
  ['proposer_confidence', (r) => r.proposerConfidence],
  ['adversary_verdict', (r) => r.adversaryVerdict],
  ['entry_tx', (r) => r.entryFills.map((x) => x.tx_signature).join('|')],
  ['exit_tx', (r) => r.exitFills.map((x) => x.tx_signature).join('|')],
];

export function tradesToCsv(rows: readonly TradeRow[]): string {
  const esc = (v: string | number | null) => (v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [CSV_COLUMNS.map(([h]) => h).join(','), ...rows.map((r) => CSV_COLUMNS.map(([, g]) => esc(g(r))).join(','))].join('\n') + '\n';
}

export const EXIT_REASONS = ['HARD_STOP', 'TIME_STOP', 'TARGET_REACHED', 'PARTIAL_TIER', 'TRAILING_STOP', 'SESSION_WIND_DOWN', 'SAFETY_CRITICAL_EXIT', 'SAFETY_EXIT_RECOMMENDED', 'MANUAL_CLOSE', 'MANUAL_REDUCE', 'EMERGENCY_CLOSE_ALL', 'AGENT_EXIT'];
