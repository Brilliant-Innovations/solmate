import { createSupabaseServerClient } from './supabase/server';

/**
 * Trade History (§20.10): every closed strategy lot with its entry and exit fills, fee breakdown,
 * shortfall, execution path, the action cycles that produced and closed it, the candidate's
 * family and regime, proposer confidence and adversary verdict, and the versions it ran under.
 * Filterable and exportable; every row drills into the Action Inspector. Ledger facts under RLS,
 * paper and live labelled from `trading.accounts.mode` — never from an account name.
 *
 * Two rules this file exists to keep (adversarial review 2026-09-09, H-2/H-3/H-4):
 *  - A value that could not be loaded is `null` or `UNKNOWN`, never a plausible zero. Every
 *    sub-query error is captured into `problems` and surfaced by the page.
 *  - The row count the operator reads is either complete or explicitly marked truncated. Filters
 *    that cannot be expressed in SQL run over a paginated scan, not over one already-cut page.
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

/** `UNKNOWN` when the lot's account could not be read; the operator must never see a guess here. */
export type Book = 'PAPER' | 'LIVE' | 'UNKNOWN';

export interface TradeRow {
  lotId: string;
  positionId: string;
  accountId: string;
  book: Book;
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
  /** Settlement-denominated fees are `null` when a token-denominated fee could not be priced. */
  fees: { networkLamports: number; priorityLamports: number; routerSettlement: number | null; transferSettlement: number | null };
  slippageSettlement: number;
  entryShortfallBps: number | null;
  executionPaths: string[];
  entryCycleId: string | null;
  exitCycleIds: string[];
  exitReason: string | null;
  /** `LOT` when the closing intent named this lot; `POSITION` when only the position could be matched. */
  exitReasonScope: 'LOT' | 'POSITION' | null;
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
  /** Window on `closed_at` rather than `opened_at`; realized P&L belongs to the period it settled in. */
  closedFrom?: string;
  closedTo?: string;
  includeOpen: boolean;
  limit: number;
}

export interface TradeHistoryResult {
  rows: TradeRow[];
  /** Sub-queries that failed. Non-empty means the rows are incomplete and the page must say so. */
  problems: string[];
  /** Lots read from SQL before the in-process filters ran. */
  scanned: number;
  /** More lots match the SQL filters than were scanned; the result is a prefix, not the whole set. */
  truncated: boolean;
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
/** Adds with null propagation: an unpriced component makes the total unknown, not smaller. */
const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

type QueryResult = { data: unknown; error: { message: string } | null };

/**
 * PostgREST encodes `in.(…)` into the request URL at ~37 bytes per uuid, so a single page of 300
 * lots with two fills each is ~22 KB of query string — past common gateway limits, and the failure
 * arrives as a discarded error rather than a missing row. Chunk every id list.
 */
const IN_CHUNK = 120;

function take<T>(res: QueryResult, label: string, problems: string[]): T[] {
  if (res.error) {
    problems.push(`${label}: ${res.error.message}`);
    return [];
  }
  return (res.data as T[] | null) ?? [];
}

async function inChunks<T>(ids: readonly string[], label: string, problems: string[], run: (chunk: string[]) => PromiseLike<QueryResult>): Promise<T[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) chunks.push(ids.slice(i, i + IN_CHUNK));
  const results = await Promise.all(chunks.map((c) => run(c)));
  return results.flatMap((r) => take<T>(r, label, problems));
}

interface LotRow {
  id: string;
  position_id: string;
  sleeve_id: string;
  strategy_version_id: string;
  asset_id: string;
  quantity: string;
  cost_basis_base_units: string;
  entry_intent_id: string;
  entry_fill_ids: string[] | null;
  exit_fill_ids: string[] | null;
  realized_pnl_base_units: string;
  status: 'OPEN' | 'CLOSED';
  opened_at: string;
  closed_at: string | null;
}

const LOT_COLUMNS = 'id, position_id, sleeve_id, strategy_version_id, asset_id, quantity, cost_basis_base_units, entry_intent_id, entry_fill_ids, exit_fill_ids, realized_pnl_base_units, status, opened_at, closed_at';

