'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '../../lib/supabase/server';

/**
 * Operator-surface controls (§20.8, §20.20, §20.28, §12.4; §23.3). Every control is one row in
 * ops.control_requests inserted as the signed-in user under RLS; the worker validates role, state
 * and step-up (approvals, arming, drill PASS records) and acts. Acknowledge and reject stay fast
 * by design (D41); nothing here executes, arms or signs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function request(kind: string, payload: Record<string, unknown>, path: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return;
  const { error } = await supabase.schema('ops').from('control_requests').insert({ kind: kind as never, payload: payload as never });
  if (error) throw new Error(`control request refused: ${error.message}`);
  revalidatePath(path);
}

const uuidField = (form: FormData, name: string): string => {
  const v = String(form.get(name) ?? '').trim();
  if (!UUID.test(v)) throw new Error(`${name} is not a uuid`);
  return v;
};

export async function requestAcknowledgeAlert(form: FormData): Promise<void> {
  await request('ACKNOWLEDGE_ALERT', { notificationId: uuidField(form, 'notificationId'), source: 'alert-center' }, '/alerts');
}

export async function requestApproveAuthorization(form: FormData): Promise<void> {
  await request('APPROVE_AUTHORIZATION', { intentId: uuidField(form, 'intentId'), source: 'approval-queue' }, '/approvals');
}

export async function requestRejectAuthorization(form: FormData): Promise<void> {
  await request('REJECT_AUTHORIZATION', { intentId: uuidField(form, 'intentId'), source: 'approval-queue' }, '/approvals');
}

export async function requestPromoteRelease(form: FormData): Promise<void> {
  await request('PROMOTE_RELEASE', { releaseId: uuidField(form, 'releaseId'), source: 'releases' }, '/releases');
}

export async function requestArmRelease(form: FormData): Promise<void> {
  const ceiling = Number(String(form.get('capitalCeilingUsd') ?? ''));
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('capitalCeilingUsd must be a positive number');
  await request('ARM_RELEASE', { releaseId: uuidField(form, 'releaseId'), accountId: uuidField(form, 'accountId'), capitalCeilingUsd: ceiling, source: 'releases' }, '/releases');
}

export async function requestReadinessEvidence(form: FormData): Promise<void> {
  const rowId = String(form.get('rowId') ?? '').trim();
  const kind = String(form.get('kind') ?? '').trim();
  const verdict = String(form.get('verdict') ?? '').trim();
  const evidenceRef = String(form.get('evidenceRef') ?? '').trim();
  const note = String(form.get('note') ?? '').trim();
  if (!/^[A-Z_]{3,64}$/.test(rowId)) throw new Error('rowId is not a readiness row id');
  if (!['DRILL', 'PROBE', 'CI_EVIDENCE'].includes(kind)) throw new Error('kind must be DRILL, PROBE or CI_EVIDENCE');
  if (!['PASS', 'FAIL', 'NOT_APPLICABLE'].includes(verdict)) throw new Error('verdict must be PASS, FAIL or NOT_APPLICABLE');
  await request('RUN_READINESS_DRILL', { rowId, kind, verdict, evidenceRef: evidenceRef || null, detail: note ? { note: note.slice(0, 500) } : {}, source: 'readiness' }, '/readiness');
}

/** Close one open position at market through the position monitor's exit path (MANUAL_CLOSE, D41: no step-up). */
export async function requestManualClose(form: FormData): Promise<void> {
  await request('MANUAL_CLOSE', { positionId: uuidField(form, 'positionId'), source: 'positions' }, '/positions');
}

/** Reduce one open position by a fraction in (0, 1); the worker rounds the quantity down and refuses a zero. */
export async function requestManualReduce(form: FormData): Promise<void> {
  const fraction = Number(String(form.get('fraction') ?? ''));
  if (!Number.isFinite(fraction) || !(fraction > 0) || !(fraction < 1)) throw new Error('fraction must be between 0 and 1');
  await request('MANUAL_REDUCE', { positionId: uuidField(form, 'positionId'), fraction, source: 'positions' }, '/positions');
}

/**
 * Close every open position (EMERGENCY_CLOSE_ALL). The typed confirmation replaces a blocking
 * browser dialog: the request is only inserted when the operator typed CLOSE ALL.
 */
