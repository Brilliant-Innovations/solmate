import type { Clock, ControlRequestKind, Instant, Uuid } from '@sol-agent-trader/contracts';
import type { PendingControlRequest } from '@sol-agent-trader/db/server';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `watchlist` (blueprint §20.4, §20.27). Resolves the operator's attention controls:
 * WATCH_ASSET, UNWATCH_ASSET and REQUEST_RESEARCH_REFRESH. All three are FAST (D41) because none
 * of them grants eligibility or execution permission: a watch is a note with alert rules, and a
 * research refresh only makes the eligibility role re-run its unchanged evaluation sooner. The
 * operator cannot bypass hard eligibility by clicking anything here (§20.4).
 */

export interface WatchlistRepo {
  listPending(kinds: ControlRequestKind[], limit: number): Promise<PendingControlRequest[]>;
  operatorRole(userId: Uuid): Promise<'operator' | 'admin' | 'viewer' | null>;
  assetIdByMint(mint: string): Promise<Uuid | null>;
  assetExists(id: Uuid): Promise<boolean>;
  addWatch(w: { assetId: Uuid; reason: string; note: string | null; alertRules: Record<string, unknown>; addedBy: Uuid; at: Instant }): Promise<{ ok: true; id: Uuid } | { ok: false; reason: 'ALREADY_WATCHED' }>;
  removeWatch(id: Uuid, by: Uuid, at: Instant): Promise<boolean>;
  requestResearchRefresh(assetId: Uuid, at: Instant): Promise<boolean>;
  resolve(id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant): Promise<boolean>;
}

export interface WatchlistDeps {
  repo: WatchlistRepo;
  clock: Clock;
  logger: Logger;
  config: { batchSize: number };
}

export interface WatchlistReport {
  requests: number;
  watched: number;
  unwatched: number;
  refreshRequested: number;
  refused: Record<string, number>;
  errors: { requestId: Uuid; error: string }[];
}

const KINDS: ControlRequestKind[] = ['WATCH_ASSET', 'UNWATCH_ASSET', 'REQUEST_RESEARCH_REFRESH'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function resolveAsset(repo: WatchlistRepo, payload: Record<string, unknown>): Promise<Uuid | null> {
  const assetId = payload['assetId'];
  if (typeof assetId === 'string' && UUID.test(assetId)) return (await repo.assetExists(assetId as Uuid)) ? (assetId as Uuid) : null;
  const mint = payload['mint'];
  if (typeof mint === 'string' && MINT.test(mint)) return repo.assetIdByMint(mint);
  return null;
}

export async function runWatchlistCycle(deps: WatchlistDeps): Promise<WatchlistReport> {
  const now = deps.clock.now();
  const report: WatchlistReport = { requests: 0, watched: 0, unwatched: 0, refreshRequested: 0, refused: {}, errors: [] };
  const requests = await deps.repo.listPending(KINDS, deps.config.batchSize);
  report.requests = requests.length;
  for (const req of requests) {
    const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
      report.refused[reason] = (report.refused[reason] ?? 0) + 1;
      await deps.repo.resolve(req.id, 'REJECTED', { reason, ...extra }, now);
      deps.logger.warn('watchlist_refused', { requestId: req.id, kind: req.kind, reason, by: req.requestedBy, ...extra });
    };
    try {
      const role = await deps.repo.operatorRole(req.requestedBy);
      if (role !== 'operator' && role !== 'admin') {
        await refuse('NOT_AN_OPERATOR', { role });
        continue;
      }
      if (req.kind === 'WATCH_ASSET') {
        const assetId = await resolveAsset(deps.repo, req.payload);
        if (!assetId) {
          await refuse('UNKNOWN_ASSET');
          continue;
        }
        const reason = req.payload['reason'];
        if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 128) {
          await refuse('MALFORMED_PAYLOAD', { detail: 'reason must be 1..128 characters' });
          continue;
        }
        const note = typeof req.payload['note'] === 'string' && (req.payload['note'] as string).length > 0 ? (req.payload['note'] as string).slice(0, 1024) : null;
        const rules = req.payload['alertRules'];
        const alertRules = rules && typeof rules === 'object' && !Array.isArray(rules) ? (rules as Record<string, unknown>) : {};
        const r = await deps.repo.addWatch({ assetId, reason: reason.trim(), note, alertRules, addedBy: req.requestedBy, at: now });
        if (!r.ok) {
          await refuse(r.reason, { assetId });
          continue;
        }
        report.watched++;
        await deps.repo.resolve(req.id, 'ACCEPTED', { watchId: r.id, assetId }, now);
        deps.logger.info('asset_watched', { requestId: req.id, by: req.requestedBy, assetId, watchId: r.id });
        continue;
      }
      if (req.kind === 'UNWATCH_ASSET') {
        const watchId = req.payload['watchId'];
        if (typeof watchId !== 'string' || !UUID.test(watchId)) {
          await refuse('MALFORMED_PAYLOAD');
          continue;
        }
        const done = await deps.repo.removeWatch(watchId as Uuid, req.requestedBy, now);
        if (!done) {
          await refuse('UNKNOWN_WATCH');
          continue;
        }
        report.unwatched++;
        await deps.repo.resolve(req.id, 'ACCEPTED', { watchId }, now);
        deps.logger.info('asset_unwatched', { requestId: req.id, by: req.requestedBy, watchId });
        continue;
      }
      // REQUEST_RESEARCH_REFRESH
      const assetId = await resolveAsset(deps.repo, req.payload);
      if (!assetId) {
        await refuse('UNKNOWN_ASSET');
        continue;
      }
      const done = await deps.repo.requestResearchRefresh(assetId, now);
      if (!done) {
        await refuse('ASSET_RETIRED', { assetId });
        continue;
      }
      report.refreshRequested++;
      await deps.repo.resolve(req.id, 'ACCEPTED', { assetId, note: 'eligibility re-evaluates on its next cycle; hard eligibility is not bypassed' }, now);
      deps.logger.info('research_refresh_requested', { requestId: req.id, by: req.requestedBy, assetId });
    } catch (err) {
      report.errors.push({ requestId: req.id, error: err instanceof Error ? err.message : String(err) });
      deps.logger.error('watchlist_failed', { requestId: req.id, kind: req.kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