type Supabase = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

async function enrichLots(supabase: Supabase, lots: LotRow[], problems: string[]): Promise<TradeRow[]> {
  const positionIds = [...new Set(lots.map((l) => l.position_id))];
  const assetIds = [...new Set(lots.map((l) => l.asset_id))];
  const fillIds = [...new Set(lots.flatMap((l) => [...(l.entry_fill_ids ?? []), ...(l.exit_fill_ids ?? [])]))];
  const intentIds = [...new Set(lots.map((l) => l.entry_intent_id).filter((x): x is string => !!x))];
  const lotIds = new Set(lots.map((l) => l.id));

  type PositionRow = { id: string; account_id: string; opened_at: string; closed_at: string | null };
  type AssetRow = { id: string; symbol: string; decimals: number };
  type FillRow = { id: string; tx_signature: string; input_mint: string; output_mint: string; input_amount: string; output_amount: string; fees: Record<string, unknown>; execution_shortfall_bps: number | null; execution_path: string; filled_at: string };
  type IntentRow = { id: string; action_cycle_id: string; account_id: string };
  type ExitCycleRow = { id: string; position_id: string; proposed_action: string | null; reason_codes: string[] | null; intent_id: string | null };

  const [positions, assets, fills, intents, exitCycles] = await Promise.all([
    inChunks<PositionRow>(positionIds, 'positions', problems, (c) => supabase.schema('trading').from('positions').select('id, account_id, opened_at, closed_at').in('id', c)),
    inChunks<AssetRow>(assetIds, 'assets', problems, (c) => supabase.schema('core').from('assets').select('id, symbol, decimals').in('id', c)),
    inChunks<FillRow>(fillIds, 'fills', problems, (c) => supabase.schema('trading').from('fills').select('id, tx_signature, input_mint, output_mint, input_amount, output_amount, fees, execution_shortfall_bps, execution_path, filled_at').in('id', c)),
    inChunks<IntentRow>(intentIds, 'entry intents', problems, (c) => supabase.schema('trading').from('intents').select('id, action_cycle_id, account_id').in('id', c)),
    inChunks<ExitCycleRow>(positionIds, 'exit action cycles', problems, (c) => supabase.schema('agents').from('action_cycles').select('id, position_id, proposed_action, reason_codes, intent_id, started_at').in('position_id', c).not('intent_id', 'is', null).order('started_at', { ascending: true })),
  ]);

  const intentById = new Map(intents.map((i) => [i.id, i]));
  const positionById = new Map(positions.map((p) => [p.id, p]));
  const entryCycleIds = [...new Set([...intentById.values()].map((i) => i.action_cycle_id))];
  const accountIds = [...new Set([...[...intentById.values()].map((i) => i.account_id), ...positions.map((p) => p.account_id)])];
  const exitIntentIds = [...new Set(exitCycles.map((c) => c.intent_id).filter((x): x is string => !!x))];

  type CycleRow = { id: string; candidate_id: string | null; verdict: string | null; speed_tier: string; skill_version_id: string | null; guideline_version_id: string | null };
  type ProposalRow = { action_cycle_id: string; proposal: Record<string, unknown> | null };
  type AccountRow = { id: string; name: string; mode: 'LIVE' | 'PAPER' };
  type ExitIntentRow = { id: string; target_lot_ids: string[] | null };

  const [cycles, proposals, accounts, exitIntents] = await Promise.all([
    inChunks<CycleRow>(entryCycleIds, 'entry action cycles', problems, (c) => supabase.schema('agents').from('action_cycles').select('id, candidate_id, verdict, speed_tier, skill_version_id, guideline_version_id').in('id', c)),
    inChunks<ProposalRow>(entryCycleIds, 'proposals', problems, (c) => supabase.schema('trading').from('proposals').select('action_cycle_id, proposal').in('action_cycle_id', c)),
    inChunks<AccountRow>(accountIds, 'accounts', problems, (c) => supabase.schema('trading').from('accounts').select('id, name, mode').in('id', c)),
    inChunks<ExitIntentRow>(exitIntentIds, 'exit intents', problems, (c) => supabase.schema('trading').from('intents').select('id, target_lot_ids').in('id', c)),
  ]);

  const cycleById = new Map(cycles.map((c) => [c.id, c]));
  const candidateIds = [...new Set([...cycleById.values()].map((c) => c.candidate_id).filter((x): x is string => !!x))];
  type CandidateRow = { id: string; trigger_family: string; trigger_details: Record<string, unknown> | null; scanner_score: number | null };
  const candidates = await inChunks<CandidateRow>(candidateIds, 'candidates', problems, (c) => supabase.schema('signals').from('candidates').select('id, trigger_family, trigger_details, scanner_score').in('id', c));
  const candidateById = new Map(candidates.map((c) => [c.id, c]));

  const confidenceByCycle = new Map<string, number | null>();
  for (const p of proposals) {
    const c = p.proposal?.['confidence'];
    if (!confidenceByCycle.has(p.action_cycle_id)) confidenceByCycle.set(p.action_cycle_id, typeof c === 'number' ? c : null);
  }
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const fillById = new Map(fills.map((x) => [x.id, x]));
  const targetLotsByIntent = new Map(exitIntents.map((i) => [i.id, i.target_lot_ids ?? []]));

  // An exit intent names the lots it closes (`trading.intents.target_lot_ids`), so an exit reason is
  // lot-scoped whenever that array is populated. Only when it is empty does the position-level cycle
  // stand in for every lot of the position, and the row says so through `exitReasonScope`.
  type ExitCycle = { id: string; reason_codes: string[]; proposed_action: string | null };
  const exitByLot = new Map<string, ExitCycle[]>();
  const exitByPosition = new Map<string, ExitCycle[]>();
  for (const c of exitCycles) {
    const e: ExitCycle = { id: c.id, reason_codes: c.reason_codes ?? [], proposed_action: c.proposed_action };
    const targets = (c.intent_id ? targetLotsByIntent.get(c.intent_id) : undefined) ?? [];
    const named = targets.filter((id) => lotIds.has(id));
    if (named.length) for (const id of named) exitByLot.set(id, [...(exitByLot.get(id) ?? []), e]);
    else exitByPosition.set(c.position_id, [...(exitByPosition.get(c.position_id) ?? []), e]);
  }

  return lots.map((l) => {
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
    // A token-denominated fee is valued at the price of its own leg: entry fees at the entry price,
    // exit fees at the exit price. A zero fee needs no price; an unpriced non-zero fee is unknown.
    const valueToken = (tokenBase: number, price: number | null): number | null => (tokenBase === 0 ? 0 : price === null ? null : (tokenBase / 10 ** decimals) * price);
    const routerSettlement = entryFills.reduce<number | null>((a, x) => add(a, n(x.fees.router) / 1e6), 0);
    const routerTotal = exitFills.reduce<number | null>((a, x) => add(a, valueToken(n(x.fees.router), exitPrice)), routerSettlement);
    const transferSettlement = entryFills.reduce<number | null>((a, x) => add(a, valueToken(n(x.fees.transfer), entryPrice)), 0);
    const transferTotal = exitFills.reduce<number | null>((a, x) => add(a, n(x.fees.transfer) / 1e6), transferSettlement);
    const slippage = entryFills.reduce((a, x) => a + Math.max(0, x.execution_shortfall_bps ?? 0) * (n(x.input_amount) / 1e6) / 10_000, 0) + exitFills.reduce((a, x) => a + Math.max(0, x.execution_shortfall_bps ?? 0) * (n(x.output_amount) / 1e6) / 10_000, 0);
    const intent = intentById.get(l.entry_intent_id);
    const cycle = intent ? cycleById.get(intent.action_cycle_id) : undefined;
    const cand = cycle?.candidate_id ? candidateById.get(cycle.candidate_id) : undefined;
    const details = (cand?.trigger_details ?? {}) as Record<string, unknown>;
    const position = positionById.get(l.position_id);
    const accountId = intent?.account_id ?? position?.account_id ?? '';
    const account = accountId ? accountById.get(accountId) : undefined;
    const lotExits = exitByLot.get(l.id);
    const exits = lotExits ?? exitByPosition.get(l.position_id) ?? [];
    const scope: 'LOT' | 'POSITION' | null = lotExits ? 'LOT' : exits.length ? 'POSITION' : null;
    const lastExit = exits.filter((c) => c.proposed_action === 'EXIT' || c.proposed_action === 'REDUCE').slice(-1)[0] ?? null;
    return {
      lotId: l.id,
      positionId: l.position_id,
      accountId,
      // `trading.accounts.mode` is the authority (immutable, enum, defaults to LIVE). An unread
      // account is UNKNOWN — never PAPER, which is what an account-name heuristic used to guess.
      book: account ? account.mode : 'UNKNOWN',
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
      fees: { networkLamports: [...entryFills, ...exitFills].reduce((a, x) => a + n(x.fees.network), 0), priorityLamports: [...entryFills, ...exitFills].reduce((a, x) => a + n(x.fees.priority), 0), routerSettlement: routerTotal, transferSettlement: transferTotal },
      slippageSettlement: slippage,
      entryShortfallBps: entryFills[0]?.execution_shortfall_bps ?? null,
      executionPaths: [...new Set([...entryFills, ...exitFills].map((x) => x.execution_path))],
      entryCycleId: intent?.action_cycle_id ?? null,
      exitCycleIds: exits.map((c) => c.id),
      exitReason: lastExit ? (lastExit.reason_codes[lastExit.reason_codes.length - 1] ?? lastExit.proposed_action) : l.status === 'CLOSED' ? 'UNKNOWN' : null,
      exitReasonScope: scope,
      candidate: cand ? { family: cand.trigger_family, regime: typeof details['regime'] === 'string' ? (details['regime'] as string) : null, scannerScore: cand.scanner_score, sessions: Array.isArray(details['marketSessions']) ? (details['marketSessions'] as string[]) : [] } : null,
      proposerConfidence: intent ? (confidenceByCycle.get(intent.action_cycle_id) ?? null) : null,
      adversaryVerdict: cycle?.verdict ?? null,
      speedTier: cycle?.speed_tier ?? null,
      skillVersionId: cycle?.skill_version_id ?? null,
      guidelineVersionId: cycle?.guideline_version_id ?? null,
      holdMs: l.closed_at ? Date.parse(l.closed_at) - Date.parse(l.opened_at) : null,
    };
  });
}

