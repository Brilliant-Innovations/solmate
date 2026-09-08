import { addAmounts, compareAmounts, type Amount, type CapitalAuthority, type ProtectionMode } from '@sol-agent-trader/contracts';

/**
 * Signer-outage unprotected-exposure cap (blueprint D33, D51; INV-09). Lots protected only by
 * MONITORED_EXIT depend on the production signer for every exit, so their open cost basis is
 * signer-dependent exposure. A new LIVE_AUTO entry that would itself be MONITORED_EXIT is denied
 * when the total would exceed the cap. Provider-side protection (JUPITER_TRIGGER) does not count.
 */
export interface SignerOutageCapInput {
  capBaseUnits: Amount;
  currentMonitoredExposureBaseUnits: Amount;
  newEntryNotionalBaseUnits: Amount;
  newEntryProtectionMode: ProtectionMode;
  authority: CapitalAuthority;
}

export type SignerOutageCapVerdict = { allowed: true; projectedMonitoredExposure: Amount } | { allowed: false; reason: 'SIGNER_OUTAGE_CAP'; projectedMonitoredExposure: Amount };

export function signerOutageCapVerdict(input: SignerOutageCapInput): SignerOutageCapVerdict {
  const adds = input.authority === 'LIVE_AUTO' && input.newEntryProtectionMode === 'MONITORED_EXIT';
  const projected = adds ? addAmounts(input.currentMonitoredExposureBaseUnits, input.newEntryNotionalBaseUnits) : input.currentMonitoredExposureBaseUnits;
  if (adds && compareAmounts(projected, input.capBaseUnits) > 0) return { allowed: false, reason: 'SIGNER_OUTAGE_CAP', projectedMonitoredExposure: projected };
  return { allowed: true, projectedMonitoredExposure: projected };
}
