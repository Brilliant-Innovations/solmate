import { createSupabaseServerClient } from './supabase/server';

/**
 * Read models for the Audit Log (blueprint §20.25, §6.22; ADR-0009 P2). Rows are the hash-chained
 * ledger as the operator's own RLS session sees them; the chain check runs in the database and the
 * last verified checkpoint comes from the persisted verification the worker wrote after comparing
 * the ledger with its external replica. Nothing here is authority; a missing row stays missing.
 */

export interface AuditEventView {
  sequence: number;
  at: string;
  actor: string;
  actor_ref: string;
  action_class: string;
  entity: { type?: string; id?: string } & Record<string, unknown>;
  before_summary: Record<string, unknown> | null;
  after_summary: Record<string, unknown> | null;
  authority_evidence: string | null;
  origin: string;
  live_impacting: boolean;
  hash: string;
  original_local_at: string | null;
  imported_at: string | null;
}

export interface AuditFilters {
  actor?: string;
  actionClass?: string;
  entityType?: string;
  origin?: string;
  liveOnly?: boolean;
  from?: string;
  to?: string;
  /** Page backwards from this sequence (exclusive). */
  before?: number;
  limit?: number;
}

export interface CheckpointView {
  sequence: number;
  hash: string;
  checkpointed_at: string;
  replicated_to: string[];
}

export interface VerificationView {
  verified_at: string;
  ok: boolean;
  head_sequence: number | null;
  checkpoint_sequence: number | null;
  checkpoint_hash: string | null;
  replica: string;
  reason: string | null;
  detail: string | null;
}

export interface ChainCheckView {
  ok: boolean;
  checked: number;
  first_bad_sequence: number | null;
}

export interface AuditIntegrityView {
  head: { sequence: number; at: string; hash: string } | null;
  checkpoint: CheckpointView | null;
  verification: VerificationView | null;
  chain: ChainCheckView | null;
  importsPending: number | null;
}

export const AUDIT_PAGE_SIZE = 50;

export async function loadAuditEvents(f: AuditFilters): Promise<AuditEventView[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  let q = supabase
    .schema('audit')
    .from('events')
    .select('sequence, at, actor, actor_ref, action_class, entity, before_summary, after_summary, authority_evidence, origin, live_impacting, hash, original_local_at, imported_at')
    .order('sequence', { ascending: false })
    .limit(f.limit ?? AUDIT_PAGE_SIZE);
  if (f.actor) q = q.eq('actor', f.actor as never);
  if (f.actionClass) q = q.eq('action_class', f.actionClass);
  if (f.entityType) q = q.eq('entity->>type', f.entityType);
  if (f.origin) q = q.eq('origin', f.origin as never);
  if (f.liveOnly) q = q.eq('live_impacting', true);
  if (f.from) q = q.gte('at', f.from);
  if (f.to) q = q.lte('at', f.to);
  if (f.before !== undefined) q = q.lt('sequence', f.before);
  const { data } = await q;
  return ((data as unknown as AuditEventView[] | null) ?? []).map((r) => ({ ...r, sequence: Number(r.sequence) }));
}

/** Distinct action classes and actors seen recently, for the filter controls. */
export async function loadAuditFacets(): Promise<{ actionClasses: string[]; actors: string[]; entityTypes: string[] }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { actionClasses: [], actors: [], entityTypes: [] };
  const { data } = await supabase.schema('audit').from('events').select('actor, action_class, entity').order('sequence', { ascending: false }).limit(2000);
  const rows = (data as { actor: string; action_class: string; entity: { type?: string } }[] | null) ?? [];
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.length > 0))].sort();
  return { actionClasses: uniq(rows.map((r) => r.action_class)), actors: uniq(rows.map((r) => r.actor)), entityTypes: uniq(rows.map((r) => r.entity?.type)) };
}

export async function loadAuditIntegrity(): Promise<AuditIntegrityView> {
  const supabase = await createSupabaseServerClient();
  const empty: AuditIntegrityView = { head: null, checkpoint: null, verification: null, chain: null, importsPending: null };
  if (!supabase) return empty;
  const [head, checkpoint, verification, chain, imports] = await Promise.all([
    supabase.schema('audit').from('events').select('sequence, at, hash').order('sequence', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('audit').from('checkpoints').select('sequence, hash, checkpointed_at, replicated_to').order('sequence', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('audit').from('verifications').select('verified_at, ok, head_sequence, checkpoint_sequence, checkpoint_hash, replica, reason, detail').order('verified_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.schema('audit').rpc('verify_chain'),
    supabase.schema('ops').from('executor_journal_imports').select('id', { count: 'exact', head: true }),
  ]);
  const chainRow = Array.isArray(chain.data) ? (chain.data[0] as { ok: boolean; checked: number | string; first_bad_sequence: number | string | null } | undefined) : null;
  return {
    head: head.data ? { sequence: Number((head.data as { sequence: number }).sequence), at: (head.data as { at: string }).at, hash: (head.data as { hash: string }).hash } : null,
    checkpoint: checkpoint.data ? { ...(checkpoint.data as CheckpointView), sequence: Number((checkpoint.data as { sequence: number }).sequence) } : null,
    verification: verification.data
      ? { ...(verification.data as VerificationView), head_sequence: nullableNumber((verification.data as { head_sequence: unknown }).head_sequence), checkpoint_sequence: nullableNumber((verification.data as { checkpoint_sequence: unknown }).checkpoint_sequence) }
      : null,
    chain: chainRow ? { ok: chainRow.ok, checked: Number(chainRow.checked), first_bad_sequence: nullableNumber(chainRow.first_bad_sequence) } : null,
    importsPending: imports.error ? null : (imports.count ?? null),
  };
}

const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
