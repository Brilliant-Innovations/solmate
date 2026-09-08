import { addMs, DEFAULT_NOTIFICATION_POLICY, DEFAULT_WALLET_RESERVE_POLICY, fixtures, type Amount, type Instant } from '@sol-agent-trader/contracts';
import { deadManDue, deriveAlerts, escalationDue, heartbeatDue, type AlertFacts, type OpenAlert } from './engine.js';

const T0 = fixtures.T0 as Instant;
const policy = DEFAULT_NOTIFICATION_POLICY;
const quiet = (): AlertFacts => ({
  reconciliation: { status: 'CLEAN', evaluatedAt: addMs(T0, -30_000) },
  chainHealth: { id: fixtures.IDS.message as never, observedAt: T0, policyVersion: 'chain-health-v1' as never, state: 'HEALTHY', views: [], headSlot: null, slotAdvanced: true, confirmedFinalizedLagSlots: 30, viewDivergenceSlots: null, effectOnEntries: 'NONE', reasons: [] } as never,
  projection: { gasReserveLamports: '200000000' as Amount, settlementAvailableBaseUnits: '50000000' as Amount },
  presence: { attended: true, lastPresenceHeartbeatAt: addMs(T0, -10_000) },
  openPositions: 1,
  blockingFeeds: [],
  executor: { reachable: true, signerHealthy: true, detail: null },
});
const classes = (f: AlertFacts) => deriveAlerts(f, policy, DEFAULT_WALLET_RESERVE_POLICY, 180_000, T0).map((a) => `${a.severity}:${a.alertClass}`);

describe('alert derivation (§20.20, D35)', () => {
  it('quiet facts raise nothing', () => {
    expect(classes(quiet())).toEqual([]);
  });

  it('each condition raises its class at the policy severity with an operator-readable summary', () => {
    const q = quiet();
    expect(classes({ ...q, reconciliation: { status: 'MISMATCH', evaluatedAt: T0, reasons: ['UNKNOWN_MOVEMENT'] } })).toEqual(['CRITICAL:CUSTODY_RECONCILIATION_MISMATCH']);
    expect(classes({ ...q, reconciliation: { status: 'UNAVAILABLE', evaluatedAt: addMs(T0, -policy.reconciliationUnavailableAfterMs) } })).toEqual(['HIGH:RECONCILIATION_UNAVAILABLE']);
    expect(classes({ ...q, reconciliation: { status: 'UNAVAILABLE', evaluatedAt: addMs(T0, -1_000) } })).toEqual([]);
    expect(classes({ ...q, chainHealth: { ...q.chainHealth!, state: 'STALLED', effectOnEntries: 'BLOCK', reasons: ['no confirmed slot advance for 40s'] } })).toEqual(['HIGH:CHAIN_ENTRIES_BLOCKED']);
    expect(classes({ ...q, projection: { gasReserveLamports: '1000' as Amount, settlementAvailableBaseUnits: '50000000' as Amount } })).toEqual(['NOTICE:RESERVE_BELOW_THRESHOLD']);
    expect(classes({ ...q, presence: { attended: true, lastPresenceHeartbeatAt: addMs(T0, -400_000) } })).toEqual(['HIGH:OPERATOR_ABSENT_WITH_EXPOSURE']);
    expect(classes({ ...q, presence: { attended: true, lastPresenceHeartbeatAt: addMs(T0, -400_000) }, openPositions: 0 })).toEqual([]);
    expect(classes({ ...q, blockingFeeds: ['BIRDEYE:CANDLES'] })).toEqual(['NOTICE:PROVIDER_FEED_BLOCKING']);
    expect(classes({ ...q, executor: { reachable: false, signerHealthy: null, detail: 'ECONNREFUSED' } })).toEqual(['CRITICAL:EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS']);
    expect(classes({ ...q, executor: { reachable: true, signerHealthy: false, detail: 'signer timeout' } })).toEqual(['CRITICAL:SIGNER_UNAVAILABLE_WITH_EXPOSURE']);
    expect(classes({ ...q, executor: { reachable: false, signerHealthy: null, detail: null }, openPositions: 0 })).toEqual([]);
    expect(classes({ ...q, executor: null })).toEqual([]);
    const a = deriveAlerts({ ...q, reconciliation: { status: 'MISMATCH', evaluatedAt: T0, reasons: ['UNKNOWN_MOVEMENT'] } }, policy, DEFAULT_WALLET_RESERVE_POLICY, 180_000, T0)[0]!;
    expect(a.summary).toContain('UNKNOWN_MOVEMENT');
    expect(a.automatedResponse).toBe('PAUSE_NEW_ENTRIES');
    expect(a.affected.system).toBe('reconciliation');
  });
});

