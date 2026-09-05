import type { ChainCommitment, ExecutionPath, Instant, OrderAttemptState, Sha256Hex, Slot, TxSignature } from '@sol-agent-trader/contracts';

/**
 * Order-attempt state machine (blueprint D12, D49, §6.18, §14.5, §14.7, §15.4).
 *
 * PREPARED → SIGNED_NOT_SUBMITTED → SUBMITTED → CONFIRMED_PROVISIONAL → FINALIZED
 *                                  ↘ NOT_LANDED          ↘ REORG_PENDING ↗ / ↘ NOT_LANDED
 *
 * - `processed` observations are telemetry only and never change state;
 * - `confirmed` advances provisional operational state (protection may be installed);
 * - only a `finalized` observation permits final accounting (INV-22);
 * - a confirmed-then-missing transaction enters REORG_PENDING and may not be replaced or retried
 *   until it is conclusively non-landable (INV-23), which needs both an expired last-valid block
 *   height and an empty signature history;
 * - submission requires the SIGNED_NOT_SUBMITTED record to have been durably journaled first.
 */

export interface OrderAttemptRecord {
  state: OrderAttemptState;
  signedTxHash: Sha256Hex | null;
  expectedTxSignature: TxSignature | null;
  lastValidBlockHeight: number | null;
  journaled: boolean;
  submittedAt: Instant | null;
  submissionPaths: ExecutionPath[];
  confirmedSlot: Slot | null;
  finalizedSlot: Slot | null;
  reorgDetectedAt: Instant | null;
  notLandedReason: string | null;
}

export type OrderAttemptEvent =
  | { type: 'SIGNED'; at: Instant; signedTxHash: Sha256Hex; expectedTxSignature: TxSignature | null; lastValidBlockHeight: number | null }
  | { type: 'JOURNALED'; at: Instant }
  | { type: 'SUBMITTED'; at: Instant; path: ExecutionPath }
  | { type: 'OBSERVED'; at: Instant; commitment: ChainCommitment; slot: Slot }
  | { type: 'MISSING_OR_CONFLICTING'; at: Instant }
  | { type: 'CONCLUSIVELY_DEAD'; at: Instant; blockHeightExpired: boolean; signatureHistoryEmpty: boolean; reason: string };

export type OrderAttemptRejection =
  | { code: 'INVALID_FROM_STATE'; state: OrderAttemptState; event: OrderAttemptEvent['type'] }
  | { code: 'NOT_JOURNALED' }
  | { code: 'DEATH_NOT_PROVEN'; blockHeightExpired: boolean; signatureHistoryEmpty: boolean };

export type OrderAttemptResult = { ok: true; attempt: OrderAttemptRecord } | { ok: false; rejection: OrderAttemptRejection };

export function newOrderAttempt(): OrderAttemptRecord {
  return {
    state: 'PREPARED',
    signedTxHash: null,
    expectedTxSignature: null,
    lastValidBlockHeight: null,
    journaled: false,
    submittedAt: null,
    submissionPaths: [],
    confirmedSlot: null,
    finalizedSlot: null,
    reorgDetectedAt: null,
    notLandedReason: null,
  };
}

const invalid = (state: OrderAttemptState, event: OrderAttemptEvent['type']): OrderAttemptResult => ({
  ok: false,
  rejection: { code: 'INVALID_FROM_STATE', state, event },
});

export function attemptTransition(a: OrderAttemptRecord, event: OrderAttemptEvent): OrderAttemptResult {
  const s = a.state;
  switch (event.type) {
    case 'SIGNED':
      if (s !== 'PREPARED') return invalid(s, event.type);
      return {
        ok: true,
        attempt: { ...a, state: 'SIGNED_NOT_SUBMITTED', signedTxHash: event.signedTxHash, expectedTxSignature: event.expectedTxSignature, lastValidBlockHeight: event.lastValidBlockHeight },
      };

    case 'JOURNALED':
      if (s !== 'SIGNED_NOT_SUBMITTED') return invalid(s, event.type);
      return { ok: true, attempt: { ...a, journaled: true } };

    case 'SUBMITTED':
      if (s !== 'SIGNED_NOT_SUBMITTED') return invalid(s, event.type);
      if (!a.journaled) return { ok: false, rejection: { code: 'NOT_JOURNALED' } };
      return { ok: true, attempt: { ...a, state: 'SUBMITTED', submittedAt: event.at, submissionPaths: [...a.submissionPaths, event.path] } };

    case 'OBSERVED': {
      if (event.commitment === 'processed') return { ok: true, attempt: a }; // telemetry only (D49)
      if (event.commitment === 'confirmed') {
        if (s === 'SUBMITTED') return { ok: true, attempt: { ...a, state: 'CONFIRMED_PROVISIONAL', confirmedSlot: event.slot } };
        if (s === 'CONFIRMED_PROVISIONAL' || s === 'REORG_PENDING') return { ok: true, attempt: { ...a, state: 'CONFIRMED_PROVISIONAL', confirmedSlot: event.slot } };
        return invalid(s, event.type);
      }
      // finalized
      if (s === 'SUBMITTED' || s === 'CONFIRMED_PROVISIONAL' || s === 'REORG_PENDING') {
        return { ok: true, attempt: { ...a, state: 'FINALIZED', finalizedSlot: event.slot, confirmedSlot: a.confirmedSlot ?? event.slot } };
      }
      return invalid(s, event.type);
    }

    case 'MISSING_OR_CONFLICTING':
      if (s === 'CONFIRMED_PROVISIONAL') return { ok: true, attempt: { ...a, state: 'REORG_PENDING', reorgDetectedAt: event.at } };
      if (s === 'SUBMITTED' || s === 'REORG_PENDING') return { ok: true, attempt: a }; // still potentially landable
      return invalid(s, event.type);

    case 'CONCLUSIVELY_DEAD':
      if (s !== 'SIGNED_NOT_SUBMITTED' && s !== 'SUBMITTED' && s !== 'REORG_PENDING') return invalid(s, event.type);
      if (!(event.blockHeightExpired && event.signatureHistoryEmpty)) {
        return { ok: false, rejection: { code: 'DEATH_NOT_PROVEN', blockHeightExpired: event.blockHeightExpired, signatureHistoryEmpty: event.signatureHistoryEmpty } };
      }
      return { ok: true, attempt: { ...a, state: 'NOT_LANDED', notLandedReason: event.reason } };
  }
}

/** Final accounting, realized P&L and irreversible audit state require FINALIZED (INV-22). */
export function finalAccountingAllowed(a: Pick<OrderAttemptRecord, 'state'>): boolean {
  return a.state === 'FINALIZED';
}

/** Provisional exposure counts for protection and limits from CONFIRMED_PROVISIONAL onward (D49). */
export function countsAsExposure(a: Pick<OrderAttemptRecord, 'state'>): boolean {
  return a.state === 'CONFIRMED_PROVISIONAL' || a.state === 'FINALIZED' || a.state === 'REORG_PENDING';
}

/** A replacement attempt may be created only once the original is conclusively dead (INV-23, §14.5). */
export function canRetry(a: Pick<OrderAttemptRecord, 'state'>): boolean {
  return a.state === 'NOT_LANDED';
}
