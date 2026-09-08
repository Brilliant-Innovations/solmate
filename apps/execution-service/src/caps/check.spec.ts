import fc from 'fast-check';
import { fixtures, toInstant, type Amount, type Bps, type ExecutorGuardrails, type KeyId, type MintAddress, type RiskAuthorizedIntent, type Uuid } from '@sol-agent-trader/contracts';
import { checkCaps } from './check.js';
import { ExecutorExposureLedger } from './exposure-ledger.js';

const NOW = toInstant(Date.UTC(2026, 8, 8, 15, 0, 0));
const guardrails: ExecutorGuardrails = {
  liveCapabilityEnabled: true, cluster: 'mainnet-beta', tradingWalletAddress: fixtures.MINTS.RISK as never, allowedSettlementMints: [fixtures.MINTS.USDC as MintAddress], allowedFundingMints: [fixtures.MINTS.USDC as MintAddress],
  maxPerEntryNotionalBaseUnits: '300000000', maxAggregateNonSettlementExposureBaseUnits: '900000000', maxSignerOutageUnprotectedExposureBaseUnits: '400000000', maxEmergencyCloseTxBaseUnits: null,
  hardMaxSlippageBps: 150 as Bps, hardMaxProtectiveSlippageBps: 300 as Bps, acceptedRiskAuthorizerKeyIds: ['ed25519:' + '0'.repeat(32) as KeyId], acceptedEmergencyOperatorKeyIds: ['ed25519:' + '1'.repeat(32) as KeyId], expectedSignerPolicyDigest: null, expectedSignerWorkloadFingerprint: null,
};
const intent = (over: Partial<RiskAuthorizedIntent> = {}): RiskAuthorizedIntent => ({ ...fixtures.riskAuthorizedIntent(), ...over });
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as Uuid;

