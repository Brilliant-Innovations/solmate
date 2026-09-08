import { loadCycleInspector, type CycleInspectorView } from './cycles';
import { loadApprovalQueue, type PendingApprovalView } from './ops';
import { createSupabaseServerClient } from './supabase/server';

/**
 * Approval Queue read model (§20.8). Every card is an intent that the adversary cleared and the
 * risk-authorizer signed; the card must show the thesis and adversary verdict, the exact maximum
 * authorized amount, account exposure after the trade, the stop/protection plan, the executable
 * quote and its freshness, the authorization expiry, the signed authorization hash and the risk
 * reasons for allow. Approval never edits amount or asset; any change is a new proposal.
 */

export interface ApprovalCard {
  queue: PendingApprovalView;
  symbol: string;
  decimals: number;
  inspector: CycleInspectorView | null;
  quote: { purpose: string; quoted_at: string; price_impact_bps: number | null; expected_output_amount: string; input_amount: string; router_label: string | null } | null;
  exposure: { equity_base_units: string; exposure_base_units: string; exposure_fraction: number; as_of: string } | null;
  strategy: { live_intent_expiry_ms: number; human_reaction_floor_ms: number; eligible_capital_authorities: string[] } | null;
  constraints: Record<string, unknown> | null;
  protection_policy_ref: string | null;
}

export interface InformationalIntent {
  id: string;
  action: string;
  side: string;
  strategy_version_id: string;
  max_input_amount: string;
  lifecycle_state: string;
  created_at: string;
  expires_at: string;
  symbol: string;
}

export async function loadApprovalCards(): Promise<{ cards: ApprovalCard[]; informational: InformationalIntent[] }> {
  const supabase = await createSupabaseServerClient();
  const queue = await loadApprovalQueue();
  if (!supabase) return { cards: [], informational: [] };
  const intentIds = queue.map((q) => q.intent_id);
  const [intents, informational] = await Promise.all([
    intentIds.length ? supabase.schema('trading').from('intents').select('id, action_cycle_id, asset_id, account_id, constraints, protection_policy_ref, strategy_version_id').in('id', intentIds) : Promise.resolve({ data: [] }),
    supabase.schema('trading').from('intents').select('id, action, side, strategy_version_id, max_input_amount, lifecycle_state, created_at, expires_at, asset_id').eq('approval_required', false).in('lifecycle_state', ['AUTHORIZED', 'APPROVED'] as never[]).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(20),
  ]);
  const intentRows = (intents.data as { id: string; action_cycle_id: string; asset_id: string; account_id: string; constraints: Record<string, unknown> | null; protection_policy_ref: string | null; strategy_version_id: string }[] | null) ?? [];
  const infoRows = (informational.data as unknown as (Omit<InformationalIntent, 'symbol'> & { asset_id: string })[] | null) ?? [];
  const assetIds = [...new Set([...intentRows.map((i) => i.asset_id), ...infoRows.map((i) => i.asset_id)])];
  const accountIds = [...new Set(intentRows.map((i) => i.account_id))];
  const strategyIds = [...new Set(intentRows.map((i) => i.strategy_version_id))];
  const [assets, snapshots, strategies, quotes] = await Promise.all([
    assetIds.length ? supabase.schema('core').from('assets').select('id, symbol, decimals').in('id', assetIds) : Promise.resolve({ data: [] }),
    accountIds.length ? supabase.schema('trading').from('portfolio_snapshots').select('account_id, equity_base_units, exposure_base_units, exposure_fraction, as_of').in('account_id', accountIds).order('as_of', { ascending: false }).limit(accountIds.length * 2) : Promise.resolve({ data: [] }),
    strategyIds.length ? supabase.schema('research').from('strategy_versions').select('version_id, live_intent_expiry_ms, human_reaction_floor_ms, eligible_capital_authorities').in('version_id', strategyIds) : Promise.resolve({ data: [] }),
    intentRows.length ? supabase.schema('market').from('quote_probes').select('action_cycle_id, purpose, quoted_at, price_impact_bps, expected_output_amount, input_amount, router_label').in('action_cycle_id', intentRows.map((i) => i.action_cycle_id)).order('quoted_at', { ascending: false }).limit(intentRows.length * 4) : Promise.resolve({ data: [] }),
  ]);
  const assetById = new Map(((assets.data as { id: string; symbol: string; decimals: number }[] | null) ?? []).map((a) => [a.id, a]));
  const snapByAccount = new Map<string, ApprovalCard['exposure']>();
  for (const s of (snapshots.data as (NonNullable<ApprovalCard['exposure']> & { account_id: string })[] | null) ?? []) if (!snapByAccount.has(s.account_id)) snapByAccount.set(s.account_id, s);
  const stratById = new Map(((strategies.data as (NonNullable<ApprovalCard['strategy']> & { version_id: string })[] | null) ?? []).map((s) => [s.version_id, { ...s, eligible_capital_authorities: s.eligible_capital_authorities ?? [] }]));
  const quoteByCycle = new Map<string, ApprovalCard['quote']>();
  for (const q of (quotes.data as (NonNullable<ApprovalCard['quote']> & { action_cycle_id: string })[] | null) ?? []) {
    const existing = quoteByCycle.get(q.action_cycle_id);
    if (!existing || (q.purpose === 'EXECUTABLE' && existing.purpose !== 'EXECUTABLE')) quoteByCycle.set(q.action_cycle_id, q);
  }
  const cards = await Promise.all(
    queue.map(async (q) => {
      const intent = intentRows.find((i) => i.id === q.intent_id) ?? null;
      const inspector = intent ? await loadCycleInspector(intent.action_cycle_id) : null;
      const asset = intent ? assetById.get(intent.asset_id) : undefined;
      return {
        queue: q,
        symbol: asset?.symbol ?? 'unknown',
        decimals: asset?.decimals ?? 0,
        inspector,
        quote: intent ? (quoteByCycle.get(intent.action_cycle_id) ?? null) : null,
        exposure: intent ? (snapByAccount.get(intent.account_id) ?? null) : null,
        strategy: intent ? (stratById.get(intent.strategy_version_id) ?? null) : null,
        constraints: intent?.constraints ?? null,
        protection_policy_ref: intent?.protection_policy_ref ?? null,
      };
    }),
  );
  return {
    cards,
    informational: infoRows.map((i) => ({ ...i, symbol: assetById.get(i.asset_id)?.symbol ?? 'unknown' })),
  };
}