function matchesInProcess(r: TradeRow, f: TradeFilters): boolean {
  if (f.book && r.book !== f.book) return false;
  if (f.exitReason && r.exitReason !== f.exitReason) return false;
  if (f.path && !r.executionPaths.includes(f.path)) return false;
  if (f.regime && r.candidate?.regime !== f.regime) return false;
  if (f.family && r.candidate?.family !== f.family) return false;
  if (f.verdict && r.adversaryVerdict !== f.verdict) return false;
  return true;
}

export async function loadTradeHistory(f: TradeFilters): Promise<TradeHistoryResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { rows: [], problems: ['no Supabase session; sign in to read the ledger'], scanned: 0, truncated: false };
  const problems: string[] = [];

  // `symbol` resolves to asset ids, so it can be pushed into SQL like `status`, `strategy`, the
  // date window and `result`. The remaining six filters need joined data and run in process, which
  // is why the scan below is paginated rather than a single already-cut page (H-4).
  let assetIdFilter: string[] | null = null;
  if (f.symbol) {
    const res = await supabase.schema('core').from('assets').select('id').ilike('symbol', f.symbol);
    assetIdFilter = take<{ id: string }>(res, 'symbol lookup', problems).map((a) => a.id);
    if (assetIdFilter.length === 0) return { rows: [], problems, scanned: 0, truncated: false };
  }

  const inProcessFilterActive = !!(f.book || f.exitReason || f.path || f.regime || f.family || f.verdict);
  const pageSize = inProcessFilterActive ? Math.max(f.limit, 500) : f.limit;
  // Scanning is bounded so a filter that matches nothing cannot walk the whole ledger; the bound is
  // reported as `truncated`, which is the only honest answer for "are there more?".
  const maxScan = inProcessFilterActive ? Math.max(f.limit * 5, 2500) : f.limit;

  const rows: TradeRow[] = [];
  let scanned = 0;
  // `truncated` answers "could there be more?" — it is false only when a short page proved the
  // source was exhausted. Stopping on the row limit or on the scan bound both leave it true.
  let exhausted = false;
  for (let offset = 0; offset < maxScan; offset += pageSize) {
    const size = Math.min(pageSize, maxScan - offset);
    let q = supabase.schema('trading').from('position_lots').select(LOT_COLUMNS).order('opened_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + size - 1);
    if (!f.includeOpen) q = q.eq('status', 'CLOSED');
    if (f.strategy) q = q.eq('strategy_version_id', f.strategy);
    if (f.from) q = q.gte('opened_at', new Date(f.from).toISOString());
    if (f.to) q = q.lte('opened_at', new Date(f.to).toISOString());
    if (f.closedFrom) q = q.gte('closed_at', new Date(f.closedFrom).toISOString());
    if (f.closedTo) q = q.lte('closed_at', new Date(f.closedTo).toISOString());
    if (assetIdFilter) q = q.in('asset_id', assetIdFilter);
    if (f.result === 'win') q = q.gt('realized_pnl_base_units', 0);
    if (f.result === 'loss') q = q.lte('realized_pnl_base_units', 0).eq('status', 'CLOSED');
    const res = (await q) as QueryResult;
    if (res.error) {
      problems.push(`position lots: ${res.error.message}`);
      return { rows, problems, scanned, truncated: true };
    }
    const page = ((res.data as LotRow[] | null) ?? []);
    scanned += page.length;
    if (page.length < size) exhausted = true;
    if (page.length === 0) break;
    const enriched = await enrichLots(supabase, page, problems);
    for (const r of enriched) if (matchesInProcess(r, f)) rows.push(r);
    if (exhausted || rows.length >= f.limit) break;
  }
  return { rows: rows.slice(0, f.limit), problems, scanned, truncated: !exhausted };
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
  ['exit_reason_scope', (r) => r.exitReasonScope],
  ['candidate_family', (r) => r.candidate?.family ?? null],
  ['regime', (r) => r.candidate?.regime ?? null],
  ['scanner_score', (r) => r.candidate?.scannerScore ?? null],
  ['proposer_confidence', (r) => r.proposerConfidence],
  ['adversary_verdict', (r) => r.adversaryVerdict],
  ['entry_tx', (r) => r.entryFills.map((x) => x.tx_signature).join('|')],
  ['exit_tx', (r) => r.exitFills.map((x) => x.tx_signature).join('|')],
];

/**
 * Token symbols come from provider metadata a token deployer controls, so a cell that a spreadsheet
 * would evaluate is an injection into the operator's machine. Neutralise the leading characters
 * Excel, LibreOffice and Sheets treat as formula starts, then quote for CSV.
 */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  const raw = String(v);
  const neutralised = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /["',\n\r\t]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

export function tradesToCsv(rows: readonly TradeRow[]): string {
  return [CSV_COLUMNS.map(([h]) => h).join(','), ...rows.map((r) => CSV_COLUMNS.map(([, g]) => csvCell(g(r))).join(','))].join('\n') + '\n';
}

export const EXIT_REASONS = ['HARD_STOP', 'TIME_STOP', 'TARGET_REACHED', 'PARTIAL_TIER', 'TRAILING_STOP', 'SESSION_WIND_DOWN', 'SAFETY_CRITICAL_EXIT', 'SAFETY_EXIT_RECOMMENDED', 'MANUAL_CLOSE', 'MANUAL_REDUCE', 'EMERGENCY_CLOSE_ALL', 'AGENT_EXIT'];