export async function requestEmergencyCloseAll(form: FormData): Promise<void> {
  const typed = String(form.get('confirm') ?? '').trim().toUpperCase();
  if (typed !== 'CLOSE ALL') throw new Error('type CLOSE ALL to confirm');
  await request('EMERGENCY_CLOSE_ALL', { source: 'positions', confirmedText: typed }, '/positions');
}

// §20.4 / §20.27 attention controls: FAST, never eligibility or execution permission.
export async function requestWatchAsset(form: FormData): Promise<void> {
  const mint = String(form.get('mint') ?? '').trim();
  const assetId = String(form.get('assetId') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim().slice(0, 128);
  const note = String(form.get('note') ?? '').trim().slice(0, 1024);
  if (!reason) throw new Error('reason is required');
  const target = assetId && UUID.test(assetId) ? { assetId } : { mint };
  if (!('assetId' in target) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('mint is not a Solana address');
  const back = String(form.get('back') ?? '/watchlist');
  await request('WATCH_ASSET', { ...target, reason, note: note || null, alertRules: {}, source: 'watchlist' }, back.startsWith('/') ? back : '/watchlist');
}

export async function requestUnwatchAsset(form: FormData): Promise<void> {
  const back = String(form.get('back') ?? '/watchlist');
  await request('UNWATCH_ASSET', { watchId: uuidField(form, 'watchId'), source: 'watchlist' }, back.startsWith('/') ? back : '/watchlist');
}

export async function requestResearchRefresh(form: FormData): Promise<void> {
  const back = String(form.get('back') ?? '/scanner');
  await request('REQUEST_RESEARCH_REFRESH', { assetId: uuidField(form, 'assetId'), source: 'scanner' }, back.startsWith('/') ? back : '/scanner');
}

/**
 * File a replay run (RUN_REPLAY, FAST: research rows only, no capital). The worker's replay role
 * validates versions and window, binds every current version and the dataset cutoff, then
 * executes the run under the simulated clock (§18, §20.15).
 */
export async function requestRunReplay(form: FormData): Promise<void> {
  const name = String(form.get('name') ?? '').trim().slice(0, 120);
  const fidelity = String(form.get('fidelity') ?? 'B_CAPTURED');
  const stamp = (field: string, required: boolean): string | null => {
    const raw = String(form.get(field) ?? '').trim();
    if (!raw) {
      if (required) throw new Error(`${field} is required`);
      return null;
    }
    const d = new Date(raw.endsWith('Z') ? raw : `${raw}${raw.length === 16 ? ':00' : ''}Z`);
    if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a date-time`);
    return d.toISOString();
  };
  const from = stamp('from', true) as string;
  const to = stamp('to', true) as string;
  const holdout = stamp('holdout', false);
  const strategies = form.getAll('strategy').map((s) => String(s).trim()).filter((s) => /^[A-Za-z0-9_.@-]{1,64}$/.test(s));
  const baseline = String(form.get('baseline') ?? '').trim();
  if (!name) throw new Error('name is required');
  if (!['A_HISTORICAL', 'B_CAPTURED'].includes(fidelity)) throw new Error('fidelity must be A_HISTORICAL or B_CAPTURED');
  if (strategies.length === 0) throw new Error('pick at least one strategy version');
  if (!strategies.includes(baseline)) throw new Error('the baseline must be one of the selected strategy versions');
  const seed = Number(String(form.get('seed') ?? '0'));
  if (!Number.isInteger(seed) || seed < 0) throw new Error('seed must be a non-negative integer');
  const assetsRaw = String(form.get('assets') ?? '').trim();
  const assetIds = assetsRaw ? assetsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (assetIds && assetIds.some((a) => !UUID.test(a))) throw new Error('assets must be comma-separated asset ids');
  await request('RUN_REPLAY', {
    name,
    fidelity,
    window: { from, to, inSampleUntil: holdout },
    strategyVersionIds: strategies,
    baselineStrategyVersionId: baseline,
    seed,
    latencyMatchedBaseline: form.get('latencyMatched') !== null,
    proposerOnlyShadow: form.get('proposerOnly') !== null,
    assetIds,
    source: 'replay-lab',
  }, '/replay');
}
