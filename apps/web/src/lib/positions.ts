import { DEFAULT_EMERGENCY_ROUTE_POLICY } from '@sol-agent-trader/contracts';
import { loadCycles, type CycleView } from './cycles';
import type { CandleView } from './scanner';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Positions Workspace read models (§20.9). One row per position with its strategy lots, the
 * asset's latest mark and exit-route dry-run, the latest held-asset safety evaluation, the last
 * reassessment cycle and the next one due. Position detail adds lot allocation and protection
 * rule, thesis evolution across every cycle, fills, the safety history and chart inputs. Marks
 * come from the position monitor's executable exit quote; an unmarked position shows no
 * unrealized value rather than zero (§20.21).
 */

export interface LotView {
  id: string;
  strategy_version_id: string;
  sleeve_id: string;
  quantity: string;
  cost_basis_base_units: string;
  realized_pnl_base_units: string;
  protection_mode: string;
  provider_order_id: string | null;
  reserved_for_protection: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  entry_intent_id: string;
  entry_fill_ids: string[];
  exit_fill_ids: string[];
}

export interface SafetyView {
  evaluated_at: string;
  policy_version: string;
  state: string;
  previous_state: string | null;
  reasons: string[];
  triggers: string[];
  exit_compatibility: Record<string, unknown>;
  liquidity_usd: number | null;
  chain_slot: number;
}

export interface PositionRow {
  id: string;
  asset_id: string;
  symbol: string;
  decimals: number;
  mint: string;
  quantity: string;
  average_entry_price: number | null;
  cost_basis_base_units: string;
  realized_pnl_base_units: string;
  unrealized_pnl_base_units: string | null;
  stop: { model?: string; level?: number | null; distanceFraction?: number } | null;
  target: { policy?: string; parameters?: Record<string, unknown> } | null;
  unreviewed_stop: number | null;
  custody_split: { custodyAccountId: string; quantity: string }[];
  status: string;
  review_state: string;
  review_state_reason: string | null;
  review_state_since: string;
  last_reviewed_cycle_id: string | null;
  next_reassessment_at: string | null;
  safety_state: string;
  opened_at: string;
  closed_at: string | null;
  lots: LotView[];
  /** Latest mark and route facts from the scanner view. */
  price_usd: number | null;
  snapshot_at: string | null;
  route_dry_run: { at: string; ok: boolean; error: string | null; simulatedOutputAmount: string | null } | null;
  route_hops: { program?: string; pool?: string }[] | null;
  price_impact_probes: { sizeUsd: number; impactBps: number | null; routeFound: boolean; probedAt: string }[] | null;
  safety: SafetyView | null;
  lastCycle: CycleView | null;
  /** Expected holding horizon of the entry proposal, minutes; null when the entry cycle is unknown. */
  expected_horizon_minutes: number | null;
  /** Latest executable exit quote impact for this asset (market.quote_probes EXIT_MARK). */
  exit_quote: { quoted_at: string; price_impact_bps: number | null; expected_output_amount: string; input_amount: string; router_label: string | null } | null;
  custody: { id: string; kind: string; address: string }[];
}

export type DryRunState = 'OK' | 'FAILED' | 'STALE' | 'NONE';

export function dryRunState(p: Pick<PositionRow, 'route_dry_run'>, nowMs: number): DryRunState {
  const d = p.route_dry_run;
  if (!d) return 'NONE';
  if (nowMs - Date.parse(d.at) > DEFAULT_EMERGENCY_ROUTE_POLICY.maxDryRunAgeMs) return 'STALE';
  return d.ok ? 'OK' : 'FAILED';
}

/** §20.9 review-state column: REVIEWED <age> / PROTECTION_ONLY (reason/age) / BUDGET_PAUSED. */
export function reviewLabel(p: Pick<PositionRow, 'review_state' | 'review_state_reason' | 'review_state_since'>, ago: (iso: string) => string): { text: string; tone: 'ok' | 'failed' | 'degraded' } {
  if (p.review_state === 'REVIEWED') return { text: `REVIEWED ${ago(p.review_state_since)}`, tone: 'ok' };
  if (p.review_state === 'PROTECTION_ONLY') return { text: `PROTECTION_ONLY (${p.review_state_reason ?? 'unreviewed'} / ${ago(p.review_state_since)})`, tone: 'failed' };
  return { text: `${p.review_state} (${ago(p.review_state_since)})`, tone: 'degraded' };
}

