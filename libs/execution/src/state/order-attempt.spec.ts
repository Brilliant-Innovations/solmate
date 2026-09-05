import fc from 'fast-check';
import { fixtures, type ExecutionPath, type Instant, type Sha256Hex, type Slot } from '@sol-agent-trader/contracts';
import { attemptTransition, canRetry, countsAsExposure, finalAccountingAllowed, newOrderAttempt, type OrderAttemptEvent, type OrderAttemptRecord } from './order-attempt.js';

const T0 = fixtures.T0 as Instant;
const H = fixtures.HASH_A as Sha256Hex;
const PATH: ExecutionPath = 'JUPITER_ORDER';

const signed: OrderAttemptEvent = { type: 'SIGNED', at: T0, signedTxHash: H, expectedTxSignature: null, lastValidBlockHeight: 100 };
const journaled: OrderAttemptEvent = { type: 'JOURNALED', at: T0 };
const submitted: OrderAttemptEvent = { type: 'SUBMITTED', at: T0, path: PATH };
const observed = (commitment: 'processed' | 'confirmed' | 'finalized', slot = 10): OrderAttemptEvent => ({ type: 'OBSERVED', at: T0, commitment, slot: slot as Slot });
const missing: OrderAttemptEvent = { type: 'MISSING_OR_CONFLICTING', at: T0 };
const dead = (blockHeightExpired: boolean, signatureHistoryEmpty: boolean): OrderAttemptEvent => ({
  type: 'CONCLUSIVELY_DEAD', at: T0, blockHeightExpired, signatureHistoryEmpty, reason: 'expired',
});

function run(events: OrderAttemptEvent[], from = newOrderAttempt()): OrderAttemptRecord {
  let a = from;
  for (const e of events) {
    const r = attemptTransition(a, e);
    if (!r.ok) throw new Error(`${e.type} rejected: ${JSON.stringify(r.rejection)}`);
    a = r.attempt;
  }
  return a;
}

describe('order attempt: persist-before-submit and staged confirmation', () => {
  it('cannot submit before the signed record is journaled (D12, §15.4)', () => {
    const a = run([signed]);
    const r = attemptTransition(a, submitted);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('NOT_JOURNALED');
    expect(run([journaled, submitted], a).state).toBe('SUBMITTED');
  });

  it('processed is telemetry only; confirmed is provisional exposure; finalized permits accounting (INV-22)', () => {
    const s = run([signed, journaled, submitted]);
    expect(run([observed('processed')], s).state).toBe('SUBMITTED');
    const c = run([observed('confirmed')], s);
    expect(c.state).toBe('CONFIRMED_PROVISIONAL');
    expect(countsAsExposure(c)).toBe(true);
    expect(finalAccountingAllowed(c)).toBe(false);
    const f = run([observed('finalized', 12)], c);
    expect(f.state).toBe('FINALIZED');
    expect(finalAccountingAllowed(f)).toBe(true);
  });
});

describe('order attempt: reorg handling (INV-23)', () => {
  it('confirmed-then-missing enters REORG_PENDING and blocks retry until death is proven by both facts', () => {
    const c = run([signed, journaled, submitted, observed('confirmed')]);
    const r = run([missing], c);
    expect(r.state).toBe('REORG_PENDING');
    expect(canRetry(r)).toBe(false);
    expect(countsAsExposure(r)).toBe(true);
    expect(attemptTransition(r, dead(true, false)).ok).toBe(false);
    expect(attemptTransition(r, dead(false, true)).ok).toBe(false);
    const d = run([dead(true, true)], r);
    expect(d.state).toBe('NOT_LANDED');
    expect(canRetry(d)).toBe(true);
    // a reorged transaction may still land: finalized from REORG_PENDING is valid
    expect(run([observed('finalized', 20)], r).state).toBe('FINALIZED');
  });

  const eventArb: fc.Arbitrary<OrderAttemptEvent> = fc.oneof(
    fc.constant(signed), fc.constant(journaled), fc.constant(submitted),
    fc.constantFrom(observed('processed'), observed('confirmed'), observed('finalized')),
    fc.constant(missing),
    fc.record({ b: fc.boolean(), s: fc.boolean() }).map(({ b, s }) => dead(b, s)),
  );

  it('over arbitrary sequences: accounting needs a finalized observation, retry needs proven death, submit needs journal', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 30 }), (events) => {
        let a = newOrderAttempt();
        let sawFinalized = false;
        let provenDead = false;
        for (const e of events) {
          const r = attemptTransition(a, e);
          if (!r.ok) continue;
          if (e.type === 'OBSERVED' && e.commitment === 'finalized') sawFinalized = true;
          if (e.type === 'CONCLUSIVELY_DEAD') provenDead = true;
          if (e.type === 'SUBMITTED') expect(a.journaled).toBe(true);
          a = r.attempt;
          if (finalAccountingAllowed(a)) expect(sawFinalized).toBe(true);
          if (canRetry(a)) expect(provenDead).toBe(true);
          if (a.state === 'REORG_PENDING' || a.state === 'SUBMITTED' || a.state === 'CONFIRMED_PROVISIONAL') expect(canRetry(a)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});
