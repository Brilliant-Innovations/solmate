import fc from 'fast-check';
import { DEFAULT_MARKET_REGIME_POLICY, type MarketRegime, type Uuid } from '@sol-agent-trader/contracts';
import { classifyRegime, median, relativeStrength, type UniverseAsset } from './regime.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;
const asset = (n: number, ret1h: number | null, cohorts: string[] = [], relVolume60: number | null = 1): UniverseAsset => ({ assetId: id(n), ret1h, relVolume60, cohorts });
const policy = DEFAULT_MARKET_REGIME_POLICY;
const universe = (rets: number[], cohorts: (string[])[] = [], relVol: number[] = []) => rets.map((r, i) => asset(i + 1, r, cohorts[i] ?? [], relVol[i] ?? 1));

describe('deterministic regime classifier (§8.5, D62)', () => {
  it('emits no label below the minimum warm universe, then exactly one label per rule in order', () => {
    expect(classifyRegime({ sol: { ret1h: 0.03 }, assets: universe([0.01, 0.02, 0.03]), policy }).regime).toBeNull();
    const eight = (r: number) => Array(8).fill(r) as number[];
    expect(classifyRegime({ sol: { ret1h: 0.01 }, assets: universe(eight(0.09)), policy }).regime).toBe('VOLATILITY_SHOCK');
    expect(classifyRegime({ sol: { ret1h: -0.06 }, assets: universe(eight(0.001)), policy }).regime).toBe('VOLATILITY_SHOCK');
    expect(classifyRegime({ sol: { ret1h: -0.01 }, assets: universe(eight(-0.03)), policy }).regime).toBe('BROAD_SELLOFF');
    expect(classifyRegime({ sol: { ret1h: 0.03 }, assets: universe(eight(0.005)), policy }).regime).toBe('SOL_LED_RALLY');
    const rotation = universe([0.05, 0.06, 0.05, -0.01, -0.01, 0.001, -0.002, 0.002], [['memes'], ['memes'], ['memes'], [], [], [], [], []]);
    expect(classifyRegime({ sol: { ret1h: 0 }, assets: rotation, policy })).toMatchObject({ regime: 'NARRATIVE_ROTATION', facts: { leadingCohort: { name: 'memes', members: 3 } } });
    expect(classifyRegime({ sol: { ret1h: 0.001 }, assets: universe(eight(0.01)), policy }).regime).toBe('RISK_ON_TREND');
    expect(classifyRegime({ sol: { ret1h: 0 }, assets: universe(eight(0.002), [], eight(0.5)), policy }).regime).toBe('LOW_LIQUIDITY_CHOP');
    expect(classifyRegime({ sol: null, assets: universe([0.02, -0.02, 0.015, -0.015, 0.02, -0.02, 0.01, -0.01]), policy }).regime).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('property: identical inputs give identical labels whatever the asset order; at most one regime; assets without a 1h return never count', () => {
    const regimes: (MarketRegime | null)[] = ['VOLATILITY_SHOCK', 'BROAD_SELLOFF', 'SOL_LED_RALLY', 'NARRATIVE_ROTATION', 'RISK_ON_TREND', 'LOW_LIQUIDITY_CHOP', null];
    fc.assert(
      fc.property(
        fc.array(fc.record({ ret: fc.option(fc.double({ min: -0.2, max: 0.2, noNaN: true }), { nil: null }), vol: fc.double({ min: 0.1, max: 3, noNaN: true }), cohort: fc.option(fc.constantFrom('memes', 'dex'), { nil: null }) }), { minLength: 0, maxLength: 20 }),
        fc.option(fc.double({ min: -0.2, max: 0.2, noNaN: true }), { nil: null }),
        (rows, sol) => {
          const assets = rows.map((r, i) => asset(i + 1, r.ret, r.cohort ? [r.cohort] : [], r.vol));
          const a = classifyRegime({ sol: sol === null ? null : { ret1h: sol }, assets, policy });
          const b = classifyRegime({ sol: sol === null ? null : { ret1h: sol }, assets: [...assets].reverse(), policy });
          expect(regimes).toContain(a.regime);
          expect(b.regime).toBe(a.regime);
          expect(a.facts.assets).toBe(rows.filter((r) => r.ret !== null).length);
          if (a.facts.assets < policy.minAssets) expect(a.regime).toBeNull();
        },
      ),
    );
  });

  it('relative strength subtracts the universe median and the strongest cohort median, and stays null without a return or a two-member cohort', () => {
    const rs = relativeStrength([asset(1, 0.05, ['memes']), asset(2, 0.01, ['memes']), asset(3, -0.02, ['dex']), asset(4, null, ['memes']), asset(5, 0.0, [])]);
    // universe median of [0.05, 0.01, -0.02, 0] = 0.005; memes median of [0.05, 0.01] = 0.03
    expect(rs.get(id(1))!.rsUniverse1h).toBeCloseTo(0.045, 12);
    expect(rs.get(id(1))!.rsCohort1h).toBeCloseTo(0.02, 12);
    expect(rs.get(id(3))).toEqual({ rsUniverse1h: -0.025, rsCohort1h: null });
    expect(rs.get(id(4))).toEqual({ rsUniverse1h: null, rsCohort1h: null });
    expect(rs.get(id(5))!.rsCohort1h).toBeNull();
  });
});
