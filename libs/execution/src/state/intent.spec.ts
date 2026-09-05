import fc from 'fast-check';
import type { IdempotencyKey, Uuid } from '@sol-agent-trader/contracts';
import { activeIntents, advanceIntent, emptyIntentRegistry, registerIntent, type IntentLifecycleState, type IntentRegistry } from './intent.js';

const key = (n: number) => `idem-key-${n}` as IdempotencyKey;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Uuid;

describe('intent idempotency registry (INV-04)', () => {
  it('a redelivery with an active key returns the existing intent, and a new intent is allowed only after terminal', () => {
    let reg: IntentRegistry = emptyIntentRegistry();
    const first = registerIntent(reg, id(1), key(1));
    expect(first.outcome).toBe('CREATED');
    reg = first.registry;
    const dup = registerIntent(reg, id(2), key(1));
    expect(dup.outcome).toBe('DUPLICATE_ACTIVE');
    if (dup.outcome === 'DUPLICATE_ACTIVE') expect(dup.existing.intentId).toBe(id(1));
    for (const to of ['AUTHORIZED', 'EXECUTING', 'COMPLETED'] as IntentLifecycleState[]) {
      const r = advanceIntent(reg, key(1), to);
      expect(r.ok).toBe(true);
      if (r.ok) reg = r.registry;
    }
    expect(registerIntent(reg, id(3), key(1)).outcome).toBe('CREATED');
  });

  it('never holds two active intents under one idempotency key, whatever the delivery order', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('register' as const), k: fc.integer({ min: 0, max: 5 }), n: fc.integer({ min: 0, max: 999 }) }),
      fc.record({
        kind: fc.constant('advance' as const),
        k: fc.integer({ min: 0, max: 5 }),
        to: fc.constantFrom<IntentLifecycleState>('AUTHORIZED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED'),
      }),
    );
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 60 }), (ops) => {
        let reg: IntentRegistry = emptyIntentRegistry();
        for (const o of ops) {
          if (o.kind === 'register') {
            const r = registerIntent(reg, id(o.n), key(o.k));
            reg = r.registry;
          } else {
            const r = advanceIntent(reg, key(o.k), o.to);
            if (r.ok) reg = r.registry;
          }
          const active = activeIntents(reg);
          expect(new Set(active.map((e) => e.idempotencyKey)).size).toBe(active.length);
        }
      }),
      { numRuns: 400 },
    );
  });
});