describe('escalation, dead-man and heartbeat rules', () => {
  const open = (over: Partial<OpenAlert> = {}): OpenAlert => ({ id: 'n1', alertClass: 'UNABLE_TO_EXIT', severity: 'CRITICAL', raisedAt: addMs(T0, -policy.escalationIntervalMs), acknowledgedAt: null, escalationLevel: 0, lastEscalatedAt: null, deadManActionTaken: null, ...over });

  it('an unacknowledged CRITICAL escalates after the interval from the raise or the last escalation, never past the maximum, never once acknowledged, never for lower severities', () => {
    expect(escalationDue(open(), policy, T0)).toBe(true);
    expect(escalationDue(open({ raisedAt: addMs(T0, -1_000) }), policy, T0)).toBe(false);
    expect(escalationDue(open({ escalationLevel: 1, lastEscalatedAt: addMs(T0, -1_000) }), policy, T0)).toBe(false);
    expect(escalationDue(open({ escalationLevel: 1, lastEscalatedAt: addMs(T0, -policy.escalationIntervalMs) }), policy, T0)).toBe(true);
    expect(escalationDue(open({ escalationLevel: policy.escalationMaxLevel }), policy, T0)).toBe(false);
    expect(escalationDue(open({ acknowledgedAt: T0 }), policy, T0)).toBe(false);
    expect(escalationDue(open({ severity: 'HIGH' }), policy, T0)).toBe(false);
  });

  it('the dead-man pause fires only for listed classes, unacknowledged, past the interval, and once', () => {
    const due = open({ raisedAt: addMs(T0, -policy.deadManIntervalMs) });
    expect(deadManDue(due, policy, T0)).toBe(true);
    expect(deadManDue({ ...due, raisedAt: addMs(T0, -policy.deadManIntervalMs + 1_000) }, policy, T0)).toBe(false);
    expect(deadManDue({ ...due, acknowledgedAt: T0 }, policy, T0)).toBe(false);
    expect(deadManDue({ ...due, deadManActionTaken: 'PAUSE_NEW_ENTRIES' }, policy, T0)).toBe(false);
    expect(deadManDue({ ...due, alertClass: 'CHAIN_ENTRIES_BLOCKED' }, policy, T0)).toBe(false);
    expect(deadManDue({ ...due, alertClass: 'CUSTODY_RECONCILIATION_MISMATCH' }, policy, T0)).toBe(true);
    expect(deadManDue({ ...due, alertClass: 'EXECUTOR_UNHEALTHY_WITH_OPEN_POSITIONS' }, policy, T0)).toBe(true);
  });

  it('SYSTEM_ALIVE is due while a session is active or exposure exists, on the interval; intentional OFF with nothing open is silent', () => {
    expect(heartbeatDue({ sessionActive: true, openPositions: 0, lastHeartbeatAt: null }, policy, T0)).toBe(true);
    expect(heartbeatDue({ sessionActive: true, openPositions: 0, lastHeartbeatAt: addMs(T0, -1_000) }, policy, T0)).toBe(false);
    expect(heartbeatDue({ sessionActive: true, openPositions: 0, lastHeartbeatAt: addMs(T0, -policy.heartbeatIntervalMs) }, policy, T0)).toBe(true);
    expect(heartbeatDue({ sessionActive: false, openPositions: 2, lastHeartbeatAt: null }, policy, T0)).toBe(true);
    expect(heartbeatDue({ sessionActive: false, openPositions: 0, lastHeartbeatAt: null }, policy, T0)).toBe(false);
  });
});