export function protectionHealth(p: Pick<PositionRow, 'lots' | 'unreviewed_stop' | 'stop' | 'safety_state'>): { text: string; tone: 'ok' | 'degraded' | 'failed' } {
  const modes = [...new Set(p.lots.filter((l) => l.status === 'OPEN').map((l) => l.protection_mode))];
  const provider = p.lots.filter((l) => l.status === 'OPEN' && l.protection_mode === 'JUPITER_TRIGGER');
  const missingOrder = provider.filter((l) => !l.provider_order_id);
  if (missingOrder.length > 0) return { text: `provider protection missing order (${missingOrder.length} lot)`, tone: 'failed' };
  if (p.unreviewed_stop === null && !p.stop?.level) return { text: 'no stop level', tone: 'failed' };
  return { text: `${modes.join('+') || 'MONITORED_EXIT'} · stop ${p.unreviewed_stop !== null ? 'deterministic (tighten-only)' : 'reviewed'}`, tone: p.safety_state === 'NORMAL' ? 'ok' : 'degraded' };
}

export async function loadPositionsWorkspace(accountId: string, opts: { includeClosed: boolean; limit: number }): Promise<PositionRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  let q = supabase
    .schema('trading')
    .from('positions')
    .select('id, asset_id, mint, quantity, average_entry_price, cost_basis_base_units, realized_pnl_base_units, unrealized_pnl_base_units, stop, target, unreviewed_stop, custody_split, status, review_state, review_state_reason, review_state_since, last_reviewed_cycle_id, next_reassessment_at, safety_state, opened_at, closed_at')
    .eq('account_id', accountId)
    .order('opened_at', { ascending: false })
    .limit(opts.limit);
  if (!opts.includeClosed) q = q.neq('status', 'CLOSED' as never);
  const { data } = await q;
  const rows = (data as unknown as Omit<PositionRow, 'symbol' | 'decimals' | 'lots' | 'price_usd' | 'snapshot_at' | 'route_dry_run' | 'route_hops' | 'price_impact_probes' | 'safety' | 'lastCycle' | 'expected_horizon_minutes' | 'exit_quote' | 'custody'>[] | null) ?? [];
  return hydrate(supabase, rows);
}

export async function loadPositionDetail(positionId: string): Promise<{ position: PositionRow; cycles: CycleView[]; fills: FillRow[]; safetyHistory: SafetyView[]; candles: { resolution: string; rows: CandleView[] }[] } | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase
    .schema('trading')
    .from('positions')
    .select('id, asset_id, mint, quantity, average_entry_price, cost_basis_base_units, realized_pnl_base_units, unrealized_pnl_base_units, stop, target, unreviewed_stop, custody_split, status, review_state, review_state_reason, review_state_since, last_reviewed_cycle_id, next_reassessment_at, safety_state, opened_at, closed_at')
    .eq('id', positionId)
    .maybeSingle();
  if (!data) return null;
  const [position] = await hydrate(supabase, [data as never]);
  if (!position) return null;
  const fillIds = [...new Set(position.lots.flatMap((l) => [...l.entry_fill_ids, ...l.exit_fill_ids]))];
  const since = new Date(Date.parse(position.opened_at) - 2 * 3_600_000).toISOString();
  const [cycles, fills, safety, c5m, c1m] = await Promise.all([
    loadCycles({ positionId, limit: 50 }),
    fillIds.length ? supabase.schema('trading').from('fills').select('id, tx_signature, commitment, input_mint, output_mint, input_amount, output_amount, execution_shortfall_bps, execution_path, filled_at, fees').in('id', fillIds).order('filled_at', { ascending: true }) : Promise.resolve({ data: [] }),
    supabase.schema('trading').from('position_safety_evaluations').select('evaluated_at, policy_version, state, previous_state, reasons, triggers, exit_compatibility, liquidity_usd, chain_slot').eq('position_id', positionId).order('evaluated_at', { ascending: false }).limit(20),
    supabase.schema('market').from('candles').select('bucket_time, open, high, low, close, volume_usd').eq('asset_id', position.asset_id).eq('resolution', '5m' as never).gte('bucket_time', since).order('bucket_time', { ascending: true }).limit(1000),
    supabase.schema('market').from('candles').select('bucket_time, open, high, low, close, volume_usd').eq('asset_id', position.asset_id).eq('resolution', '1m' as never).gte('bucket_time', new Date(Date.now() - 6 * 3_600_000).toISOString()).order('bucket_time', { ascending: true }).limit(400),
  ]);
  const toCandles = (d: unknown) => ((d as { bucket_time: string; open: number; high: number; low: number; close: number; volume_usd: number }[] | null) ?? []).map((c) => ({ time: Math.floor(Date.parse(c.bucket_time) / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume_usd }));
  return {
    position,
    cycles: cycles.sort((a, b) => a.started_at.localeCompare(b.started_at)),
    fills: (fills.data as unknown as FillRow[] | null) ?? [],
    safetyHistory: ((safety.data as unknown as SafetyView[] | null) ?? []).map((s) => ({ ...s, reasons: s.reasons ?? [], triggers: s.triggers ?? [], exit_compatibility: s.exit_compatibility ?? {} })),
    candles: [
      { resolution: '1m', rows: toCandles(c1m.data) },
      { resolution: '5m', rows: toCandles(c5m.data) },
    ],
  };
}

