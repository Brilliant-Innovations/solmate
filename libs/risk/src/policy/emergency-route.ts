import { instantToMs, type EmergencyExitRouteSnapshot, type EmergencyRoutePolicy, type EmergencyRouteReadiness, type Instant } from '@sol-agent-trader/contracts';

/**
 * Emergency-route readiness for autonomous entry (blueprint §14.6 "stale/failed emergency
 * readiness blocks new autonomous entry for that asset", D33; plan M8b). Deterministic and
 * dependency-free so the risk-authorizer can apply it to every LIVE_AUTO entry from the persisted
 * snapshot alone. Exits are never gated by this: a missing route makes an asset unfit to enter,
 * not impossible to leave.
 */
export interface EmergencyRouteVerdict {
  readiness: EmergencyRouteReadiness;
  reason: string | null;
  dryRunAgeMs: number | null;
}

export function emergencyRouteReadiness(snapshot: EmergencyExitRouteSnapshot | null, now: Instant, policy: Pick<EmergencyRoutePolicy, 'maxDryRunAgeMs' | 'supportedPrograms'>): EmergencyRouteVerdict {
  if (!snapshot) return { readiness: 'MISSING', reason: 'no emergency route snapshot', dryRunAgeMs: null };
  const hop = snapshot.hops[0];
  if (!hop || !policy.supportedPrograms.includes(hop.program)) return { readiness: 'UNSUPPORTED', reason: `no local adapter for ${hop?.program ?? 'missing hop'}`, dryRunAgeMs: null };
  if (!snapshot.lastDryRun) return { readiness: 'STALE', reason: 'no dry-run recorded', dryRunAgeMs: null };
  const age = instantToMs(now) - instantToMs(snapshot.lastDryRun.at);
  if (!snapshot.lastDryRun.ok) return { readiness: 'FAILED', reason: snapshot.lastDryRun.error ?? 'dry-run failed', dryRunAgeMs: age };
  if (age > policy.maxDryRunAgeMs) return { readiness: 'STALE', reason: `dry-run ${Math.round(age / 60_000)} min old`, dryRunAgeMs: age };
  return { readiness: 'READY', reason: null, dryRunAgeMs: age };
}

/** LIVE_AUTO entries need READY; every other authority is untouched by this gate (§14.6). */
export function emergencyRoutePermitsEntry(verdict: EmergencyRouteVerdict, capitalAuthority: string): boolean {
  return capitalAuthority !== 'LIVE_AUTO' || verdict.readiness === 'READY';
}
