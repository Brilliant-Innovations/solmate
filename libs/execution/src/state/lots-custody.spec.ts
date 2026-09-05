import fc from 'fast-check';
import { fixtures, type Amount, type MintAddress, type SolanaAddress, type TransactionClass, type Uuid } from '@sol-agent-trader/contracts';
import { classifyMovement, type RegisteredCustody } from './custody.js';
import { aggregateQuantity, allocateExit, applyProviderFill, type LotBalance } from './position-lot.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Uuid;
const amt = (n: bigint) => n.toString() as Amount;

describe('position lots (D24, D44)', () => {
  const lotsArb = fc
    .array(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: 1, maxLength: 6 })
    .map((qs) => qs.map((q, i): LotBalance => ({ lotId: uuid(i), sleeveId: uuid(100 + (i % 2)), quantity: amt(q) })));

  it('exits conserve quantity, never go negative and never touch unnamed lots', () => {
    fc.assert(
      fc.property(lotsArb, fc.array(fc.record({ i: fc.nat(5), frac: fc.double({ min: 0, max: 1.5, noNaN: true }) }), { maxLength: 4 }), (lots, reqs) => {
        const requested = reqs
          .filter((r) => r.i < lots.length)
          .map((r) => ({ lotId: lots[r.i].lotId, quantity: amt(BigInt(Math.floor(Number(lots[r.i].quantity) * r.frac))) }));
        const result = allocateExit(lots, requested);
        const before = BigInt(aggregateQuantity(lots));
        if (result.ok) {
          const total = requested.reduce((acc, r) => acc + BigInt(r.quantity), 0n);
          expect(BigInt(aggregateQuantity(result.lots))).toBe(before - total);
          for (const l of result.lots) expect(BigInt(l.quantity) >= 0n).toBe(true);
          const named = new Set(requested.map((r) => r.lotId));
          for (const l of result.lots) if (!named.has(l.lotId)) expect(l.quantity).toBe(lots.find((x) => x.lotId === l.lotId)?.quantity);
        } else {
          // the only reasons to fail are zero, unknown or over-allocation; and the input is untouched
          expect(['ZERO_QUANTITY', 'UNKNOWN_LOT', 'INSUFFICIENT_LOT_QUANTITY']).toContain(result.code);
          expect(BigInt(aggregateQuantity(lots))).toBe(before);
        }
      }),
    );
  });

  it('a provider fill attributed to one lot leaves a same-mint lot of another strategy untouched', () => {
    const lots: LotBalance[] = [
      { lotId: uuid(1), sleeveId: uuid(100), quantity: amt(500n) },
      { lotId: uuid(2), sleeveId: uuid(101), quantity: amt(700n) },
    ];
    const r = applyProviderFill(lots, uuid(1), amt(500n));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lots[0].quantity).toBe('0');
      expect(r.lots[1].quantity).toBe('700');
    }
    expect(applyProviderFill(lots, uuid(1), amt(501n)).ok).toBe(false);
  });
});

describe('custody movement classification (D9)', () => {
  const A = fixtures.WALLET as SolanaAddress;
  const V = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2' as SolanaAddress;
  const X = 'BPFLoaderUpgradeab1e11111111111111111111111' as SolanaAddress;
  const registry: RegisteredCustody[] = [
    { id: uuid(1), address: A, allowedMovementTypes: ['SWAP_V2', 'TRIGGER_DEPOSIT', 'TRIGGER_CANCEL_WITHDRAW'], active: true },
    { id: uuid(2), address: V, allowedMovementTypes: ['TRIGGER_DEPOSIT', 'TRIGGER_CANCEL_WITHDRAW'], active: true },
  ];
  const lifecycles = new Set<Uuid>([uuid(50)]);
  const base = { mint: fixtures.MINTS.RISK as MintAddress, amount: amt(10n) };

  it('an authorized wallet→vault deposit is EXPECTED; anything else is UNKNOWN', () => {
    expect(classifyMovement(registry, { ...base, from: A, to: V, lifecycleId: uuid(50), movementType: 'TRIGGER_DEPOSIT' }, lifecycles).kind).toBe('EXPECTED');
    expect(classifyMovement(registry, { ...base, from: A, to: V, lifecycleId: uuid(51), movementType: 'TRIGGER_DEPOSIT' }, lifecycles)).toEqual({ kind: 'UNKNOWN', reason: 'NO_LIFECYCLE' });
    expect(classifyMovement(registry, { ...base, from: A, to: X, lifecycleId: uuid(50), movementType: 'SWAP_V2' }, lifecycles)).toEqual({ kind: 'UNKNOWN', reason: 'UNREGISTERED_ENDPOINT' });
    expect(classifyMovement(registry, { ...base, from: A, to: V, lifecycleId: uuid(50), movementType: 'SWAP_V2' }, lifecycles)).toEqual({ kind: 'UNKNOWN', reason: 'MOVEMENT_TYPE_NOT_ALLOWED' });
    expect(classifyMovement(registry, { ...base, from: A, to: V, lifecycleId: uuid(50), movementType: null }, lifecycles)).toEqual({ kind: 'UNKNOWN', reason: 'UNTYPED_MOVEMENT' });
  });

  it('never classifies a movement with an unregistered endpoint as EXPECTED', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(A, V, X),
        fc.constantFrom(A, V, X),
        fc.constantFrom<TransactionClass | null>('SWAP_V2', 'TRIGGER_DEPOSIT', 'TRIGGER_CANCEL_WITHDRAW', null),
        fc.option(fc.constantFrom(uuid(50), uuid(51)), { nil: null }),
        (from, to, movementType, lifecycleId) => {
          const c = classifyMovement(registry, { ...base, from, to, movementType, lifecycleId }, lifecycles);
          if (from === X || to === X) expect(c.kind).toBe('UNKNOWN');
          if (c.kind === 'EXPECTED') {
            expect(lifecycleId).toBe(uuid(50));
            expect(movementType).not.toBeNull();
          }
        },
      ),
    );
  });
});
