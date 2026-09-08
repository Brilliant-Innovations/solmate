import { addMs, fixtures, PositionRiskShadow, type Amount, type Instant, type MintAddress, type Sequence, type Uuid } from '@sol-agent-trader/contracts';
import { buildPositionRiskShadow, shadowFingerprint, type ShadowSourcePosition } from './build.js';

const T0 = fixtures.T0 as Instant;
const USDC = fixtures.MINTS.USDC as MintAddress;
const RISK = fixtures.MINTS.RISK as MintAddress;
const SOL = fixtures.MINTS.SOL as MintAddress;
const pos = (over: Partial<ShadowSourcePosition> = {}): ShadowSourcePosition => ({ positionId: fixtures.IDS.position as Uuid, assetId: fixtures.IDS.asset as Uuid, mint: RISK, quantity: '1000000000' as Amount, stop: { model: 'ATR', level: 96 }, unreviewedStop: 97, lots: [{ lotId: fixtures.IDS.lot as Uuid, quantity: '1000000000' as Amount, protectionMode: 'MONITORED_EXIT', providerOrderId: null }], ...over });

describe('position risk shadow (§15.10A)', () => {
  it('builds a schema-valid, canonically ordered shadow whose fingerprint ignores sequence and time', async () => {
    const a = buildPositionRiskShadow({ sequence: 1 as Sequence, asOf: T0, settlementMints: [USDC], positions: [pos({ positionId: '99999999-9999-4999-8999-999999999999' as Uuid, mint: SOL }), pos()] });
    expect(PositionRiskShadow.parse(a)).toEqual(a);
    expect(a.positions.map((p) => p.mint)).toEqual([RISK, SOL]); // sorted by position id
    expect(a.positions[0]).toMatchObject({ lastConfirmedQuantity: '1000000000', unreviewedStop: 97, stop: { model: 'ATR', level: 96 }, trailingLevel: null, timeStopAt: null, primaryRouteSnapshotId: null });
    const b = buildPositionRiskShadow({ sequence: 2 as Sequence, asOf: addMs(T0, 60_000), settlementMints: [USDC], positions: [pos(), pos({ positionId: '99999999-9999-4999-8999-999999999999' as Uuid, mint: SOL })] });
    expect(await shadowFingerprint(a)).toBe(await shadowFingerprint(b));
    const c = buildPositionRiskShadow({ sequence: 3 as Sequence, asOf: T0, settlementMints: [USDC], positions: [pos({ unreviewedStop: 98 })] });
    expect(await shadowFingerprint(c)).not.toBe(await shadowFingerprint(a));
  });
});
