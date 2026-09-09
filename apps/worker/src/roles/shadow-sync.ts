import { randomUUID } from 'node:crypto';
import type { Amount, Clock, Instant, MintAddress, PositionRiskShadow, Sequence, Uuid } from '@sol-agent-trader/contracts';
import { buildPositionRiskShadow, evaluateShadowStops, shadowFingerprint, type ShadowSourcePosition } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';
import type { ShadowJournal } from '../shadow/journal.js';

/**
 * Worker role `shadow-sync` (blueprint §15.10A, D22; execution plan M8a). While Postgres answers,
 * every change to the open book becomes a new sequenced `PositionRiskShadow` appended to the
 * worker's durable journal and pushed to the executor, which journals it too. When Postgres stops
 * answering, the role keeps deterministic protection alive from the last shadow and fresh prices:
 * a hit stop becomes an EMERGENCY_CLOSE_ASSET request to the executor's authenticated monitor path
 * (chain custody caps the quantity, the executor rejects a stale shadow). The shadow never opens
 * or increases exposure; with no executor configured (paper profiles) the outage is only reported.
 */

export interface ShadowSyncRepo {
  /** Open positions with their lots and decimals; throws when the database is unavailable. */
  positions(): Promise<(ShadowSourcePosition & { decimals: number })[]>;
}

export interface ShadowExecutor {
  syncShadow(shadow: PositionRiskShadow): Promise<{ ok: boolean; sequence?: number; state?: 'APPENDED' | 'IN_SYNC'; reason?: string; lastSynced?: number }>;
  emergencyMonitor(cmd: { commandId: Uuid; type: 'EMERGENCY_CLOSE_ASSET'; mint: MintAddress; maxAmount: Amount; reason: string; shadowSequence: number }): Promise<{ outcome: string; reasons?: string[] }>;
}

/**
 * Raising a notification, so a persistent shadow regression is something an operator is told about
 * rather than something technically visible in a log nobody reads (WP0 follow-up, 2026-09-09).
 * Optional: a paper profile with no executor has nothing to regress.
 */
export interface ShadowSyncAlerts {
  openAlertExists(alertClass: string): Promise<boolean>;
  raise(n: { id: Uuid; severity: 'CRITICAL' | 'HIGH'; alertClass: string; summary: string; affected: Record<string, unknown>; automatedResponse: string | null; raisedAt: Instant }): Promise<void>;
  /** §21.2C sticky pause; cleared only by the step-up RESUME path. Returns false when one is already open. */
  insertEntryPauseOnce(reason: string, ref: string): Promise<boolean>;
}

export interface ShadowSyncDeps {
  repo: ShadowSyncRepo;
  journal: ShadowJournal;
  executor: ShadowExecutor | null;
  alerts?: ShadowSyncAlerts | null;
  /** Price per token in settlement terms from a live exit quote; null when no route. Works without the database. */
  price: (mint: MintAddress, quantity: Amount, decimals: number, now: Instant) => Promise<number | null>;
  settlementMints: readonly MintAddress[];
  clock: Clock;
  logger: Logger;
  config: { dbDownAfterFailures: number };
  newId?: () => Uuid;
}

export interface ShadowSyncState {
  consecutiveDbFailures: number;
}

/** Raised once while the executor's shadow is ahead of ours; see the regression branch below. */
export const SHADOW_REGRESSION_ALERT = 'SHADOW_SEQUENCE_REGRESSION';
/** Sticky entry pause set alongside it: no new exposure while it provably cannot be protected. */
export const SHADOW_REGRESSION_PAUSE = 'SHADOW_PROTECTION_UNAVAILABLE';

export interface ShadowSyncReport {
  mode: 'SYNCED' | 'UNCHANGED' | 'DB_DOWN' | 'DB_ERROR';
  sequence: number | null;
  /** `IN_SYNC`: the executor already held this sequence — the ordinary answer while the book is quiet. */
  pushed: 'OK' | 'IN_SYNC' | 'REGRESSION' | 'FAILED' | 'NO_EXECUTOR' | 'SKIPPED';
  stopsHit: number;
  commandsIssued: number;
  unpriced: number;
  error: string | null;
}