export interface FillRow {
  id: string;
  tx_signature: string;
  commitment: string;
  input_mint: string;
  output_mint: string;
  input_amount: string;
  output_amount: string;
  execution_shortfall_bps: number | null;
  execution_path: string;
  filled_at: string;
  fees: Record<string, unknown>;
}

type Client = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

async function hydrate(supabase: Client, rows: Omit<PositionRow, 'symbol' | 'decimals' | 'lots' | 'price_usd' | 'snapshot_at' | 'route_dry_run' | 'route_hops' | 'price_impact_probes' | 'safety' | 'lastCycle' | 'expected_horizon_minutes' | 'exit_quote' | 'custody'>[]): Promise<PositionRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const assetIds = [...new Set(rows.map((r) => r.asset_id))];
  const [assets, lots, scanner, safety, cycles, quotes, custody] = await Promise.all([
    supabase.schema('core').from('assets').select('id, symbol, decimals').in('id', assetIds),
    supabase.schema('trading').from('position_lots').select('id, position_id, strategy_version_id, sleeve_id, quantity, cost_basis_base_units, realized_pnl_base_units, protection_mode, provider_order_id, reserved_for_protection, status, opened_at, closed_at, entry_intent_id, entry_fill_ids, exit_fill_ids').in('position_id', ids).order('opened_at'),
    supabase.schema('signals').from('scanner').select('asset_id, price_usd, snapshot_at, route_dry_run, route_hops, price_impact_probes').in('asset_id', assetIds),
    supabase.schema('trading').from('position_safety_evaluations').select('position_id, evaluated_at, policy_version, state, previous_state, reasons, triggers, exit_compatibility, liquidity_usd, chain_slot').in('position_id', ids).order('evaluated_at', { ascending: false }).limit(ids.length * 3),
    supabase.schema('agents').from('action_cycles').select('id, position_id').in('position_id', ids).order('started_at', { ascending: false }).limit(ids.length * 2),
    supabase.schema('market').from('quote_probes').select('asset_id, quoted_at, price_impact_bps, expected_output_amount, input_amount, router_label').in('asset_id', assetIds).eq('purpose', 'EXIT_MARK').order('quoted_at', { ascending: false }).limit(assetIds.length * 3),
    supabase.schema('trading').from('custody_accounts').select('id, kind, address').limit(50),
  ]);
  const assetById = new Map(((assets.data as { id: string; symbol: string; decimals: number }[] | null) ?? []).map((a) => [a.id, a]));
  const lotsByPosition = new Map<string, LotView[]>();
  for (const l of (lots.data as unknown as (LotView & { position_id: string })[] | null) ?? []) {
    const arr = lotsByPosition.get(l.position_id) ?? [];
    arr.push({ ...l, entry_fill_ids: l.entry_fill_ids ?? [], exit_fill_ids: l.exit_fill_ids ?? [] });
    lotsByPosition.set(l.position_id, arr);
  }
  const scan = new Map(((scanner.data as unknown as { asset_id: string; price_usd: number | null; snapshot_at: string | null; route_dry_run: PositionRow['route_dry_run']; route_hops: PositionRow['route_hops']; price_impact_probes: PositionRow['price_impact_probes'] }[] | null) ?? []).map((s) => [s.asset_id, s]));
  const latestSafety = new Map<string, SafetyView>();
  for (const s of (safety.data as unknown as (SafetyView & { position_id: string })[] | null) ?? []) if (!latestSafety.has(s.position_id)) latestSafety.set(s.position_id, { ...s, reasons: s.reasons ?? [], triggers: s.triggers ?? [], exit_compatibility: s.exit_compatibility ?? {} });
  const latestCycleId = new Map<string, string>();
  for (const c of (cycles.data as { id: string; position_id: string }[] | null) ?? []) if (!latestCycleId.has(c.position_id)) latestCycleId.set(c.position_id, c.id);
  const latestQuote = new Map<string, PositionRow['exit_quote']>();
  for (const q of (quotes.data as unknown as (NonNullable<PositionRow['exit_quote']> & { asset_id: string })[] | null) ?? []) if (!latestQuote.has(q.asset_id)) latestQuote.set(q.asset_id, q);
  const custodyRows = (custody.data as { id: string; kind: string; address: string }[] | null) ?? [];

  // Last reassessment cycles (hydrated) and the entry proposals' expected horizon.
  const cycleById = new Map<string, CycleView>();
  await Promise.all([...latestCycleId.entries()].map(async ([positionId, cycleId]) => {
    const [c] = await loadCycles({ positionId, limit: 1 });
    if (c && c.id === cycleId) cycleById.set(cycleId, c);
  }));
  const entryIntentIds = [...new Set([...lotsByPosition.values()].flat().map((l) => l.entry_intent_id))];
  const horizonByIntent = new Map<string, number>();
  if (entryIntentIds.length > 0) {
    const intents = await supabase.schema('trading').from('intents').select('id, action_cycle_id').in('id', entryIntentIds);
    const cycleByIntent = new Map(((intents.data as { id: string; action_cycle_id: string }[] | null) ?? []).map((i) => [i.id, i.action_cycle_id]));
    const cids = [...new Set(cycleByIntent.values())];
    if (cids.length > 0) {
      const proposals = await supabase.schema('trading').from('proposals').select('action_cycle_id, proposal').in('action_cycle_id', cids).order('created_at', { ascending: false });
      const horizonByCycle = new Map<string, number>();
      for (const p of (proposals.data as { action_cycle_id: string; proposal: { expectedHorizonMinutes?: number } }[] | null) ?? []) if (!horizonByCycle.has(p.action_cycle_id) && typeof p.proposal?.expectedHorizonMinutes === 'number') horizonByCycle.set(p.action_cycle_id, p.proposal.expectedHorizonMinutes);
      for (const [intentId, cid] of cycleByIntent) {
        const h = horizonByCycle.get(cid);
        if (h !== undefined) horizonByIntent.set(intentId, h);
      }
    }
  }

  return rows.map((r) => {
    const a = assetById.get(r.asset_id);
    const s = scan.get(r.asset_id);
    const lotRows = lotsByPosition.get(r.id) ?? [];
    const horizons = lotRows.map((l) => horizonByIntent.get(l.entry_intent_id)).filter((h): h is number => h !== undefined);
    const lastId = latestCycleId.get(r.id);
    return {
      ...r,
      custody_split: r.custody_split ?? [],
      symbol: a?.symbol ?? '?',
      decimals: a?.decimals ?? 0,
      lots: lotRows,
      price_usd: s?.price_usd ?? null,
      snapshot_at: s?.snapshot_at ?? null,
      route_dry_run: s?.route_dry_run ?? null,
      route_hops: s?.route_hops ?? null,
      price_impact_probes: s?.price_impact_probes ?? null,
      safety: latestSafety.get(r.id) ?? null,
      lastCycle: lastId ? (cycleById.get(lastId) ?? null) : null,
      expected_horizon_minutes: horizons.length ? Math.max(...horizons) : null,
      exit_quote: latestQuote.get(r.asset_id) ?? null,
      custody: custodyRows.filter((c) => (r.custody_split ?? []).some((x) => x.custodyAccountId === c.id)),
    };
  });
}