describe('executor absolute caps and exposure ledger (§13.7, §26.2, D33; INV-08, INV-09)', () => {
  it('the ledger measures open exposure conservatively and releases it on exit or failure; a mark can only escalate', () => {
    const l = new ExecutorExposureLedger();
    l.apply({ kind: 'ENTRY_AUTHORIZED', at: NOW, intentId: id(1), mint: fixtures.MINTS.RISK as MintAddress, notional: '250000000' as Amount, protectionMode: 'MONITORED_EXIT' });
    expect(l.aggregateNonSettlementExposure()).toBe('250000000');
    l.apply({ kind: 'ENTRY_CONFIRMED', at: NOW, intentId: id(1), costBasis: '240000000' as Amount }); // filled below the authorized notional: the larger view stays
    expect(l.aggregateNonSettlementExposure()).toBe('250000000');
    l.apply({ kind: 'ENTRY_AUTHORIZED', at: NOW, intentId: id(2), mint: fixtures.MINTS.RISK as MintAddress, notional: '100000000' as Amount, protectionMode: 'JUPITER_TRIGGER' });
    l.apply({ kind: 'ENTRY_CONFIRMED', at: NOW, intentId: id(2), costBasis: '120000000' as Amount }); // filled above: cost basis wins
    expect(l.aggregateNonSettlementExposure()).toBe('370000000');
    expect(l.signerDependentExposure()).toBe('250000000');
    l.apply({ kind: 'EXIT_CONFIRMED', at: NOW, intentId: id(1), costReleased: '250000000' as Amount });
    expect(l.openIntents()).toEqual([id(2)]);
    l.apply({ kind: 'ENTRY_RELEASED', at: NOW, intentId: id(2), reason: 'NOT_LANDED' });
    expect(l.aggregateNonSettlementExposure()).toBe('0');
    expect(ExecutorExposureLedger.replay(l.history()).aggregateNonSettlementExposure()).toBe('0');
    expect(() => l.apply({ kind: 'ENTRY_AUTHORIZED', at: NOW, intentId: id(2), mint: fixtures.MINTS.RISK as MintAddress, notional: '1' as Amount, protectionMode: 'MONITORED_EXIT' })).not.toThrow();
    expect(() => l.apply({ kind: 'ENTRY_AUTHORIZED', at: NOW, intentId: id(2), mint: fixtures.MINTS.RISK as MintAddress, notional: '1' as Amount, protectionMode: 'MONITORED_EXIT' })).toThrow(/already open/);
  });

  it('INV-08: the deployment caps bound every entry whatever the database policy says, from the local ledger, with mark-to-market only ever stricter', () => {
    const l = new ExecutorExposureLedger();
    const ok = checkCaps({ guardrails, ledger: l, intent: intent(), protectionMode: 'JUPITER_TRIGGER', markToMarketExposure: null });
    expect(ok).toEqual({ ok: true, projectedAggregate: '250000000' });
    const cases: [Partial<RiskAuthorizedIntent>, string][] = [
      [{ maxInputAmount: '300000001' as Amount }, 'PER_ENTRY_CAP'],
      [{ cluster: 'devnet' }, 'CLUSTER_MISMATCH'],
      [{ inputMint: fixtures.MINTS.RISK as MintAddress }, 'SETTLEMENT_MINT_NOT_ALLOWED'],
      [{ maxSlippageBps: 200 as Bps }, 'SLIPPAGE_ABOVE_HARD_MAX'],
    ];
    for (const [over, reason] of cases) {
      const v = checkCaps({ guardrails, ledger: l, intent: intent(over), protectionMode: 'JUPITER_TRIGGER', markToMarketExposure: null });
      expect(v.ok, reason).toBe(false);
      if (!v.ok) expect(v.reasons, reason).toContain(reason);
    }
    // aggregate: three 250 entries (750) sit under 900; a fourth (1 000) does not, and a mark of 800 refuses a third
    for (let i = 1; i <= 3; i++) l.apply({ kind: 'ENTRY_AUTHORIZED', at: NOW, intentId: id(i), mint: fixtures.MINTS.RISK as MintAddress, notional: '250000000' as Amount, protectionMode: 'JUPITER_TRIGGER' });
    const fourth = checkCaps({ guardrails, ledger: l, intent: intent(), protectionMode: 'JUPITER_TRIGGER', markToMarketExposure: null });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reasons).toEqual(['AGGREGATE_EXPOSURE_CAP']);
    const two = ExecutorExposureLedger.replay(l.history().slice(0, 2));
    expect(checkCaps({ guardrails, ledger: two, intent: intent(), protectionMode: 'JUPITER_TRIGGER', markToMarketExposure: null }).ok).toBe(true);
    const marked = checkCaps({ guardrails, ledger: two, intent: intent(), protectionMode: 'JUPITER_TRIGGER', markToMarketExposure: '800000000' as Amount });
    expect(marked.ok).toBe(false);
    if (!marked.ok) expect(marked.detail[0]).toContain('mark-to-market escalated');
    // a lower mark never loosens
    expect(checkCaps({ guardrails, ledger: l, intent: intent(), protectionMode: 'JUPITER_TRIGGER', markToMarketExposure: '0' as Amount }).ok).toBe(false);
    // live capability off refuses live entries outright
    expect(checkCaps({ guardrails: { ...guardrails, liveCapabilityEnabled: false }, ledger: new ExecutorExposureLedger(), intent: intent(), protectionMode: 'JUPITER_TRIGGER', markToMarketExposure: null }).ok).toBe(false);
  });

  it('INV-09 property: a LIVE_AUTO MONITORED_EXIT entry never pushes signer-dependent exposure above the outage cap; provider-protected entries and LIVE_APPROVAL do not count', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 200_000_000n }), { maxLength: 4 }), fc.bigInt({ min: 1n, max: 300_000_000n }), fc.constantFrom('MONITORED_EXIT', 'JUPITER_TRIGGER'), fc.constantFrom('LIVE_AUTO', 'LIVE_APPROVAL'), (existing, size, mode, authority) => {
        const l = new ExecutorExposureLedger();
        existing.forEach((n, i) => l.apply({ kind: 'ENTRY_AUTHORIZED', at: NOW, intentId: id(i + 1), mint: fixtures.MINTS.RISK as MintAddress, notional: n.toString() as Amount, protectionMode: 'MONITORED_EXIT' }));
        const v = checkCaps({ guardrails, ledger: l, intent: intent({ maxInputAmount: size.toString() as Amount, capitalAuthority: authority as never, approvalRequired: authority === 'LIVE_APPROVAL' }), protectionMode: mode as never, markToMarketExposure: null });
        const monitored = existing.reduce((a, b) => a + b, 0n);
        const breaches = authority === 'LIVE_AUTO' && mode === 'MONITORED_EXIT' && monitored + size > 400_000_000n;
        const flagged = !v.ok && v.reasons.includes('SIGNER_OUTAGE_CAP');
        expect(flagged).toBe(breaches);
      }),
    );
  });
});
