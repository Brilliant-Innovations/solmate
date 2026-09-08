import { instantToMs, type Instant, type ReadinessBinding, type ReadinessCapability, type ReadinessPolicy, type ReadinessRow, type ReadinessRowId, type ReadinessRowOutcome, type ReadinessRowSpec, type ReadinessStrategyClass, type ReadinessVerdict, type ReadinessVerdictName, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Readiness verdict (blueprint §29; ADR-0004; ADR-0010 §5). Pure: the newest row per spec is
 * accepted only when its binding equals the current one (commit, image, contract digest, policy
 * digests, wallet, cluster, profile, Release) and it is younger than the policy allows for its
 * kind. A row for a disabled capability is NOT_APPLICABLE with the reason kept on the record. The
 * verdict is READY only when every required, applicable row is a fresh, bound PASS. Nothing here
 * waives a row: the spec decides what is required, the operator never does at compute time.
 */

export interface ReadinessInput {
  id: Uuid;
  name: ReadinessVerdictName;
  spec: readonly ReadinessRowSpec[];
  rows: readonly ReadinessRow[];
  binding: ReadinessBinding;
  strategyClass: ReadinessStrategyClass;
  enabledCapabilities: readonly ReadinessCapability[];
  policy: ReadinessPolicy;
  now: Instant;
}

/** Every bound value must match; an unknown image digest on either side is not a mismatch (single-host profiles have none). */
export function bindingMatches(row: ReadinessBinding, current: ReadinessBinding): string[] {
  const mismatches: string[] = [];
  if (row.gitSha !== current.gitSha) mismatches.push('gitSha');
  if (row.imageDigest !== null && current.imageDigest !== null && row.imageDigest !== current.imageDigest) mismatches.push('imageDigest');
  if (row.contractSetDigest !== current.contractSetDigest) mismatches.push('contractSetDigest');
  const keys = new Set([...Object.keys(row.policyDigests), ...Object.keys(current.policyDigests)]);
  for (const k of keys) if (row.policyDigests[k] !== current.policyDigests[k]) mismatches.push(`policy:${k}`);
  if (row.tradingWallet !== current.tradingWallet) mismatches.push('tradingWallet');
  if (row.cluster !== current.cluster) mismatches.push('cluster');
  if (row.profile !== current.profile) mismatches.push('profile');
  if (row.releaseId !== current.releaseId || row.releaseDigest !== current.releaseDigest) mismatches.push('release');
  return mismatches;
}

function maxAgeFor(kind: ReadinessRow['kind'], policy: ReadinessPolicy): number {
  switch (kind) {
    case 'COMPUTED':
      return policy.computedRowMaxAgeMs;
    case 'CI_EVIDENCE':
      return policy.ciEvidenceMaxAgeMs;
    case 'DRILL':
    case 'PROBE':
      return policy.drillMaxAgeMs;
  }
}

export function computeReadiness(input: ReadinessInput): ReadinessVerdict {
  const caps = new Set(input.enabledCapabilities);
  const outcomes: ReadinessRowOutcome[] = [];
  const missing: ReadinessRowId[] = [];
  const stale: ReadinessRowId[] = [];
  const failed: ReadinessRowId[] = [];
  const notApplicable: ReadinessRowId[] = [];
  const nowMs = instantToMs(input.now);
  for (const s of input.spec) {
    if (s.requiresCapability !== null && !caps.has(s.requiresCapability)) {
      notApplicable.push(s.rowId);
      outcomes.push({ rowId: s.rowId, kind: s.kind, required: s.required, verdict: 'NOT_APPLICABLE', reason: `capability ${s.requiresCapability} disabled`, evaluatedAt: null, rowRef: null });
      continue;
    }
    const candidates = input.rows.filter((r) => r.rowId === s.rowId && r.strategyClass === input.strategyClass && r.binding.profile === input.binding.profile).sort((a, b) => instantToMs(b.evaluatedAt) - instantToMs(a.evaluatedAt));
    const row = candidates[0] ?? null;
    if (!row) {
      missing.push(s.rowId);
      outcomes.push({ rowId: s.rowId, kind: s.kind, required: s.required, verdict: 'UNKNOWN', reason: 'MISSING', evaluatedAt: null, rowRef: null });
      continue;
    }
    const mismatches = bindingMatches(row.binding, input.binding);
    if (mismatches.length) {
      stale.push(s.rowId);
      outcomes.push({ rowId: s.rowId, kind: s.kind, required: s.required, verdict: 'UNKNOWN', reason: `STALE_BINDING:${mismatches.join(',')}`, evaluatedAt: row.evaluatedAt, rowRef: row.id });
      continue;
    }
    const age = nowMs - instantToMs(row.evaluatedAt);
    const expired = (row.expiresAt !== null && instantToMs(row.expiresAt) <= nowMs) || age > maxAgeFor(row.kind, input.policy);
    if (expired) {
      stale.push(s.rowId);
      outcomes.push({ rowId: s.rowId, kind: s.kind, required: s.required, verdict: 'UNKNOWN', reason: `EXPIRED:${Math.round(age / 1000)}s`, evaluatedAt: row.evaluatedAt, rowRef: row.id });
      continue;
    }
    if (row.verdict === 'PASS') {
      outcomes.push({ rowId: s.rowId, kind: s.kind, required: s.required, verdict: 'PASS', reason: null, evaluatedAt: row.evaluatedAt, rowRef: row.id });
      continue;
    }
    if (row.verdict === 'NOT_APPLICABLE') {
      // A recorded NOT_APPLICABLE is honoured only for conditional rows; a required unconditional row cannot opt out.
      if (s.requiresCapability === null) {
        failed.push(s.rowId);
        outcomes.push({ rowId: s.rowId, kind: s.kind, required: s.required, verdict: 'FAIL', reason: 'NOT_APPLICABLE recorded for an unconditional row', evaluatedAt: row.evaluatedAt, rowRef: row.id });
      } else {
        notApplicable.push(s.rowId);
        outcomes.push({ rowId: s.rowId, kind: s.kind, required: s.required, verdict: 'NOT_APPLICABLE', reason: String(row.detail['reason'] ?? 'recorded'), evaluatedAt: row.evaluatedAt, rowRef: row.id });
      }
      continue;
    }
    if (row.verdict === 'FAIL') failed.push(s.rowId);
    else missing.push(s.rowId);
    outcomes.push({ rowId: s.rowId, kind: s.kind, required: s.required, verdict: row.verdict, reason: row.verdict === 'FAIL' ? String(row.detail['reason'] ?? 'FAILED') : 'UNKNOWN', evaluatedAt: row.evaluatedAt, rowRef: row.id });
  }
  const blocking = outcomes.some((o) => o.required && o.verdict !== 'PASS' && o.verdict !== 'NOT_APPLICABLE');
  return {
    id: input.id,
    name: input.name,
    profile: input.binding.profile,
    strategyClass: input.strategyClass,
    releaseId: input.binding.releaseId,
    verdict: blocking ? 'NOT_READY' : 'READY',
    rows: outcomes,
    missing,
    stale,
    failed,
    notApplicable,
    enabledCapabilities: [...input.enabledCapabilities],
    binding: input.binding,
    policyVersion: input.policy.version,
    computedAt: input.now,
  };
}

/** Whether a stored verdict may still be used for arming: READY, for this Release, and younger than the policy allows. */
export function verdictPermits(v: ReadinessVerdict | null, releaseId: Uuid, now: Instant, policy: ReadinessPolicy): boolean {
  if (!v || v.verdict !== 'READY') return false;
  if (v.releaseId !== releaseId) return false;
  return instantToMs(now) - instantToMs(v.computedAt) <= policy.verdictMaxAgeMs;
}
