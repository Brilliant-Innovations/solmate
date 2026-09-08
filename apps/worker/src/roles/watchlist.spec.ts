import { fixtures, type Instant, type Uuid } from '@sol-agent-trader/contracts';
import type { PendingControlRequest } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { runWatchlistCycle, type WatchlistDeps, type WatchlistRepo } from './watchlist.js';

const logger = createLogger({ service: 'worker', minLevel: 'error' });
const T0 = fixtures.T0 as Instant;
const OP = '11111111-1111-4111-8111-111111111111' as Uuid;
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;
const WATCH = '33333333-3333-4333-8333-333333333333' as Uuid;
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function harness(role: 'operator' | 'viewer' = 'operator') {
  const watches = new Map<Uuid, { assetId: Uuid; removed: boolean }>();
  const refreshed: Uuid[] = [];
  const resolved: { kind: string; state: string; resolution: Record<string, unknown> }[] = [];
  let pending: PendingControlRequest[] = [];
  const repo: WatchlistRepo = {
    async listPending(kinds) { return pending.filter((p) => kinds.includes(p.kind)); },
    async operatorRole() { return role; },
    async assetIdByMint(mint) { return mint === MINT ? ASSET : null; },
    async assetExists(id) { return id === ASSET; },
    async addWatch(w) {
      if ([...watches.values()].some((x) => x.assetId === w.assetId && !x.removed)) return { ok: false, reason: 'ALREADY_WATCHED' };
      watches.set(WATCH, { assetId: w.assetId, removed: false });
      return { ok: true, id: WATCH };
    },
    async removeWatch(id) { const w = watches.get(id); if (!w || w.removed) return false; w.removed = true; return true; },
    async requestResearchRefresh(assetId) { refreshed.push(assetId); return true; },
    async resolve(id, state, resolution) { resolved.push({ kind: pending.find((p) => p.id === id)?.kind ?? '?', state, resolution }); return true; },
  };
  const deps: WatchlistDeps = { repo, clock: { now: () => T0, nowMs: () => Date.parse(T0) }, logger, config: { batchSize: 10 } };
  return { deps, resolved, refreshed, watches, setPending: (p: PendingControlRequest[]) => { pending = p; } };
}

const req = (id: string, kind: PendingControlRequest['kind'], payload: Record<string, unknown>): PendingControlRequest => ({ id: id as Uuid, requestedBy: OP, kind, payload, createdAt: T0 });

describe('worker watchlist role (§20.4, §20.27)', () => {
  it('watches by mint or asset id, once per asset, and unwatches with a dated removal', async () => {
    const h = harness();
    h.setPending([req('a0000000-0000-4000-8000-000000000001', 'WATCH_ASSET', { mint: MINT, reason: 'listing rumour', note: 'check liquidity Monday', alertRules: { returnPct15m: 5 } })]);
    let r = await runWatchlistCycle(h.deps);
    expect(r.watched).toBe(1);
    expect(h.resolved[0]).toMatchObject({ state: 'ACCEPTED', resolution: { watchId: WATCH, assetId: ASSET } });
    h.setPending([req('a0000000-0000-4000-8000-000000000002', 'WATCH_ASSET', { assetId: ASSET, reason: 'again' })]);
    r = await runWatchlistCycle(h.deps);
    expect(r.refused).toEqual({ ALREADY_WATCHED: 1 });
    h.setPending([req('a0000000-0000-4000-8000-000000000003', 'UNWATCH_ASSET', { watchId: WATCH })]);
    r = await runWatchlistCycle(h.deps);
    expect(r.unwatched).toBe(1);
    expect(h.watches.get(WATCH)?.removed).toBe(true);
    h.setPending([req('a0000000-0000-4000-8000-000000000004', 'UNWATCH_ASSET', { watchId: WATCH })]);
    r = await runWatchlistCycle(h.deps);
    expect(r.refused).toEqual({ UNKNOWN_WATCH: 1 });
  });

  it('refuses unknown assets, malformed payloads and viewers', async () => {
    const h = harness();
    h.setPending([
      req('b0000000-0000-4000-8000-000000000001', 'WATCH_ASSET', { mint: 'not-a-mint', reason: 'x' }),
      req('b0000000-0000-4000-8000-000000000002', 'WATCH_ASSET', { mint: MINT, reason: '' }),
      req('b0000000-0000-4000-8000-000000000003', 'REQUEST_RESEARCH_REFRESH', { assetId: '99999999-9999-4999-8999-999999999999' }),
    ]);
    const r = await runWatchlistCycle(h.deps);
    expect(r.refused).toEqual({ UNKNOWN_ASSET: 2, MALFORMED_PAYLOAD: 1 });
    const v = harness('viewer');
    v.setPending([req('b0000000-0000-4000-8000-000000000004', 'WATCH_ASSET', { mint: MINT, reason: 'x' })]);
    expect((await runWatchlistCycle(v.deps)).refused).toEqual({ NOT_AN_OPERATOR: 1 });
  });

  it('a research refresh only marks the asset due; it never changes eligibility itself', async () => {
    const h = harness();
    h.setPending([req('c0000000-0000-4000-8000-000000000001', 'REQUEST_RESEARCH_REFRESH', { mint: MINT })]);
    const r = await runWatchlistCycle(h.deps);
    expect(r.refreshRequested).toBe(1);
    expect(h.refreshed).toEqual([ASSET]);
    expect(h.resolved[0]).toMatchObject({ state: 'ACCEPTED', resolution: { assetId: ASSET } });
  });
});
