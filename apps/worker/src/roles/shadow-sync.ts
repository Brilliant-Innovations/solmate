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
  syncShadow(shadow: PositionRiskShadow): Promise<{ ok: boolean; sequence?: number; reason?: string }>;
  emergencyMonitor(cmd: { commandId: Uuid; type: 'EMERGENCY_CLOSE_ASSET'; mint: MintAddress; maxAmount: Amount; reason: string; shadowSequence: number }): Promise<{ outcome: string; reasons?: string[] }>;
}

export interface ShadowSyncDeps {
  repo: ShadowSyncRepo;
  journal: ShadowJournal;
  executor: ShadowExecutor | null;
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

export interface ShadowSyncReport {
  mode: 'SYNCED' | 'UNCHANGED' | 'DB_DOWN' | 'DB_ERROR';
  sequence: number | null;
  pushed: 'OK' | 'REGRESSION' | 'FAILED' | 'NO_EXECUTOR' | 'SKIPPED';
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
  const shadow = buildPositionRiskShadow({ sequence: nextSequence, asOf: now, settlementMints: deps.settlementMints, positions });
  const fingerprint = await shadowFingerprint(shadow);
  if (latest && latest.fingerprint === fingerprint) return { mode: 'UNCHANGED', sequence: latest.shadow.sequence, pushed: 'SKIPPED', stopsHit: 0, commandsIssued: 0, unpriced: 0, error: null };
  const decimals = Object.fromEntries(positions.map((p) => [p.mint, p.decimals]));
  await deps.journal.append({ shadow, fingerprint, decimals, recordedAt: now });
  let pushed: ShadowSyncReport['pushed'] = 'NO_EXECUTOR';
  if (deps.executor) {
    try {
      const r = await deps.executor.syncShadow(shadow);
      pushed = r.ok ? 'OK' : 'REGRESSION';
      if (!r.ok) deps.logger.error('shadow_push_rejected', { sequence: shadow.sequence, reason: r.reason });
    } catch (err) {
      pushed = 'FAILED';
      deps.logger.warn('shadow_push_failed', { sequence: shadow.sequence, error: err instanceof Error ? err.message : String(err) });
    }
  }
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
