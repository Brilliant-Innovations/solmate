import { DEFAULT_EMERGENCY_ROUTE_POLICY, fixtures, toInstant, type EmergencyExitRouteSnapshot, type Instant, type MintAddress, type SolanaAddress, type Uuid } from '@sol-agent-trader/contracts';
import { emergencyRoutePermitsEntry, emergencyRouteReadiness } from './emergency-route.js';

const NOW = fixtures.T0 as Instant;
const ago = (ms: number) => toInstant(new Date(Date.parse(NOW) - ms));
const snapshot = (over: Partial<EmergencyExitRouteSnapshot> = {}): EmergencyExitRouteSnapshot => ({
  id: '00000000-0000-4000-8000-000000000001' as Uuid,
  assetId: '00000000-0000-4000-8000-000000000002' as Uuid,
  hops: [{ program: 'RAYDIUM_CPMM', programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' as SolanaAddress, poolAddress: 'AiP94aqcnsxPfHTQLerdwNACedhmEUxMaaSxevS2Drxm' as SolanaAddress, inputMint: 'HKJHsYJHMVK5VRyHHk5GhvzY9tBAAtPvDkZfDH6RLDTd' as MintAddress, outputMint: 'So11111111111111111111111111111111111111112' as MintAddress }],
  settlementMint: 'So11111111111111111111111111111111111111112' as MintAddress,
  poolStateRef: 'slot:1',
  lastRefreshedAt: ago(60_000),
  lastRefreshSlot: 1 as EmergencyExitRouteSnapshot['lastRefreshSlot'],
  capacity: [],
  token2022Compatible: true,
  lastDryRun: { at: ago(60_000), ok: true, simulatedOutputAmount: null, error: null },
  ...over,
});

describe('emergency-route readiness gate (§14.6, D33)', () => {
  const policy = DEFAULT_EMERGENCY_ROUTE_POLICY;
  it('READY only with a fresh, successful dry-run on a supported family; each failure mode names its reason', () => {
    expect(emergencyRouteReadiness(snapshot(), NOW, policy)).toMatchObject({ readiness: 'READY', reason: null, dryRunAgeMs: 60_000 });
    expect(emergencyRouteReadiness(null, NOW, policy).readiness).toBe('MISSING');
    expect(emergencyRouteReadiness(snapshot({ lastDryRun: null }), NOW, policy)).toMatchObject({ readiness: 'STALE', reason: 'no dry-run recorded' });
    expect(emergencyRouteReadiness(snapshot({ lastDryRun: { at: ago(policy.maxDryRunAgeMs + 1), ok: true, simulatedOutputAmount: null, error: null } }), NOW, policy).readiness).toBe('STALE');
    expect(emergencyRouteReadiness(snapshot({ lastDryRun: { at: ago(1000), ok: false, simulatedOutputAmount: null, error: 'pool not tradeable: STATUS_4' } }), NOW, policy)).toMatchObject({ readiness: 'FAILED', reason: 'pool not tradeable: STATUS_4' });
    const dlmm = snapshot({ hops: [{ ...snapshot().hops[0]!, program: 'METEORA_DLMM' }] });
    expect(emergencyRouteReadiness(dlmm, NOW, policy).readiness).toBe('UNSUPPORTED');
  });
  it('gates LIVE_AUTO only: PAPER and LIVE_APPROVAL entries are unaffected', () => {
    const stale = emergencyRouteReadiness(snapshot({ lastDryRun: null }), NOW, policy);
    expect(emergencyRoutePermitsEntry(stale, 'LIVE_AUTO')).toBe(false);
    expect(emergencyRoutePermitsEntry(stale, 'LIVE_APPROVAL')).toBe(true);
    expect(emergencyRoutePermitsEntry(stale, 'PAPER')).toBe(true);
    expect(emergencyRoutePermitsEntry(emergencyRouteReadiness(snapshot(), NOW, policy), 'LIVE_AUTO')).toBe(true);
  });
});
