import fc from 'fast-check';
import { addMs, DEFAULT_SELF_INFLUENCE_POLICY, toInstant, type Bps, type SolanaAddress, type TxSignature, type Uuid } from '@sol-agent-trader/contracts';
import { activeSuppression, excludeSelfFlows, selfInfluenceCheck, suppressionWindow, suppressionWindowMs } from './guard.js';

const NOW = toInstant(Date.UTC(2026, 8, 7, 18, 0, 0));
const ASSET = '22222222-2222-4222-8222-222222222222' as Uuid;
const OTHER_ASSET = '33333333-3333-4333-8333-333333333333' as Uuid;
const OWNED = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' as SolanaAddress;
const STRANGER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as SolanaAddress;
const OUR_SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as TxSignature;
const THEIR_SIG = '4EWYrAvnHDA4ZgNGUgqdGsJ5DNKk4bT5hyGTLnRGT3GStpDDNXEWNq9vEaSZmiqPHJ5j6zDAZ3G1XFRa7wDbBqyz' as TxSignature;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sig = fc.string({ minLength: 87, maxLength: 87, unit: fc.constantFrom(...ALPHABET.split('')) }).map((s) => s as TxSignature);
const addr = fc.string({ minLength: 40, maxLength: 40, unit: fc.constantFrom(...ALPHABET.split('')) }).map((s) => s as SolanaAddress);

const ctx = (over: Partial<Parameters<typeof selfInfluenceCheck>[1]> = {}) => ({ isOwned: (a: string) => a === OWNED, ownSignatures: new Set<string>([OUR_SIG]), windows: [], now: NOW, ...over });

describe('self-influence guard (D26, §8.6, INV-11)', () => {
  it('property: a candidate citing any own transaction or owned wallet as evidence is never allowed', () => {
    fc.assert(
      fc.property(fc.array(sig, { maxLength: 5 }), fc.array(addr, { maxLength: 5 }), fc.boolean(), fc.boolean(), (sigs, wallets, plantSig, plantWallet) => {
        const evidence = { assetId: ASSET, evidenceSignatures: plantSig ? [...sigs, OUR_SIG] : sigs, evidenceWallets: plantWallet ? [OWNED, ...wallets] : wallets, usesAggregateMetrics: false };
        const v = selfInfluenceCheck(evidence, ctx());
        if (plantSig || plantWallet) {
          expect(v.allowed).toBe(false);
          if (!v.allowed) expect(['SELF_TRANSACTION_AS_EVIDENCE', 'OWNED_WALLET_AS_EVIDENCE']).toContain(v.reason);
        } else {
          expect(v.allowed).toBe(true);
        }
      }),
    );
  });

  it('own flows are excluded from external evidence on either side', () => {
    const flows = [
      { fromOwner: STRANGER, toOwner: OWNED, amount: 1 },
      { fromOwner: OWNED, toOwner: STRANGER, amount: 2 },
      { fromOwner: STRANGER, toOwner: null, amount: 3 },
      { fromOwner: STRANGER, toOwner: STRANGER, amount: 4 },
    ];
    expect(excludeSelfFlows(flows, (a) => a === OWNED).map((f) => f.amount)).toEqual([3, 4]);
  });

  it('the suppression window grows with our impact, is floored by the base window and capped, and only blocks aggregate-metric triggers on that asset', () => {
    const p = DEFAULT_SELF_INFLUENCE_POLICY;
    expect(suppressionWindowMs(p, 0)).toBe(p.baseWindowMs);
    expect(suppressionWindowMs(p, p.impactFloorBps)).toBe(p.baseWindowMs);
    expect(suppressionWindowMs(p, p.impactFloorBps + 10)).toBe(p.baseWindowMs + 10 * p.perImpactBpsMs);
    expect(suppressionWindowMs(p, 100_000)).toBe(p.maxWindowMs);
    fc.assert(
      fc.property(fc.nat({ max: 5000 }), fc.nat({ max: 5000 }), (a, b) => {
        expect(suppressionWindowMs(p, Math.max(a, b))).toBeGreaterThanOrEqual(suppressionWindowMs(p, Math.min(a, b)));
      }),
    );

    const w = suppressionWindow(p, { assetId: ASSET, signature: OUR_SIG, filledAt: NOW, estimatedImpactBps: 25 as Bps });
    expect(w.until).toBe(addMs(NOW, p.baseWindowMs + 20 * p.perImpactBpsMs));
    const inside = addMs(NOW, 60_000);
    expect(activeSuppression([w], ASSET, inside)).toEqual(w);
    expect(activeSuppression([w], OTHER_ASSET, inside)).toBeNull();
    expect(activeSuppression([w], ASSET, w.until)).toBeNull();

    const aggregate = { assetId: ASSET, evidenceSignatures: [THEIR_SIG], evidenceWallets: [STRANGER], usesAggregateMetrics: true };
    expect(selfInfluenceCheck(aggregate, ctx({ windows: [w], now: inside }))).toMatchObject({ allowed: false, reason: 'SELF_TRADE_SUPPRESSION_WINDOW' });
    // A trigger built purely on identified external transactions may still complete inside the window (§8.6 last bullet).
    expect(selfInfluenceCheck({ ...aggregate, usesAggregateMetrics: false }, ctx({ windows: [w], now: inside }))).toEqual({ allowed: true });
    expect(selfInfluenceCheck({ ...aggregate, assetId: OTHER_ASSET }, ctx({ windows: [w], now: inside }))).toEqual({ allowed: true });
    expect(selfInfluenceCheck(aggregate, ctx({ windows: [w], now: w.until }))).toEqual({ allowed: true });
  });
});
