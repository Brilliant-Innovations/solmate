import { compareInstants, type CandidateStatus, type Instant, type ReasonCode } from '@sol-agent-trader/contracts';

/**
 * Candidate lifecycle (blueprint §6.9, §9.7).
 *
 * DETECTED → ENRICHING → AGENT_REVIEW → QUALIFIED; REJECTED from any live state with a reason;
 * EXPIRED whenever the clock passes `expiresAt`. A candidate never becomes tradeable by itself:
 * QUALIFIED only means it may be handed to a strategy's action cycle.
 */

export interface CandidateLifecycle {
  status: CandidateStatus;
  expiresAt: Instant;
  rejectionReason: ReasonCode | null;
}

export type CandidateEvent =
  | { type: 'ENRICH'; at: Instant }
  | { type: 'SEND_TO_AGENT'; at: Instant }
  | { type: 'QUALIFY'; at: Instant }
  | { type: 'REJECT'; at: Instant; reason: ReasonCode }
  | { type: 'TICK'; at: Instant };

export type CandidateResult = { ok: true; candidate: CandidateLifecycle } | { ok: false; code: 'INVALID_FROM_STATE' | 'TERMINAL'; status: CandidateStatus };

const TERMINAL: ReadonlySet<CandidateStatus> = new Set(['REJECTED', 'QUALIFIED', 'EXPIRED']);

export function candidateTransition(c: CandidateLifecycle, event: CandidateEvent): CandidateResult {
  if (TERMINAL.has(c.status)) return { ok: false, code: 'TERMINAL', status: c.status };
  // Expiry wins over every other event once the market condition has aged out (§6.9).
  if (compareInstants(event.at, c.expiresAt) >= 0) return { ok: true, candidate: { ...c, status: 'EXPIRED' } };
  switch (event.type) {
    case 'TICK':
      return { ok: true, candidate: c };
    case 'REJECT':
      return { ok: true, candidate: { ...c, status: 'REJECTED', rejectionReason: event.reason } };
    case 'ENRICH':
      return c.status === 'DETECTED' ? { ok: true, candidate: { ...c, status: 'ENRICHING' } } : { ok: false, code: 'INVALID_FROM_STATE', status: c.status };
    case 'SEND_TO_AGENT':
      return c.status === 'ENRICHING' ? { ok: true, candidate: { ...c, status: 'AGENT_REVIEW' } } : { ok: false, code: 'INVALID_FROM_STATE', status: c.status };
    case 'QUALIFY':
      return c.status === 'AGENT_REVIEW' || c.status === 'ENRICHING'
        ? { ok: true, candidate: { ...c, status: 'QUALIFIED' } }
        : { ok: false, code: 'INVALID_FROM_STATE', status: c.status };
  }
}
