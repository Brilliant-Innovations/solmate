import fc from 'fast-check';
import type { IdempotencyKey, Uuid } from '@sol-agent-trader/contracts';
import { activeIntents, advanceIntent, emptyIntentRegistry, registerIntent, type IntentLifecycleState, type IntentRegistry } from './intent.js';

const key = (n: number) => `idem-key-${n}` as IdempotencyKey;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Uuid;

describe('intent idempotency registry (INV-04, D12)', () => {
  it('a redelivery returns the existing intent in every state, including after COMPLETED', () => {
    let reg: IntentRegistry = emptyIntentRegistry();
    const first = registerIntent(reg, id(1), key(1));
    expect(first.outcome).toBe('CREATED');
    reg = first.registry;
    for (const to of ['AUTHORIZED', 'EXECUTING', 'COMPLETED'] as IntentLifecycleState[]) {
      const dup = registerIntent(reg, id(2), key(1));
      expect(dup.outcome).toBe('DUPLICATE');
      if (dup.outcome === 'DUPLICATE') expect(dup.existing.intentId).toBe(id(1));
      const r = advanceIntent(reg, key(1), to);
      expect(r.ok).toBe(true);
      if (r.ok) reg = r.registry;
    }
    // the canonical pgmq failure: executed, died before ack, redelivered
    const redelivered = registerIntent(reg, id(3), key(1));
    expect(redelivered.outcome).toBe('DUPLICATE');
    if (redelivered.outcome === 'DUPLICATE') expect(redelivered.existing).toEqual({ intentId: id(1), idempotencyKey: key(1), state: 'COMPLETED' });
    expect(reg.size).toBe(1);
  });

  it('never creates a second intent under a used key, whatever the delivery order', () => {
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
        const firstIdByKey = new Map<IdempotencyKey, Uuid>();
        for (const o of ops) {
          if (o.kind === 'register') {
            const r = registerIntent(reg, id(o.n), key(o.k));
            reg = r.registry;
            if (r.outcome === 'CREATED') firstIdByKey.set(key(o.k), id(o.n));
            else expect(r.existing.intentId).toBe(firstIdByKey.get(key(o.k)));
          } else {
            const r = advanceIntent(reg, key(o.k), o.to);
            if (r.ok) reg = r.registry;
          }
          // one entry per key, ever; therefore at most one active per key
          expect(reg.size).toBe(firstIdByKey.size);
          const active = activeIntents(reg);
          expect(new Set(active.map((e) => e.idempotencyKey)).size).toBe(active.length);
        }
      }),
      { numRuns: 400 },
    );
  });
});
