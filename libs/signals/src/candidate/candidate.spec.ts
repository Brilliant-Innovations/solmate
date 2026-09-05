import fc from 'fast-check';
import { addMs, type Instant, type ReasonCode } from '@sol-agent-trader/contracts';
import { candidateTransition, type CandidateEvent, type CandidateLifecycle } from './machine.js';

const T0 = '2026-09-05T12:00:00.000Z' as Instant;
const EXP = addMs(T0, 60_000);

describe('candidate lifecycle (§6.9, §9.7)', () => {
  it('follows DETECTED → ENRICHING → AGENT_REVIEW → QUALIFIED before expiry', () => {
    let c: CandidateLifecycle = { status: 'DETECTED', expiresAt: EXP, rejectionReason: null };
    for (const [type, status] of [['ENRICH', 'ENRICHING'], ['SEND_TO_AGENT', 'AGENT_REVIEW'], ['QUALIFY', 'QUALIFIED']] as const) {
      const r = candidateTransition(c, { type, at: T0 } as CandidateEvent);
      expect(r.ok).toBe(true);
      if (r.ok) c = r.candidate;
      expect(c.status).toBe(status);
    }
    expect(candidateTransition(c, { type: 'TICK', at: T0 }).ok).toBe(false);
  });

  it('expires at or after expiresAt regardless of the event, and terminal states absorb', () => {
    const eventArb = fc.record({
      type: fc.constantFrom<CandidateEvent['type']>('ENRICH', 'SEND_TO_AGENT', 'QUALIFY', 'REJECT', 'TICK'),
      offsetMs: fc.integer({ min: -120_000, max: 120_000 }),
    });
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 15 }), (steps) => {
        let c: CandidateLifecycle = { status: 'DETECTED', expiresAt: EXP, rejectionReason: null };
        let terminal = false;
        for (const s of steps) {
          const at = addMs(EXP, s.offsetMs);
          const event = (s.type === 'REJECT' ? { type: 'REJECT', at, reason: 'TEST_REJECT' as ReasonCode } : { type: s.type, at }) as CandidateEvent;
          const r = candidateTransition(c, event);
          if (terminal) { expect(r.ok).toBe(false); continue; }
          if (!r.ok) continue;
          c = r.candidate;
          if (s.offsetMs >= 0) expect(c.status).toBe('EXPIRED');
          if (['REJECTED', 'QUALIFIED', 'EXPIRED'].includes(c.status)) terminal = true;
        }
      }),
    );
  });
});
