import fc from 'fast-check';
import { capitalAttestationVerdict } from './capital-attestation.js';

describe('capital attestation ceiling (§29, INV-28)', () => {
  it('property: new exposure is allowed only when a valid ceiling is not crossed and no re-attestation is pending', () => {
    fc.assert(
      fc.property(fc.double({ min: -1, max: 1e7, noNaN: true }), fc.double({ min: -1, max: 1e7, noNaN: true }), fc.boolean(), (ceiling, recognized, reattest) => {
        const v = capitalAttestationVerdict({ ceilingUsd: ceiling, recognizedUsd: recognized, reattestRequired: reattest });
        const valid = ceiling > 0 && recognized >= 0;
        expect(v.allowsNewExposure).toBe(valid && !reattest && recognized <= ceiling);
      }),
    );
    expect(capitalAttestationVerdict({ ceilingUsd: 5000, recognizedUsd: 5001, reattestRequired: false })).toEqual({ allowsNewExposure: false, reason: 'CAPITAL_CEILING_EXCEEDED' });
    expect(capitalAttestationVerdict({ ceilingUsd: 5000, recognizedUsd: 100, reattestRequired: true })).toEqual({ allowsNewExposure: false, reason: 'CAPITAL_REATTEST_REQUIRED' });
    expect(capitalAttestationVerdict({ ceilingUsd: 0, recognizedUsd: 0, reattestRequired: false })).toEqual({ allowsNewExposure: false, reason: 'CAPITAL_ATTESTATION_INVALID' });
  });
});
