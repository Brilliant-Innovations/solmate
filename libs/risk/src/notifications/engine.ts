import { amountToBigInt, instantToMs, SeverityOf, type AlertClass, type AlertSeverity, type ChainHealthSnapshot, type Instant, type NotificationPolicy, type RiskStateProjection, type WalletReservePolicy } from '@sol-agent-trader/contracts';
import { presenceState } from '../runtime-session/cold-start.js';

/**
 * Alert derivation, escalation and dead-man rules (blueprint §20.20, D35, D42). Pure: facts in,
 * the alerts that should be open now out. The worker raises what is new, resolves what cleared,
 * escalates what nobody acknowledged and applies the dead-man pause. Nothing here delivers.
 */

export interface AlertFacts {
  reconciliation: { status: 'CLEAN' | 'MISMATCH' | 'UNAVAILABLE'; evaluatedAt: Instant; reasons?: string[] } | null;
  chainHealth: ChainHealthSnapshot | null;
  projection: Pick<RiskStateProjection, 'gasReserveLamports' | 'settlementAvailableBaseUnits'> | null;
  presence: { attended: boolean; lastPresenceHeartbeatAt: Instant | null } | null;
  openPositions: number;
  blockingFeeds: string[];
  /** null = no executor configured in this profile; otherwise the last health read. */
  executor: { reachable: boolean; signerHealthy: boolean | null; detail: string | null } | null;
}

export interface DesiredAlert {
  alertClass: AlertClass;
  severity: AlertSeverity;
  summary: string;
  affected: { assetId: null; strategyVersionId: null; positionId: null; system: string };
  automatedResponse: string | null;
}

const alert = (alertClass: AlertClass, summary: string, system: string, automatedResponse: string | null = null): DesiredAlert => ({ alertClass, severity: SeverityOf[alertClass], summary: summary.slice(0, 512), affected: { assetId: null, strategyVersionId: null, positionId: null, system }, automatedResponse });

export function deriveAlerts(f: AlertFacts, policy: NotificationPolicy, reserves: WalletReservePolicy, presenceTimeoutMs: number, now: Instant): DesiredAlert[] {
  const out: DesiredAlert[] = [];
  const nowMs = instantToMs(now);
  if (f.reconciliation?.status === 'MISMATCH') out.push(alert('CUSTODY_RECONCILIATION_MISMATCH', `Custody reconciliation mismatch: ${(f.reconciliation.reasons ?? []).join(', ') || 'see reconciliation'}`, 'reconciliation', 'PAUSE_NEW_ENTRIES'));
  if (f.reconciliation?.status === 'UNAVAILABLE' && nowMs - instantToMs(f.reconciliation.evaluatedAt) >= policy.reconciliationUnavailableAfterMs) out.push(alert('RECONCILIATION_UNAVAILABLE', `Chain/custody reconciliation unavailable since ${f.reconciliation.evaluatedAt}`, 'reconciliation'));
  if (f.chainHealth && f.chainHealth.effectOnEntries === 'BLOCK') out.push(alert('CHAIN_ENTRIES_BLOCKED', `Chain health ${f.chainHealth.state}: ${f.chainHealth.reasons.join('; ') || 'entries blocked'}`, 'chain-health', 'entries blocked by provider health'));
  if (f.projection) {
    const short: string[] = [];
    if (amountToBigInt(f.projection.gasReserveLamports) < amountToBigInt(reserves.minGasLamports)) short.push(`gas ${f.projection.gasReserveLamports} < ${reserves.minGasLamports} lamports`);
    if (amountToBigInt(f.projection.settlementAvailableBaseUnits) < amountToBigInt(reserves.minSettlementBaseUnits)) short.push(`settlement ${f.projection.settlementAvailableBaseUnits} < ${reserves.minSettlementBaseUnits}`);
    if (short.length) out.push(alert('RESERVE_BELOW_THRESHOLD', `Wallet reserve below threshold: ${short.join('; ')} (funding is manual, D35)`, 'wallet-reserves'));
  }
  if (f.presence && f.openPositions > 0) {
    const p = presenceState(f.presence.attended, f.presence.lastPresenceHeartbeatAt, now, { presenceTimeoutMs } as never);
    if (p === 'ABSENT') out.push(alert('OPERATOR_ABSENT_WITH_EXPOSURE', `Operator presence lost with ${f.openPositions} open position(s); new entries pause, exits continue`, 'presence', 'WATCH (new entries paused by the session role)'));
  }
  if (f.blockingFeeds.length) out.push(alert('PROVIDER_FEED_BLOCKING', `Provider feeds blocking entries: ${f.blockingFeeds.join(', ')}`, 'provider-health', 'entries blocked'));
  if (f.executor && f.openPositions > 0) {
    if (!f.executor.reachable) out.push(alert('EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS', `Executor unreachable with ${f.openPositions} open position(s): ${f.executor.detail ?? 'no response'}`, 'executor'));
    else if (f.executor.signerHealthy === false) out.push(alert('SIGNER_UNAVAILABLE_WITH_EXPOSURE', `Signer unavailable with ${f.openPositions} open position(s): ${f.executor.detail ?? 'signer health failed'}`, 'signer'));
  }
  return out;
}

export interface OpenAlert {
  id: string;
  alertClass: string;
  severity: AlertSeverity;
  raisedAt: Instant;
  acknowledgedAt: Instant | null;
  escalationLevel: number;
  lastEscalatedAt: Instant | null;
  deadManActionTaken: string | null;
}

/** Unacknowledged CRITICAL: re-send after the interval, counted from the last escalation (or the raise), up to the maximum level. */
export function escalationDue(n: OpenAlert, policy: NotificationPolicy, now: Instant): boolean {
  if (n.severity !== 'CRITICAL' || n.acknowledgedAt !== null) return false;
  if (n.escalationLevel >= policy.escalationMaxLevel) return false;
  const since = n.lastEscalatedAt ?? n.raisedAt;
  return instantToMs(now) - instantToMs(since) >= policy.escalationIntervalMs;
}

/** Dead-man rule: the class is listed, nobody acknowledged, the interval passed, and the pause was not applied yet. */
export function deadManDue(n: OpenAlert, policy: NotificationPolicy, now: Instant): boolean {
  if (n.acknowledgedAt !== null || n.deadManActionTaken !== null) return false;
  if (!(policy.deadManClasses as string[]).includes(n.alertClass)) return false;
  return instantToMs(now) - instantToMs(n.raisedAt) >= policy.deadManIntervalMs;
}

/** SYSTEM_ALIVE while a session is active or exposure exists; intentional OFF with nothing open is silent by design. */
export function heartbeatDue(input: { sessionActive: boolean; openPositions: number; lastHeartbeatAt: Instant | null }, policy: NotificationPolicy, now: Instant): boolean {
  if (!input.sessionActive && input.openPositions === 0) return false;
  if (input.lastHeartbeatAt === null) return true;
  return instantToMs(now) - instantToMs(input.lastHeartbeatAt) >= policy.heartbeatIntervalMs;
}
