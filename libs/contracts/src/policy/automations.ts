import { z } from 'zod';
import { AutomationTriggerFamily, CapitalAuthority, SpeedTier } from '../enums.js';
import { Milliseconds, VersionId } from '../primitives.js';

/**
 * Automation set (blueprint §11.1, §11.7, D32). Automations are deterministic invocations of the
 * Trading Skill: a versioned list of trigger types with interval, cooldown, priority and the
 * capital modes they run in. The agent cannot create, enable or edit them (§11.4 forbidden tools).
 */

export const CandidateTriggerType = z.enum([
  'SCANNER_THRESHOLD',
  'FRESH_CATALYST',
  'SMART_MONEY_FLOW',
  'NEW_EVIDENCE_BEFORE_EXPIRY',
  'BREAKOUT_RETEST',
]);
export type CandidateTriggerType = z.infer<typeof CandidateTriggerType>;

export const OpenPositionTriggerType = z.enum([
  'REASSESSMENT_HEARTBEAT',
  'PRICE_EXCURSION',
  'PROFIT_MILESTONE',
  'VOLATILITY_REGIME_SHIFT',
  'LIQUIDITY_ROUTE_DEGRADATION',
  'SMART_MONEY_REVERSAL',
  'SECURITY_EVIDENCE',
  'CATALYST_CHANGE',
  'HORIZON_CHECKPOINT',
  'PROTECTIVE_ORDER_STATE_CHANGE',
  'RECOVERY_AFTER_RESTART',
]);
export type OpenPositionTriggerType = z.infer<typeof OpenPositionTriggerType>;

export const SystemTriggerType = z.enum(['PROVIDER_HEALTH_DEGRADATION', 'SLEEVE_CONSTRAINED', 'SELF_INFLUENCE_WINDOW_ENDED']);
export type SystemTriggerType = z.infer<typeof SystemTriggerType>;

export const AutomationTriggerType = z.enum([...CandidateTriggerType.options, ...OpenPositionTriggerType.options, ...SystemTriggerType.options]);
export type AutomationTriggerType = z.infer<typeof AutomationTriggerType>;

export const AutomationRule = z.strictObject({
  name: z.string().min(1).max(64),
  triggerFamily: AutomationTriggerFamily,
  triggerType: AutomationTriggerType,
  /** Two firings for the same target are at least this far apart. */
  minIntervalMs: Milliseconds,
  /** After a firing the target is quiet for this long regardless of trigger type. */
  cooldownMs: Milliseconds,
  priority: z.number().int().min(0).max(100),
  enabledModes: z.array(CapitalAuthority).min(1),
  contextDeadlineMs: Milliseconds,
  enabled: z.boolean(),
});
export type AutomationRule = z.infer<typeof AutomationRule>;

export const AutomationSet = z.strictObject({
  version: VersionId,
  rules: z.array(AutomationRule).min(1),
  /** Reassessment heartbeat per speed tier (§11.7 "appropriate to strategy speed tier"). */
  heartbeatMsByTier: z.record(SpeedTier, Milliseconds),
  /** Price excursion (fraction of entry) that triggers an event-driven reassessment. */
  priceExcursionFraction: z.number().positive(),
  /** Consecutive unresolved cycles before the retry backoff reaches its ceiling (D39). */
  protectionOnlyRetryBaseMs: Milliseconds,
  protectionOnlyRetryMaxMs: Milliseconds,
  /** Consecutive unresolved cycles after which a HIGH alert is raised (D39). */
  protectionOnlyAlertAfter: z.number().int().positive(),
}).refine((s) => new Set(s.rules.map((r) => r.triggerType)).size === s.rules.length, { message: 'one rule per trigger type' });
export type AutomationSet = z.infer<typeof AutomationSet>;

const ALL_MODES: CapitalAuthority[] = ['OBSERVE', 'PAPER', 'LIVE_APPROVAL', 'LIVE_AUTO'];
const rule = (name: string, triggerFamily: AutomationTriggerFamily, triggerType: AutomationTriggerType, minIntervalMs: number, cooldownMs: number, priority: number): AutomationRule => ({ name, triggerFamily, triggerType, minIntervalMs, cooldownMs, priority, enabledModes: ALL_MODES, contextDeadlineMs: 20_000, enabled: true });

export const DEFAULT_AUTOMATION_SET: AutomationSet = {
  version: 'automations-v1' as VersionId,
  rules: [
    rule('candidate-scanner', 'CANDIDATE', 'SCANNER_THRESHOLD', 300_000, 60_000, 50),
    rule('candidate-catalyst', 'CANDIDATE', 'FRESH_CATALYST', 300_000, 60_000, 60),
    rule('candidate-smart-money', 'CANDIDATE', 'SMART_MONEY_FLOW', 300_000, 60_000, 55),
    rule('candidate-new-evidence', 'CANDIDATE', 'NEW_EVIDENCE_BEFORE_EXPIRY', 600_000, 120_000, 40),
    rule('candidate-retest', 'CANDIDATE', 'BREAKOUT_RETEST', 300_000, 60_000, 45),
    rule('position-heartbeat', 'OPEN_POSITION', 'REASSESSMENT_HEARTBEAT', 600_000, 120_000, 30),
    rule('position-excursion', 'OPEN_POSITION', 'PRICE_EXCURSION', 300_000, 120_000, 70),
    rule('position-milestone', 'OPEN_POSITION', 'PROFIT_MILESTONE', 300_000, 120_000, 50),
    rule('position-vol-shift', 'OPEN_POSITION', 'VOLATILITY_REGIME_SHIFT', 900_000, 120_000, 55),
    rule('position-liquidity', 'OPEN_POSITION', 'LIQUIDITY_ROUTE_DEGRADATION', 300_000, 60_000, 80),
    rule('position-smart-money', 'OPEN_POSITION', 'SMART_MONEY_REVERSAL', 600_000, 120_000, 65),
    rule('position-security', 'OPEN_POSITION', 'SECURITY_EVIDENCE', 60_000, 0, 95),
    rule('position-catalyst', 'OPEN_POSITION', 'CATALYST_CHANGE', 600_000, 120_000, 60),
    rule('position-horizon', 'OPEN_POSITION', 'HORIZON_CHECKPOINT', 600_000, 120_000, 45),
    rule('position-protection', 'OPEN_POSITION', 'PROTECTIVE_ORDER_STATE_CHANGE', 60_000, 0, 90),
    rule('position-recovery', 'OPEN_POSITION', 'RECOVERY_AFTER_RESTART', 60_000, 0, 85),
    rule('system-provider-health', 'SYSTEM', 'PROVIDER_HEALTH_DEGRADATION', 300_000, 60_000, 75),
    rule('system-sleeve', 'SYSTEM', 'SLEEVE_CONSTRAINED', 600_000, 120_000, 40),
    rule('system-self-influence', 'SYSTEM', 'SELF_INFLUENCE_WINDOW_ENDED', 600_000, 120_000, 35),
  ],
  heartbeatMsByTier: { T0_FAST: 300_000, T1_MOMENTUM: 600_000, T2_CONTEXTUAL: 1_800_000, T3_CATALYST: 7_200_000 },
  priceExcursionFraction: 0.05,
  protectionOnlyRetryBaseMs: 60_000,
  protectionOnlyRetryMaxMs: 900_000,
  protectionOnlyAlertAfter: 3,
};
