import { fixedClock, fixtures, type Amount, type Instant, type MintAddress, type Uuid } from '@sol-agent-trader/contracts';
import type { OpenPositionRow, PendingControlRequest } from '@sol-agent-trader/db/server';
import { createLogger } from '@sol-agent-trader/observability';
import { reduceQuantity, runManualActionsCycle, type ManualActionsDeps } from './manual-actions.js';

const { IDS } = fixtures;
const T0 = fixtures.T0 as Instant;
const logger = createLogger({ service: 'worker', minLevel: 'error' });
const POS2 = '00000000-0000-4000-8000-00000000f002' as Uuid;
const position = (id: Uuid, quantity: string): OpenPositionRow => ({ id, accountId: IDS.account as Uuid, assetId: IDS.asset as Uuid, mint: fixtures.MINTS.RISK as MintAddress, decimals: 6, symbol: 'RISK', quantity: quantity as Amount, averageEntryPrice: 1, costBasisBaseUnits: '1000000' as Amount, realizedPnlBaseUnits: '0' as never, stop: null, target: null, unreviewedStop: null, safetyState: 'NORMAL' as never, openedAt: T0, lots: [{ id: IDS.lot as Uuid, sleeveId: IDS.sleeve as Uuid, strategyVersionId: 'S0_SAFE@1.2.0' as never, quantity: quantity as Amount, costBasisBaseUnits: '1000000' as Amount, entryIntentId: IDS.intent as Uuid }] });
const request = (kind: PendingControlRequest['kind'], payload: Record<string, unknown>, id = IDS.message as Uuid): PendingControlRequest => ({ id, requestedBy: IDS.operator as Uuid, kind, payload, createdAt: T0 });

function fake(requests: PendingControlRequest[], over: { role?: 'operator' | 'admin' | 'viewer' | null; positions?: OpenPositionRow[]; exitResult?: 'FILLED' | 'NOT_FILLED' | Error } = {}) {
  const exits: { positionId: Uuid; action: string; fraction: number; requested: string; reason: string }[] = [];
  const resolutions: { id: Uuid; state: string; resolution: Record<string, unknown> }[] = [];
  const deps: ManualActionsDeps = {
    repo: {
      async listPending() { return requests; },
      async operatorRole() { return over.role === undefined ? 'operator' : over.role; },
      async listOpenPositions() { return over.positions ?? [position(IDS.position as Uuid, '1000000')]; },
      async resolve(id, state, resolution) { resolutions.push({ id, state, resolution }); return true; },
    },
    async exit(p, action, fraction, requested, reason) { exits.push({ positionId: p.id, action, fraction, requested, reason }); if (over.exitResult instanceof Error) throw over.exitResult; return over.exitResult ?? 'FILLED'; },
    clock: fixedClock(T0),
    logger,
    config: { batchSize: 10, maxOpenPositions: 100 },
  };
  return { deps, exits, resolutions };
}

