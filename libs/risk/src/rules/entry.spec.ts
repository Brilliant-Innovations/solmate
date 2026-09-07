import fc from 'fast-check';
import { addMs, DEFAULT_RISK_POLICY, toInstant, type Amount, type Bps, type MintAddress, type Uuid } from '@sol-agent-trader/contracts';
import { evaluateEntry, type EntryProposal, type PortfolioState } from './entry.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const amt = (n: bigint) => n.toString() as Amount;
const ID = '11111111-1111-4111-8111-111111111111' as Uuid;

const state = (over: Partial<PortfolioState> = {}): PortfolioState => ({
  settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as MintAddress,
  settlementDecimals: 6,
  equityBaseUnits: amt(10_000_000_000n),
  exposureBaseUnits: amt(0n),
  pendingExposureBaseUnits: amt(0n),
  inFlightExposureIncreasing: 0,
  openPositions: 0,
  assetExposureBaseUnits: amt(0n),
  settlementAvailableBaseUnits: amt(10_000_000_000n),
  gasReserveLamports: amt(100_000_000n),
  sleeve: { id: ID, active: true, capRemainingBaseUnits: amt(2_000_000_000n), riskRemainingBaseUnits: amt(100_000_000n) },
  cohort: null,
  cluster: null,
  drawdown: { dailyFraction: 0, rollingFraction: 0, consecutiveLosses: 0, circuitBreakerTripped: false, breakerTrippedAt: null },
  health: { feedsBlockEntries: false, staleDataClasses: [{ dataClass: 'CANDIDATE_PRICE', ageMs: 3_000, limitMs: 15_000 }], reconciliationClean: true, dbAvailable: true, executionAnomalies: 0, providerAuthFailure: false, clockDriftMs: 0, operatorKill: false, sessionAllowsEntries: true },
  ...over,
});
const proposal = (over: Partial<EntryProposal> = {}): EntryProposal => ({
  id: ID, proposalId: ID, actionCycleId: ID, assetId: ID,
  eligibility: { allowed: true }, eligibilityEvaluationId: ID,
  proposalExpiresAt: addMs(NOW, 60_000), proposalPriceUsd: 1,
  quote: { ageMs: 2_000, impactBps: 20 as Bps, slippageBps: 50 as Bps, priceUsd: 1.002 },
  token2022Compatible: true, duplicateIntent: false, liquidityUsd: 500_000, atrPct: 0.02, structureLowPriceUsd: null, expectedRewardFraction: null,
  ...over,
});

