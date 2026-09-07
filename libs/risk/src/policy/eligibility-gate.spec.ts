import fc from 'fast-check';
import { addMs, DEFAULT_ELIGIBILITY_POLICY, toInstant, type AssetEligibility, type Uuid } from '@sol-agent-trader/contracts';
import { entryAllowed } from './eligibility-gate.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 12, 0, 0));
const record = (over: Partial<AssetEligibility> = {}): AssetEligibility => ({
  id: '33333333-3333-4333-8333-333333333333' as Uuid, assetId: '22222222-2222-4222-8222-222222222222' as Uuid, evaluatedAt: NOW, policyVersion: DEFAULT_ELIGIBILITY_POLICY.version,
  eligible: true, hardReject: false, rejectionReasons: [], grade: 100, liquidityUsd: 1e6, volume24hUsd: 1e6, holderCount: 1000, concentration: null, mintAuthority: 'NONE', freezeAuthority: 'NONE', token2022: null,
  securityFlags: [], transferRestrictions: [], jupiterRouteAvailable: true, settlementRouteConfirmed: true, priceImpactProbes: [], insiderMetrics: null, emergencyExitRouteSnapshotId: null,
  freshness: { securityProviderAt: NOW, chainReadAt: NOW, chainSlot: 1 as never }, ...over,
});

describe('INV-03 entry gate: no entry for an ineligible asset', () => {
  it('allows only a fresh, eligible, non-hard-rejected record from the current policy version', () => {
    expect(entryAllowed(record(), NOW, DEFAULT_ELIGIBILITY_POLICY)).toEqual({ allowed: true });
    expect(entryAllowed(record(), addMs(NOW, DEFAULT_ELIGIBILITY_POLICY.maxEligibilityAgeMs), DEFAULT_ELIGIBILITY_POLICY)).toEqual({ allowed: true });
    expect(entryAllowed(null, NOW, DEFAULT_ELIGIBILITY_POLICY)).toEqual({ allowed: false, reason: 'NO_ELIGIBILITY_RECORD' });
    expect(entryAllowed(record({ eligible: false }), NOW, DEFAULT_ELIGIBILITY_POLICY)).toEqual({ allowed: false, reason: 'NOT_ELIGIBLE' });
    expect(entryAllowed(record({ hardReject: true, eligible: true }), NOW, DEFAULT_ELIGIBILITY_POLICY)).toEqual({ allowed: false, reason: 'HARD_REJECT' });
    expect(entryAllowed(record(), addMs(NOW, DEFAULT_ELIGIBILITY_POLICY.maxEligibilityAgeMs + 1), DEFAULT_ELIGIBILITY_POLICY)).toEqual({ allowed: false, reason: 'ELIGIBILITY_STALE' });
    expect(entryAllowed(record({ policyVersion: 'eligibility-v0' as never }), NOW, DEFAULT_ELIGIBILITY_POLICY)).toEqual({ allowed: false, reason: 'POLICY_VERSION_MISMATCH' });
    expect(entryAllowed(record({ evaluatedAt: addMs(NOW, 1) }), NOW, DEFAULT_ELIGIBILITY_POLICY)).toEqual({ allowed: false, reason: 'EVALUATED_IN_FUTURE' });
  });

  it('property: any record that is not eligible, hard-rejected, or older than the policy allows is refused', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.integer({ min: -1000, max: 2 * DEFAULT_ELIGIBILITY_POLICY.maxEligibilityAgeMs }), (eligible, hardReject, ageMs) => {
        const v = entryAllowed(record({ eligible, hardReject, evaluatedAt: addMs(NOW, -ageMs) }), NOW, DEFAULT_ELIGIBILITY_POLICY);
        const shouldAllow = eligible && !hardReject && ageMs >= 0 && ageMs <= DEFAULT_ELIGIBILITY_POLICY.maxEligibilityAgeMs;
        expect(v.allowed).toBe(shouldAllow);
      }),
    );
  });
});
