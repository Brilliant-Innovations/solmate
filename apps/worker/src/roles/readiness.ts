import { randomUUID } from 'node:crypto';
import { amountToBigInt, compareInstants, instantToMs, ReadinessRowId, ReadinessRowKind, ReadinessRowVerdict, TINY_LIVE_ROW_SET, type CapitalAttestation, type ChainHealthSnapshot, type Clock, type ControlRequestKind, type Instant, type ReadinessBinding, type ReadinessCapability, type ReadinessPolicy, type ReadinessRow, type ReadinessStrategyClass, type ReadinessVerdict, type Release, type ReleaseAttestation, type RiskStateProjection, type Uuid, type WalletReservePolicy } from '@sol-agent-trader/contracts';
import type { PendingControlRequest } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';
import { computeReadiness, presenceState } from '@sol-agent-trader/risk';

/**
 * Worker role `readiness` (blueprint §29, §20.20; ADR-0004 row set; ADR-0010 §5; execution plan
 * M8a). Every cycle it computes the rows whose facts live in the database (reconciliation,
 * Release binding, capital attestation, wallet reserves, operator presence, sleeve isolation,
 * chain health), appends a row only when its outcome changed, resolves operator evidence requests
 * (`RUN_READINESS_DRILL`: a drill, probe or CI run recorded against the current binding) and
 * writes the `READY_FOR_ATTENDED_TINY_LIVE` verdict the arming path consults. Nothing here waives
 * a row and nothing here arms anything.
 */

export interface ReadinessFacts {
  accountMode: 'PAPER' | 'LIVE';
  reconciliation: { status: 'CLEAN' | 'MISMATCH' | 'UNAVAILABLE'; evaluatedAt: Instant } | null;
  release: Release | null;
  attestation: ReleaseAttestation | null;
  capital: CapitalAttestation | null;
  projection: RiskStateProjection | null;
  presence: { attended: boolean; lastPresenceHeartbeatAt: Instant | null } | null;
  chainHealth: ChainHealthSnapshot | null;
  sleeveConflicts: { mint: string; sleeves: number }[];
}