export async function runShadowSyncCycle(deps: ShadowSyncDeps, state: ShadowSyncState): Promise<ShadowSyncReport> {
  const now = deps.clock.now();
  const newId = deps.newId ?? (() => randomUUID() as Uuid);
  let positions: (ShadowSourcePosition & { decimals: number })[];
  try {
    positions = await deps.repo.positions();
  } catch (err) {
    state.consecutiveDbFailures += 1;
    const error = err instanceof Error ? err.message : String(err);
    if (state.consecutiveDbFailures < deps.config.dbDownAfterFailures) {
      deps.logger.warn('shadow_db_read_failed', { failures: state.consecutiveDbFailures, error });
      return { mode: 'DB_ERROR', sequence: null, pushed: 'SKIPPED', stopsHit: 0, commandsIssued: 0, unpriced: 0, error };
    }
    return protectFromShadow(deps, now, newId, error);
  }
  state.consecutiveDbFailures = 0;

  const latest = await deps.journal.latest();
  const nextSequence = ((latest?.shadow.sequence ?? 0) + 1) as Sequence;
  const built = buildPositionRiskShadow({ sequence: nextSequence, asOf: now, settlementMints: deps.settlementMints, positions });
  const fingerprint = await shadowFingerprint(built);

  /**
   * DEFECT-1 (2026-09-09): an unchanged book must still be pushed.
   *
   * This used to return here, before the executor was ever contacted, whenever the newly built shadow
   * matched the newest entry in *our own* journal. That treated local state as proof of remote state.
   * An executor attached after the fact, or restarted while the book happened to be quiet, then never
   * received a shadow at all — and `db-down-close` reported `shadowSequence: null` indefinitely, which
   * is to say the DB-down emergency close had no bounds to plan against precisely when Postgres was
   * gone. Reproduced against real processes: a journal entry from the previous day matched every cycle
   * and nothing was ever pushed.
   *
   * So the journal keeps its append optimisation — an unchanged book is not a new sequence — but the
   * push happens every cycle, carrying the shadow of record. While the book is quiet that re-sends one
   * sequence repeatedly, which the executor answers `IN_SYNC`; only a strictly lower sequence is a
   * regression. A fresh or wiped executor holds nothing, so the push lands and self-corrects.
   */
  const unchanged = latest !== null && latest.fingerprint === fingerprint;
  const shadow = unchanged ? latest.shadow : built;
  if (!unchanged) {
    const decimals = Object.fromEntries(positions.map((p) => [p.mint, p.decimals]));
    await deps.journal.append({ shadow: built, fingerprint, decimals, recordedAt: now });
  }

  let pushed: ShadowSyncReport['pushed'] = 'NO_EXECUTOR';
  if (deps.executor) {
    try {
      const r = await deps.executor.syncShadow(shadow);
      pushed = !r.ok ? 'REGRESSION' : r.state === 'IN_SYNC' ? 'IN_SYNC' : 'OK';
      // A regression is the executor refusing a stale or replayed shadow, which is a real problem.
      // The executor already holding this sequence is the ordinary quiet-book answer, not an error.
      if (!r.ok) {
        deps.logger.error('shadow_push_rejected', { sequence: shadow.sequence, reason: r.reason, lastSynced: r.lastSynced });
        /**
         * The asymmetric wipe: our journal is lost, the executor's is not. We restart at sequence 1,
         * every push is a genuine regression, and the executor keeps a shadow from before the wipe.
         * DB-down protection is then not merely degraded but disabled in both directions — the stale
         * book would be planned against, and `emergencyMonitor` refuses our commands as SHADOW_STALE
         * because our sequence is below what it holds. It never self-corrects, because nothing about
         * repeating the push changes either side.
         *
         * Refusing loudly was already right. Refusing loudly into a log line that nobody watches is
         * the same shape as the defect this audit was chartered to find, one level up, so it raises
         * *and* stops new entries.
         *
         * Blocking entries is not a new policy invention: §13.6 already pauses them whenever the
         * infrastructure that makes trading safe is absent — `FEEDS_STALE`, `SESSION_NOT_ACTIVE`,
         * `CUSTODY_MISMATCH`, `DB_UNAVAILABLE`. This is the same category and arguably its strongest
         * instance, because opening a position you provably cannot protect is the one thing the whole
         * protection stack exists to prevent. It rides on the §21.2C sticky pause rather than a new
         * `RISK_REASONS` member: `entryHealth` already blocks on any uncleared `ops.entry_pauses` row,
         * so this needs no change to the versioned risk policy, and `journal-import` sets its
         * comparable pause exactly this way. Only the step-up RESUME path clears it.
         */
        if (deps.alerts && !(await deps.alerts.openAlertExists(SHADOW_REGRESSION_ALERT))) {
          const paused = await deps.alerts.insertEntryPauseOnce(SHADOW_REGRESSION_PAUSE, 'shadow-sync');
          await deps.alerts.raise({
            id: newId(),
            severity: 'CRITICAL',
            alertClass: SHADOW_REGRESSION_ALERT,
            summary: `The executor refused our position shadow at sequence ${shadow.sequence}: it holds ${r.lastSynced ?? 'a newer one'}. Our shadow journal is behind the executor's, which does not self-correct, and DB-down protection is disabled in both directions — the executor would plan against a book from before our journal was lost, and it refuses our emergency closes as SHADOW_STALE. New entries are paused until an operator reconciles the two journals and resumes with step-up (§15.10A, D22, §21.2C).`.slice(0, 512),
            affected: { assetId: null, strategyVersionId: null, positionId: null, system: 'shadow-sync', sequence: shadow.sequence, lastSynced: r.lastSynced ?? null, entryPauseSet: paused },
            automatedResponse: 'PAUSE_NEW_ENTRIES (sticky, operator review)',
            raisedAt: now,
          });
        }
      }
    } catch (err) {
      pushed = 'FAILED';
      deps.logger.warn('shadow_push_failed', { sequence: shadow.sequence, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (unchanged) return { mode: 'UNCHANGED', sequence: shadow.sequence, pushed, stopsHit: 0, commandsIssued: 0, unpriced: 0, error: null };
  deps.logger.info('shadow_synced', { sequence: shadow.sequence, positions: shadow.positions.length, lots: shadow.positions.reduce((n, p) => n + p.lots.length, 0), pushed });
  return { mode: 'SYNCED', sequence: shadow.sequence, pushed, stopsHit: 0, commandsIssued: 0, unpriced: 0, error: null };
}

async function protectFromShadow(deps: ShadowSyncDeps, now: Instant, newId: () => Uuid, error: string): Promise<ShadowSyncReport> {
  const latest = await deps.journal.latest();
  if (!latest) {
    deps.logger.error('shadow_db_down_no_shadow', { error });
    return { mode: 'DB_DOWN', sequence: null, pushed: 'SKIPPED', stopsHit: 0, commandsIssued: 0, unpriced: 0, error };
  }
  // Fresh marks from live exit quotes; a position with no mark is reported unmarked and never sold on missing data.
  const marks = new Map<MintAddress, number>();
  for (const p of latest.shadow.positions) {
    const decimals = latest.decimals[p.mint];
    const price = decimals === undefined ? null : await deps.price(p.mint, p.lastConfirmedQuantity, decimals, now).catch(() => null);
    if (price !== null && Number.isFinite(price)) marks.set(p.mint, price);
  }
  const { hits, unmarked } = evaluateShadowStops(latest.shadow, marks, now);
  const unpriced = unmarked;
  let commandsIssued = 0;
  if (hits.length && !deps.executor) deps.logger.error('shadow_db_down_no_executor', { sequence: latest.shadow.sequence, hits: hits.map((h) => ({ mint: h.mint, reason: h.reason, mark: marks.get(h.mint) ?? null })), effect: 'no executor is configured in this profile; the paper book cannot be protected without the database' });
  for (const h of hits) {
    if (!deps.executor) break;
    const cmd = { commandId: newId(), type: 'EMERGENCY_CLOSE_ASSET' as const, mint: h.mint, maxAmount: h.lastConfirmedQuantity, reason: `shadow ${h.reason}: mark ${marks.get(h.mint) ?? 'n/a'} at sequence ${latest.shadow.sequence} (database unavailable)`, shadowSequence: latest.shadow.sequence };
    try {
      const out = await deps.executor.emergencyMonitor(cmd);
      commandsIssued++;
      deps.logger.error('shadow_emergency_close_requested', { commandId: cmd.commandId, mint: h.mint, reason: h.reason, outcome: out.outcome, reasons: out.reasons ?? [] });
    } catch (err) {
      deps.logger.error('shadow_emergency_close_failed', { commandId: cmd.commandId, mint: h.mint, error: err instanceof Error ? err.message : String(err) });
    }
  }
  deps.logger.error('shadow_db_down', { sequence: latest.shadow.sequence, asOf: latest.shadow.asOf, positions: latest.shadow.positions.length, stopsHit: hits.length, unpriced: unpriced.length, commandsIssued, error });
  return { mode: 'DB_DOWN', sequence: latest.shadow.sequence, pushed: 'SKIPPED', stopsHit: hits.length, commandsIssued, unpriced: unpriced.length, error };
}
