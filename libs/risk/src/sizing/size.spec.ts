import fc from 'fast-check';
import { DEFAULT_RISK_POLICY, type Amount } from '@sol-agent-trader/contracts';
import { computePositionSize, type SizingInputs } from './size.js';

const amt = (n: bigint) => n.toString() as Amount;
const base = (over: Partial<SizingInputs> = {}): SizingInputs => ({
  policy: DEFAULT_RISK_POLICY,
  equityBaseUnits: amt(10_000_000_000n), // 10 000 USDC
  stopDistanceFraction: 0.05,
  sleeve: { capRemainingBaseUnits: amt(2_000_000_000n), riskRemainingBaseUnits: amt(100_000_000n) },
  cohortRemainingBaseUnits: amt(1_500_000_000n),
  clusterRemainingBaseUnits: amt(1_500_000_000n),
  liquidityBaseUnits: amt(500_000_000_000n), // 500k USDC liquidity → 0.5 % cap = 2 500 USDC
  availableCapitalBaseUnits: amt(5_000_000_000n),
  ...over,
});

describe('position sizing (§13.3, INV-02, ADR-0007, ADR-0009 P1)', () => {
  it('follows the blueprint formula and names the binding constraint', () => {
    const r = computePositionSize(base());
    // risk budget = min(10 000 × 0.5 %, sleeve risk 100) = 50 USDC; size by stop = 50 / 0.05 = 1 000 USDC
    expect(r.riskBudgetBaseUnits).toBe('50000000');
    expect(r.sizeByStopBaseUnits).toBe('1000000000');
    // max position value (200 USDC) binds
    expect(r.sizeBaseUnits).toBe('200000000');
    expect(r.binding).toBe('MAX_POSITION_VALUE');
    const wide = computePositionSize(base({ policy: { ...DEFAULT_RISK_POLICY, maxPositionValueBaseUnits: amt(10_000_000_000n) } }));
    expect(wide.sizeBaseUnits).toBe('1000000000');
    expect(wide.binding).toBe('RISK_BUDGET_BY_STOP');
  });

  it('INV-02 property: the size never exceeds any cap, the stop-derived budget, or available capital; zero stop distance or zero equity sizes to zero', () => {
    const a = fc.bigInt({ min: 0n, max: 10n ** 12n });
    fc.assert(
      fc.property(a, a, a, a, a, a, a, fc.double({ min: 0.001, max: 0.5, noNaN: true }), (equity, sleeveCap, sleeveRisk, cohort, cluster, liq, avail, stop) => {
        const r = computePositionSize(base({ equityBaseUnits: amt(equity), sleeve: { capRemainingBaseUnits: amt(sleeveCap), riskRemainingBaseUnits: amt(sleeveRisk) }, cohortRemainingBaseUnits: amt(cohort), clusterRemainingBaseUnits: amt(cluster), liquidityBaseUnits: amt(liq), availableCapitalBaseUnits: amt(avail), stopDistanceFraction: stop }));
        const size = BigInt(r.sizeBaseUnits);
        expect(size <= BigInt(r.sizeByStopBaseUnits)).toBe(true);
        expect(size <= sleeveCap).toBe(true);
        expect(size <= BigInt(DEFAULT_RISK_POLICY.maxPositionValueBaseUnits)).toBe(true);
        expect(size <= cohort && size <= cluster && size <= avail).toBe(true);
        expect(size <= (liq * 5000n) / 1_000_000n).toBe(true);
        // The loss at the stop never exceeds the risk budget (FLOOR makes it at most equal).
        expect((size * BigInt(Math.round(stop * 1_000_000))) / 1_000_000n <= BigInt(r.riskBudgetBaseUnits)).toBe(true);
      }),
    );
    expect(computePositionSize(base({ stopDistanceFraction: 0 })).sizeBaseUnits).toBe('0');
    expect(computePositionSize(base({ stopDistanceFraction: Number.NaN })).sizeBaseUnits).toBe('0');
    expect(computePositionSize(base({ equityBaseUnits: amt(0n) })).sizeBaseUnits).toBe('0');
  });

  it('ADR-0007: with cohort capacity required, an unknown cohort or cluster is the most restrictive cap (zero); unknown liquidity always caps at zero', () => {
    const strict = { ...DEFAULT_RISK_POLICY, requireCohortCapacity: true };
    expect(computePositionSize(base({ policy: strict, cohortRemainingBaseUnits: null }))).toMatchObject({ sizeBaseUnits: '0', binding: 'COHORT_REMAINING', unknownCapacity: 'COHORT' });
    expect(computePositionSize(base({ policy: strict, clusterRemainingBaseUnits: null }))).toMatchObject({ sizeBaseUnits: '0', binding: 'CLUSTER_REMAINING', unknownCapacity: 'CLUSTER' });
    expect(computePositionSize(base({ cohortRemainingBaseUnits: null })).unknownCapacity).toBeNull();
    expect(computePositionSize(base({ liquidityBaseUnits: null }))).toMatchObject({ sizeBaseUnits: '0', binding: 'LIQUIDITY_CAP' });
  });

  it('ADR-0009 P1: pending exposure reduces available capital before sizing, so two authorizations cannot both take the last of it', () => {
    const avail = 150_000_000n; // 150 USDC left
    const first = computePositionSize(base({ availableCapitalBaseUnits: amt(avail), liquidityBaseUnits: amt(10n ** 12n), policy: { ...DEFAULT_RISK_POLICY, maxPositionValueBaseUnits: amt(120_000_000n) } }));
    expect(first.sizeBaseUnits).toBe('120000000');
    const afterPending = avail - BigInt(first.sizeBaseUnits);
    const second = computePositionSize(base({ availableCapitalBaseUnits: amt(afterPending), liquidityBaseUnits: amt(10n ** 12n), policy: { ...DEFAULT_RISK_POLICY, maxPositionValueBaseUnits: amt(120_000_000n) } }));
    expect(second.sizeBaseUnits).toBe('30000000');
    expect(second.binding).toBe('AVAILABLE_CAPITAL');
    expect(BigInt(first.sizeBaseUnits) + BigInt(second.sizeBaseUnits) <= avail).toBe(true);
  });
});