describe('manual close / reduce / emergency close-all (§14.8, §20.8)', () => {
  it('MANUAL_CLOSE exits the whole position through the deterministic path and records the result on the request', async () => {
    const f = fake([request('MANUAL_CLOSE', { positionId: IDS.position })]);
    const r = await runManualActionsCycle(f.deps);
    expect(r).toMatchObject({ requests: 1, filled: 1, notFilled: 0, refused: {}, errors: [] });
    expect(f.exits).toEqual([{ positionId: IDS.position, action: 'EXIT', fraction: 1, requested: '1000000', reason: 'MANUAL_CLOSE' }]);
    expect(f.resolutions[0]).toMatchObject({ state: 'ACCEPTED', resolution: { positionId: IDS.position, action: 'EXIT', result: 'FILLED' } });
  });

  it('MANUAL_REDUCE sizes from the fraction, floors to base units and refuses fractions outside (0, 1)', async () => {
    const f = fake([request('MANUAL_REDUCE', { positionId: IDS.position, fraction: 0.4 })]);
    await runManualActionsCycle(f.deps);
    expect(f.exits).toEqual([{ positionId: IDS.position, action: 'REDUCE', fraction: 0.4, requested: '400000', reason: 'MANUAL_REDUCE' }]);
    expect(reduceQuantity('7' as Amount, 0.5)).toBe('3');
    for (const fraction of [0, 1, 1.5, -0.2, 'half']) {
      const g = fake([request('MANUAL_REDUCE', { positionId: IDS.position, fraction })]);
      const r = await runManualActionsCycle(g.deps);
      expect(r.refused, String(fraction)).toEqual({ MALFORMED_PAYLOAD: 1 });
      expect(g.exits, String(fraction)).toEqual([]);
    }
    const tiny = fake([request('MANUAL_REDUCE', { positionId: IDS.position, fraction: 0.0000001 })]);
    expect((await runManualActionsCycle(tiny.deps)).refused).toEqual({ REDUCTION_ROUNDS_TO_ZERO: 1 });
  });

  it('refuses a viewer, an unknown user, a missing positionId and a position that is not open', async () => {
    expect((await runManualActionsCycle(fake([request('MANUAL_CLOSE', { positionId: IDS.position })], { role: 'viewer' }).deps)).refused).toEqual({ NOT_AN_OPERATOR: 1 });
    expect((await runManualActionsCycle(fake([request('MANUAL_CLOSE', { positionId: IDS.position })], { role: null }).deps)).refused).toEqual({ NOT_AN_OPERATOR: 1 });
    expect((await runManualActionsCycle(fake([request('MANUAL_CLOSE', {})]).deps)).refused).toEqual({ MALFORMED_PAYLOAD: 1 });
    expect((await runManualActionsCycle(fake([request('MANUAL_CLOSE', { positionId: POS2 })]).deps)).refused).toEqual({ POSITION_NOT_OPEN: 1 });
  });

  it('a NOT_FILLED exit is still an accepted request with the outcome recorded; an exit error is reported and the request stays pending', async () => {
    const nf = fake([request('MANUAL_CLOSE', { positionId: IDS.position })], { exitResult: 'NOT_FILLED' });
    const r1 = await runManualActionsCycle(nf.deps);
    expect(r1).toMatchObject({ filled: 0, notFilled: 1 });
    expect(nf.resolutions[0]).toMatchObject({ state: 'ACCEPTED', resolution: { result: 'NOT_FILLED' } });
    const boom = fake([request('MANUAL_CLOSE', { positionId: IDS.position })], { exitResult: new Error('adapter down') });
    const r2 = await runManualActionsCycle(boom.deps);
    expect(r2.errors).toEqual([{ requestId: IDS.message, error: 'adapter down' }]);
    expect(boom.resolutions).toEqual([]);
  });

  it('EMERGENCY_CLOSE_ALL exits every open position, continues past one failure and records every outcome', async () => {
    const positions = [position(IDS.position as Uuid, '1000000'), position(POS2, '500')];
    let n = 0;
    const f = fake([request('EMERGENCY_CLOSE_ALL', {})], { role: 'admin', positions });
    f.deps.exit = async (p, action, fraction, requested, reason) => { n++; if (p.id === POS2) throw new Error('no route'); f.exits.push({ positionId: p.id, action, fraction, requested, reason }); return 'FILLED'; };
    const r = await runManualActionsCycle(f.deps);
    expect(n).toBe(2);
    expect(r).toMatchObject({ filled: 1, notFilled: 0, errors: [] });
    expect(f.exits).toEqual([{ positionId: IDS.position, action: 'EXIT', fraction: 1, requested: '1000000', reason: 'MANUAL_EMERGENCY_CLOSE_ALL' }]);
    expect(f.resolutions[0]).toMatchObject({ state: 'ACCEPTED', resolution: { positions: 2, results: [{ positionId: IDS.position, result: 'FILLED' }, { positionId: POS2, result: 'ERROR', error: 'no route' }] } });
  });
});
