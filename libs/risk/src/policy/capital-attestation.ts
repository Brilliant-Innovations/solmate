/**
 * Live capital attestation ceiling (blueprint §29, §31 "post-arm funding or appreciation cannot
 * raise the blast radius above the attested ceiling without blocking new entries"; INV-28).
 * Pure: the projection carries the attested ceiling and the recognized wallet/custody value; new
 * exposure is refused once the ceiling is crossed or re-attestation is pending, while risk
 * reduction is never blocked (D31).
 */
export interface CapitalAttestationFacts {
  ceilingUsd: number;
  recognizedUsd: number;
  reattestRequired: boolean;
}

export type CapitalAttestationVerdict = { allowsNewExposure: true } | { allowsNewExposure: false; reason: 'CAPITAL_REATTEST_REQUIRED' | 'CAPITAL_CEILING_EXCEEDED' | 'CAPITAL_ATTESTATION_INVALID' };

export function capitalAttestationVerdict(facts: CapitalAttestationFacts): CapitalAttestationVerdict {
  if (!(facts.ceilingUsd > 0) || !Number.isFinite(facts.ceilingUsd) || !Number.isFinite(facts.recognizedUsd) || facts.recognizedUsd < 0) return { allowsNewExposure: false, reason: 'CAPITAL_ATTESTATION_INVALID' };
  if (facts.reattestRequired) return { allowsNewExposure: false, reason: 'CAPITAL_REATTEST_REQUIRED' };
  if (facts.recognizedUsd > facts.ceilingUsd) return { allowsNewExposure: false, reason: 'CAPITAL_CEILING_EXCEEDED' };
  return { allowsNewExposure: true };
}
