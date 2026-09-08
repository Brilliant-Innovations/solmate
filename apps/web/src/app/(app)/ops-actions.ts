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