describe('deterministic entry evaluation (§13.1–13.6, INV-02, INV-03, ADR-0009 P1)', () => {
  it('a clean proposal is allowed with a sized amount, a stop, a target policy and a max loss at or below the risk budget', () => {
    const r = evaluateEntry(DEFAULT_RISK_POLICY, state(), proposal(), NOW);
    expect(r.record.allowed).toBe(true);
    expect(r.record.reasonCodes).toEqual([]);
    expect(r.record.computedPositionAmount).toBe('200000000'); // max position value binds
    expect(r.record.stopPolicy).toMatchObject({ model: 'ATR', distanceFraction: 0.04 });
    expect(r.record.targetPolicy?.policy).toBe('TRAILING_AFTER_THRESHOLD');
    expect(BigInt(r.record.computedMaxLossBaseUnits!)).toBeLessThanOrEqual(BigInt(r.sizing!.riskBudgetBaseUnits));
    expect(r.record.policyVersion).toBe('risk-v1');
  });

  it('§13.6 kill conditions and §13.1 portfolio rules refuse with their reasons, and a refusal never carries a size', () => {
    const cases: [Partial<PortfolioState>, string][] = [
      [{ health: { ...state().health, operatorKill: true } }, 'OPERATOR_KILL'],
      [{ health: { ...state().health, sessionAllowsEntries: false } }, 'SESSION_NOT_ACTIVE'],
      [{ health: { ...state().health, reconciliationClean: false } }, 'CUSTODY_MISMATCH'],
      [{ health: { ...state().health, feedsBlockEntries: true } }, 'FEEDS_STALE'],
      [{ health: { ...state().health, dbAvailable: false } }, 'DB_UNAVAILABLE'],
      [{ health: { ...state().health, executionAnomalies: 5 } }, 'EXECUTION_ANOMALIES'],
      [{ health: { ...state().health, clockDriftMs: 60_000 } }, 'CLOCK_DRIFT'],
      [{ drawdown: { ...state().drawdown, dailyFraction: 0.05 } }, 'DRAWDOWN_LIMIT'],
      [{ drawdown: { ...state().drawdown, consecutiveLosses: 3 } }, 'CIRCUIT_BREAKER'],
      [{ drawdown: { ...state().drawdown, breakerTrippedAt: addMs(NOW, -60_000) } }, 'CIRCUIT_BREAKER'],
      [{ inFlightExposureIncreasing: 1 }, 'EXPOSURE_IN_FLIGHT'],
      [{ openPositions: 3 }, 'MAX_POSITIONS'],
      [{ sleeve: { ...state().sleeve!, active: false } }, 'SLEEVE_INACTIVE'],
      [{ gasReserveLamports: amt(1_000n) }, 'GAS_RESERVE'],
      [{ settlementAvailableBaseUnits: amt(10_000_000n) }, 'SETTLEMENT_RESERVE'],
      [{ exposureBaseUnits: amt(5_000_000_000n) }, 'TOTAL_EXPOSURE_CAP'],
      [{ assetExposureBaseUnits: amt(2_000_000_000n) }, 'TOKEN_EXPOSURE_CAP'],
    ];
    for (const [over, reason] of cases) {
      const r = evaluateEntry(DEFAULT_RISK_POLICY, state(over), proposal(), NOW);
      expect(r.record.allowed, reason).toBe(false);
      expect(r.record.reasonCodes, reason).toContain(reason);
      expect(r.record.computedPositionAmount, reason).toBeNull();
    }
  });

  it('§13.2 trade-level rules: eligibility, expiry, stale data, quote age/impact/slippage, chase, Token-2022, reward-to-risk, duplicates', () => {
    const cases: [Partial<EntryProposal>, string][] = [
      [{ eligibility: { allowed: false, reason: 'ELIGIBILITY_STALE' } }, 'NOT_ELIGIBLE'],
      [{ proposalExpiresAt: NOW }, 'PROPOSAL_EXPIRED'],
      [{ quote: null }, 'QUOTE_MISSING'],
      [{ quote: { ...proposal().quote!, ageMs: 60_000 } }, 'QUOTE_STALE'],
      [{ quote: { ...proposal().quote!, impactBps: 500 as Bps } }, 'IMPACT_ABOVE_MAX'],
      [{ quote: { ...proposal().quote!, impactBps: null } }, 'IMPACT_ABOVE_MAX'],
      [{ quote: { ...proposal().quote!, slippageBps: 300 as Bps } }, 'SLIPPAGE_ABOVE_MAX'],
      [{ quote: { ...proposal().quote!, priceUsd: 1.02 } }, 'CHASE_EXCEEDED'],
      [{ token2022Compatible: false }, 'TOKEN2022_INCOMPATIBLE'],
      [{ duplicateIntent: true }, 'DUPLICATE_INTENT'],
      [{ expectedRewardFraction: 0.01 }, 'REWARD_RISK_BELOW_MIN'],
      [{ atrPct: null }, 'STOP_UNDEFINED'],
      [{ liquidityUsd: null }, 'SIZE_ZERO'],
    ];
    for (const [over, reason] of cases) {
      const r = evaluateEntry(DEFAULT_RISK_POLICY, state(), proposal(over), NOW);
      expect(r.record.allowed, reason).toBe(false);
      expect(r.record.reasonCodes, reason).toContain(reason);
    }
    const stale = evaluateEntry(DEFAULT_RISK_POLICY, state({ health: { ...state().health, staleDataClasses: [{ dataClass: 'CANDIDATE_PRICE', ageMs: null, limitMs: 15_000 }] } }), proposal(), NOW);
    expect(stale.record.reasonCodes).toContain('DATA_STALE');
    expect(stale.record.staleDataChecks[0]).toMatchObject({ dataClass: 'CANDIDATE_PRICE', fresh: false });
  });

  it('ADR-0009 P1: pending exposure is spent capital — a second proposal while the first is in flight is refused, and even without the in-flight rule the pending amount shrinks what can be sized', () => {
    const first = evaluateEntry(DEFAULT_RISK_POLICY, state({ settlementAvailableBaseUnits: amt(300_000_000n) }), proposal(), NOW);
    expect(first.record.allowed).toBe(true);
    const inFlight = evaluateEntry(DEFAULT_RISK_POLICY, state({ settlementAvailableBaseUnits: amt(300_000_000n), inFlightExposureIncreasing: 1, pendingExposureBaseUnits: first.record.computedPositionAmount! }), proposal(), NOW);
    expect(inFlight.record.reasonCodes).toContain('EXPOSURE_IN_FLIGHT');
    const relaxed = { ...DEFAULT_RISK_POLICY, maxInFlightExposureIncreasing: 2 };
    const second = evaluateEntry(relaxed, state({ settlementAvailableBaseUnits: amt(300_000_000n), inFlightExposureIncreasing: 1, pendingExposureBaseUnits: first.record.computedPositionAmount! }), proposal(), NOW);
    expect(second.record.allowed).toBe(true);
    expect(BigInt(first.record.computedPositionAmount!) + BigInt(second.record.computedPositionAmount!)).toBeLessThanOrEqual(300_000_000n - BigInt(DEFAULT_RISK_POLICY.minSettlementReserveBaseUnits));
  });

  it('INV-02 property: an allowed evaluation never sizes above the sleeve cap, the position cap, the token cap, the total cap or available capital; ADR-0007 unknown cohort refuses when required', () => {
    const a = fc.bigInt({ min: 0n, max: 10n ** 11n });
    fc.assert(
      fc.property(a, a, a, a, fc.double({ min: 0.005, max: 0.2, noNaN: true }), (equity, avail, exposure, sleeveCap, atr) => {
        const s = state({ equityBaseUnits: amt(equity), settlementAvailableBaseUnits: amt(avail), exposureBaseUnits: amt(exposure), sleeve: { ...state().sleeve!, capRemainingBaseUnits: amt(sleeveCap) } });
        const r = evaluateEntry(DEFAULT_RISK_POLICY, s, proposal({ atrPct: atr }), NOW);
        if (!r.record.allowed) return;
        const size = BigInt(r.record.computedPositionAmount!);
        expect(size > 0n).toBe(true);
        expect(size <= sleeveCap).toBe(true);
        expect(size <= BigInt(DEFAULT_RISK_POLICY.maxPositionValueBaseUnits)).toBe(true);
        expect(size <= (equity * 200_000n) / 1_000_000n).toBe(true);
        expect(size + exposure <= (equity * 500_000n) / 1_000_000n).toBe(true);
        expect(size <= avail - BigInt(DEFAULT_RISK_POLICY.minSettlementReserveBaseUnits)).toBe(true);
      }),
    );
    const strict = { ...DEFAULT_RISK_POLICY, requireCohortCapacity: true };
    const unknown = evaluateEntry(strict, state({ cohort: null }), proposal(), NOW);
    expect(unknown.record.reasonCodes).toEqual(expect.arrayContaining(['COHORT_UNKNOWN', 'SIZE_ZERO']));
    const known = evaluateEntry(strict, state({ cohort: { id: 'memes', usedFraction: 0.1 }, cluster: { id: 'c1', usedFraction: 0.1 } }), proposal(), NOW);
    expect(known.record.allowed).toBe(true);
    expect(known.record.cohortExposure).toEqual({ memes: 0.1 });
  });
});