export interface ReadinessRepo {
  facts(): Promise<ReadinessFacts>;
  latestRows(): Promise<ReadinessRow[]>;
  insertRow(row: ReadinessRow): Promise<void>;
  latestVerdict(): Promise<ReadinessVerdict | null>;
  insertVerdict(v: ReadinessVerdict): Promise<void>;
  listPending(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  operatorRole(userId: Uuid): Promise<'operator' | 'admin' | 'viewer' | null>;
  stepUpVerified(requestId: Uuid, now: Instant): Promise<boolean>;
  resolve(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
}

export interface ReadinessDeps {
  repo: ReadinessRepo;
  binding: ReadinessBinding;
  strategyClass: ReadinessStrategyClass;
  enabledCapabilities: readonly ReadinessCapability[];
  policy: ReadinessPolicy;
  reservePolicy: WalletReservePolicy;
  presenceTimeoutMs: number;
  reconciliationMaxAgeMs: number;
  clock: Clock;
  logger: Logger;
  newId?: () => Uuid;
}

export interface ReadinessReport {
  verdict: ReadinessVerdict['verdict'];
  rowsAppended: ReadinessRowId[];
  verdictAppended: boolean;
  evidence: { accepted: number; refused: Record<string, number> };
  missing: ReadinessRowId[];
  stale: ReadinessRowId[];
  failed: ReadinessRowId[];
}

type Computed = { rowId: ReadinessRowId; verdict: ReadinessRow['verdict']; detail: Record<string, unknown> };

function attestationValid(a: ReleaseAttestation | null, release: Release, now: Instant): string | null {
  if (!a) return 'no attestation';
  if (a.releaseId !== release.id || a.releaseDigest !== release.digest) return 'attestation for another Release';
  if (!a.verificationResult || a.operatorRole !== 'admin') return 'attestation not a verified admin step-up';
  if (a.purpose !== 'ARM' && a.purpose !== 'PROMOTE') return `attestation purpose ${a.purpose}`;
  if (a.expiresAt !== null && compareInstants(a.expiresAt, now) <= 0) return 'attestation expired';
  return null;
}

/** The COMPUTED rows, from stored facts only. Every FAIL names its reason so the readiness screen can show it. */
export function computeRows(f: ReadinessFacts, deps: Pick<ReadinessDeps, 'reservePolicy' | 'presenceTimeoutMs' | 'reconciliationMaxAgeMs' | 'policy'>, now: Instant): Computed[] {
  const out: Computed[] = [];
  const nowMs = instantToMs(now);
  const fail = (rowId: ReadinessRowId, reason: string, extra: Record<string, unknown> = {}) => out.push({ rowId, verdict: 'FAIL', detail: { reason, ...extra } });
  const pass = (rowId: ReadinessRowId, extra: Record<string, unknown> = {}) => out.push({ rowId, verdict: 'PASS', detail: extra });

  // reconciliation
  if (!f.reconciliation) fail('RECONCILIATION_CLEAN', 'no reconciliation recorded');
  else {
    const age = nowMs - instantToMs(f.reconciliation.evaluatedAt);
    if (f.reconciliation.status !== 'CLEAN') fail('RECONCILIATION_CLEAN', `reconciliation ${f.reconciliation.status}`, { ageMs: age });
    else if (age > deps.reconciliationMaxAgeMs) fail('RECONCILIATION_CLEAN', 'reconciliation stale', { ageMs: age });
    else pass('RECONCILIATION_CLEAN', { ageMs: age });
  }

  // tiny-live Release binding
  if (!f.release) fail('TINY_LIVE_RELEASE_BOUND', 'no Release registered for the tiny-live variant');
  else if (f.release.status !== 'ELIGIBLE_LIVE' && f.release.status !== 'ARMED') fail('TINY_LIVE_RELEASE_BOUND', `Release ${f.release.status}`, { releaseId: f.release.id });
  else {
    const why = attestationValid(f.attestation, f.release, now);
    if (why) fail('TINY_LIVE_RELEASE_BOUND', why, { releaseId: f.release.id, status: f.release.status });
    else pass('TINY_LIVE_RELEASE_BOUND', { releaseId: f.release.id, status: f.release.status, attestationId: f.attestation!.id });
  }

  // capital attestation and the ceiling
  if (f.accountMode !== 'LIVE') {
    fail('CAPITAL_ATTESTATION', 'account is not LIVE');
    fail('TINY_ATTESTED_CAPITAL', 'account is not LIVE');
  } else if (!f.capital) {
    fail('CAPITAL_ATTESTATION', 'no capital attestation recorded');
    fail('TINY_ATTESTED_CAPITAL', 'no capital attestation recorded');
  } else {
    pass('CAPITAL_ATTESTATION', { attestationId: f.capital.attestationId, ceilingUsd: f.capital.ceilingUsd });
    if (!f.projection) fail('TINY_ATTESTED_CAPITAL', 'no projection to read recognized custody from');
    else if (f.projection.capitalAttestation.reattestRequired || f.projection.capitalAttestation.recognizedUsd > f.capital.ceilingUsd) fail('TINY_ATTESTED_CAPITAL', 'recognized custody above the attested ceiling', { recognizedUsd: f.projection.capitalAttestation.recognizedUsd, ceilingUsd: f.capital.ceilingUsd });
    else pass('TINY_ATTESTED_CAPITAL', { recognizedUsd: f.projection.capitalAttestation.recognizedUsd, ceilingUsd: f.capital.ceilingUsd });
  }

  // wallet reserves (D35)
  if (!f.projection) fail('WALLET_RESERVES', 'no projection');
  else {
    const gas = amountToBigInt(f.projection.gasReserveLamports);
    const settlement = amountToBigInt(f.projection.settlementAvailableBaseUnits);
    const short: string[] = [];
    if (gas < amountToBigInt(deps.reservePolicy.minGasLamports)) short.push('gas');
    if (settlement < amountToBigInt(deps.reservePolicy.minSettlementBaseUnits)) short.push('settlement');
    const extra = { gasLamports: f.projection.gasReserveLamports, settlementBaseUnits: f.projection.settlementAvailableBaseUnits, policy: deps.reservePolicy.version };
    if (short.length) fail('WALLET_RESERVES', `below threshold: ${short.join(',')}`, extra);
    else pass('WALLET_RESERVES', extra);
  }

  // operator presence (attended profiles)
  if (!f.presence) fail('OPERATOR_PRESENCE_HEARTBEAT', 'no open session');
  else {
    const p = presenceState(f.presence.attended, f.presence.lastPresenceHeartbeatAt, now, { presenceTimeoutMs: deps.presenceTimeoutMs } as never);
    if (p === 'PRESENT') pass('OPERATOR_PRESENCE_HEARTBEAT', { lastHeartbeatAt: f.presence.lastPresenceHeartbeatAt });
    else if (p === 'NOT_REQUIRED') fail('OPERATOR_PRESENCE_HEARTBEAT', 'session is not attended');
    else fail('OPERATOR_PRESENCE_HEARTBEAT', 'operator absent', { lastHeartbeatAt: f.presence.lastPresenceHeartbeatAt });
  }

  // sleeve isolation (ADR-0007)
  if (f.sleeveConflicts.length) fail('SINGLE_SLEEVE_PER_MINT', 'a mint is held under more than one sleeve', { conflicts: f.sleeveConflicts });
  else pass('SINGLE_SLEEVE_PER_MINT');

  // chain health
  if (!f.chainHealth) fail('CHAIN_HEALTH', 'no chain-health snapshot');
  else {
    const age = nowMs - instantToMs(f.chainHealth.observedAt);
    if (age > deps.policy.computedRowMaxAgeMs) fail('CHAIN_HEALTH', 'chain-health snapshot stale', { ageMs: age, state: f.chainHealth.state });
    else if (f.chainHealth.effectOnEntries !== 'NONE') fail('CHAIN_HEALTH', `chain ${f.chainHealth.state}`, { reasons: f.chainHealth.reasons });
    else pass('CHAIN_HEALTH', { state: f.chainHealth.state, headSlot: f.chainHealth.headSlot });
  }
  return out;
}

const EVIDENCE_KINDS: ControlRequestKind[] = ['RUN_READINESS_DRILL'];

export async function runReadinessCycle(deps: ReadinessDeps): Promise<ReadinessReport> {
  const now = deps.clock.now();
  const newId = deps.newId ?? (() => randomUUID() as Uuid);
  const report: ReadinessReport = { verdict: 'NOT_READY', rowsAppended: [], verdictAppended: false, evidence: { accepted: 0, refused: {} }, missing: [], stale: [], failed: [] };

  // 1. Operator evidence: drills, probes and CI runs recorded against the current binding.
  for (const req of await deps.repo.listPending(EVIDENCE_KINDS, 20)) {
    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      report.evidence.refused[reason] = (report.evidence.refused[reason] ?? 0) + 1;
      await deps.repo.resolve(req.id, 'REJECTED', { reason, ...extra }, now);
      deps.logger.warn('readiness_evidence_refused', { requestId: req.id, reason, by: req.requestedBy, ...extra });
    };
    const rowId = ReadinessRowId.safeParse(req.payload['rowId']);
    const kind = ReadinessRowKind.safeParse(req.payload['kind']);
    const verdict = ReadinessRowVerdict.safeParse(req.payload['verdict']);
    const evidenceRef = typeof req.payload['evidenceRef'] === 'string' ? (req.payload['evidenceRef'] as string).slice(0, 512) : null;
    if (!rowId.success || !kind.success || !verdict.success || kind.data === 'COMPUTED' || verdict.data === 'UNKNOWN') {
      await refuse('MALFORMED_PAYLOAD', { needs: ['rowId', 'kind DRILL|PROBE|CI_EVIDENCE', 'verdict PASS|FAIL|NOT_APPLICABLE'] });
      continue;
    }
    const spec = TINY_LIVE_ROW_SET.find((s) => s.rowId === rowId.data);
    if (!spec || spec.kind !== kind.data) {
      await refuse('ROW_KIND_MISMATCH', { rowId: rowId.data, expected: spec?.kind ?? null });
      continue;
    }
    const role = await deps.repo.operatorRole(req.requestedBy);
    if (role !== 'operator' && role !== 'admin') {
      await refuse('NOT_AN_OPERATOR', { role });
      continue;
    }
    if (verdict.data === 'PASS') {
      // A PASS is evidence the arming path will rely on: an admin records it, with a step-up for a drill or probe and a reference for every kind.
      if (role !== 'admin') {
        await refuse('ROLE_NOT_ADMIN');
        continue;
      }
      if (!evidenceRef) {
        await refuse('EVIDENCE_REF_REQUIRED');
        continue;
      }
      if (kind.data !== 'CI_EVIDENCE' && !(await deps.repo.stepUpVerified(req.id, now))) {
        await refuse('STEP_UP_REQUIRED');
        continue;
      }
    }
    const detail = typeof req.payload['detail'] === 'object' && req.payload['detail'] !== null ? (req.payload['detail'] as Record<string, unknown>) : {};
    const row: ReadinessRow = { id: newId(), rowId: rowId.data, kind: kind.data, verdict: verdict.data, strategyClass: deps.strategyClass, binding: deps.binding, detail: { ...detail, requestId: req.id }, evidenceRef, recordedBy: `operator:${req.requestedBy}`, evaluatedAt: now, expiresAt: null };
    await deps.repo.insertRow(row);
    await deps.repo.resolve(req.id, 'ACCEPTED', { rowId: row.rowId, verdict: row.verdict, readinessRowId: row.id }, now);
    report.evidence.accepted++;
    report.rowsAppended.push(row.rowId);
    deps.logger.info('readiness_evidence_recorded', { requestId: req.id, rowId: row.rowId, kind: row.kind, verdict: row.verdict, evidenceRef, by: req.requestedBy });
  }

  // 2. Computed rows, appended only when their outcome changed.
  const facts = await deps.repo.facts();
  const latest = await deps.repo.latestRows();
  const computed = computeRows(facts, deps, now);
  const rows = new Map(latest.map((r) => [r.rowId, r] as const));
  for (const c of computed) {
    const prev = rows.get(c.rowId);
    const same = prev && prev.kind === 'COMPUTED' && prev.verdict === c.verdict && prev.detail['reason'] === c.detail['reason'] && !(await rowBindingChanged(prev, deps.binding)) && instantToMs(now) - instantToMs(prev.evaluatedAt) < deps.policy.computedRowMaxAgeMs / 2;
    if (same) continue;
    const row: ReadinessRow = { id: newId(), rowId: c.rowId, kind: 'COMPUTED', verdict: c.verdict, strategyClass: deps.strategyClass, binding: deps.binding, detail: c.detail, evidenceRef: null, recordedBy: 'worker:readiness', evaluatedAt: now, expiresAt: null };
    await deps.repo.insertRow(row);
    rows.set(row.rowId, row);
    report.rowsAppended.push(row.rowId);
  }

  // 3. The verdict the arming path consults.
  const verdict = computeReadiness({ id: newId(), name: 'READY_FOR_ATTENDED_TINY_LIVE', spec: TINY_LIVE_ROW_SET, rows: [...rows.values()], binding: deps.binding, strategyClass: deps.strategyClass, enabledCapabilities: deps.enabledCapabilities, policy: deps.policy, now });
  const prev = await deps.repo.latestVerdict();
  const changed = !prev || prev.verdict !== verdict.verdict || prev.releaseId !== verdict.releaseId || key(prev) !== key(verdict);
  const aged = !prev || instantToMs(now) - instantToMs(prev.computedAt) > deps.policy.verdictMaxAgeMs / 2;
  if (changed || aged) {
    await deps.repo.insertVerdict(verdict);
    report.verdictAppended = true;
  }
  report.verdict = verdict.verdict;
  report.missing = verdict.missing;
  report.stale = verdict.stale;
  report.failed = verdict.failed;
  deps.logger[verdict.verdict === 'READY' ? 'info' : 'warn']('readiness_cycle', { verdict: verdict.verdict, profile: deps.binding.profile, strategyClass: deps.strategyClass, releaseId: deps.binding.releaseId, missing: verdict.missing, stale: verdict.stale, failed: verdict.failed, notApplicable: verdict.notApplicable, rowsAppended: report.rowsAppended, evidence: report.evidence });
  return report;
}

const key = (v: ReadinessVerdict): string => JSON.stringify([[...v.missing].sort(), [...v.stale].sort(), [...v.failed].sort(), [...v.notApplicable].sort()]);

async function rowBindingChanged(row: ReadinessRow, binding: ReadinessBinding): Promise<boolean> {
  return JSON.stringify(row.binding) !== JSON.stringify(binding);
}
