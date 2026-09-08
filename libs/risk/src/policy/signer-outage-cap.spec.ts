import fc from 'fast-check';
import type { Amount } from '@sol-agent-trader/contracts';
import { signerOutageCapVerdict } from './signer-outage-cap.js';

describe('signer-outage unprotected-exposure cap (D33, D51; INV-09)', () => {
  it('property: only a LIVE_AUTO MONITORED_EXIT entry adds to signer-dependent exposure, and it is refused exactly when the total would exceed the cap', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.constantFrom('MONITORED_EXIT', 'JUPITER_TRIGGER'), fc.constantFrom('LIVE_AUTO', 'LIVE_APPROVAL', 'PAPER'), (cap, current, size, mode, authority) => {
        const v = signerOutageCapVerdict({ capBaseUnits: cap.toString() as Amount, currentMonitoredExposureBaseUnits: current.toString() as Amount, newEntryNotionalBaseUnits: size.toString() as Amount, newEntryProtectionMode: mode as never, authority: authority as never });
        const adds = authority === 'LIVE_AUTO' && mode === 'MONITORED_EXIT';
        expect(BigInt(v.projectedMonitoredExposure)).toBe(adds ? current + size : current);
        expect(v.allowed).toBe(!(adds && current + size > cap));
      }),
    );
  });
});
