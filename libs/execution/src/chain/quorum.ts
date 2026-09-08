import type { ChainObserver, SignatureStatus } from './observer.js';

/**
 * One signature, several independent RPC views (blueprint §14.7 REORG_PENDING: "query at least
 * two independent approved RPC views where available"; §24.4 "independent RPCs disagree on
 * signature state -> entries pause until reconciliation"). A view that has not caught up to the
 * transaction's slot is BEHIND, not a contradiction; a view that is past it by the grace and still
 * does not know the signature contradicts one that does, and a success/failure split is always
 * material. The verdict never picks a winner between contradicting views.
 */

export type ViewReading =
  | { label: string; kind: 'LANDED'; status: SignatureStatus }
  | { label: string; kind: 'FAILED'; status: SignatureStatus }
  | { label: string; kind: 'MISSING'; headSlot: number | null }
  | { label: string; kind: 'UNAVAILABLE'; error: string };

export interface QuorumVerdict {
  verdict: 'FINALIZED' | 'CONFIRMED' | 'PROCESSED' | 'FAILED' | 'MISSING' | 'DIVERGENT' | 'UNAVAILABLE';
  /** Slot of the landed transaction (from the finalized view when one exists). */
  slot: number | null;
  readings: ViewReading[];
  /** Views that answered (any reading but UNAVAILABLE). */
  answered: number;
}

export interface QuorumObserver extends ChainObserver {
  /** The view's own confirmed head, so a missing signature can be classified as BEHIND rather than contradicting. */
  headSlot?(): Promise<number>;
}

export async function readSignature(observers: readonly QuorumObserver[], signature: string): Promise<ViewReading[]> {
  return Promise.all(
    observers.map(async (o): Promise<ViewReading> => {
      try {
        const status = await o.signatureStatus(signature);
        if (status === null) {
          let headSlot: number | null = null;
          if (o.headSlot) headSlot = await o.headSlot().catch(() => null);
          return { label: o.label, kind: 'MISSING', headSlot };
        }
        return status.err === null ? { label: o.label, kind: 'LANDED', status } : { label: o.label, kind: 'FAILED', status };
      } catch (err) {
        return { label: o.label, kind: 'UNAVAILABLE', error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

export function quorumVerdict(readings: ViewReading[], graceSlots: number): QuorumVerdict {
  const answered = readings.filter((r) => r.kind !== 'UNAVAILABLE');
  const base = { readings, answered: answered.length };
  if (answered.length === 0) return { ...base, verdict: 'UNAVAILABLE', slot: null };
  const landed = answered.filter((r): r is Extract<ViewReading, { kind: 'LANDED' }> => r.kind === 'LANDED');
  const failed = answered.filter((r): r is Extract<ViewReading, { kind: 'FAILED' }> => r.kind === 'FAILED');
  const missing = answered.filter((r): r is Extract<ViewReading, { kind: 'MISSING' }> => r.kind === 'MISSING');
  if (landed.length && failed.length) return { ...base, verdict: 'DIVERGENT', slot: null };
  if (landed.length) {
    const txSlot = Math.max(...landed.map((r) => r.status.slot));
    const contradicting = missing.some((m) => m.headSlot !== null && m.headSlot > txSlot + graceSlots);
    if (contradicting) return { ...base, verdict: 'DIVERGENT', slot: null };
    const finalized = landed.filter((r) => r.status.confirmationStatus === 'finalized');
    if (finalized.length === landed.length) return { ...base, verdict: 'FINALIZED', slot: finalized[0]!.status.slot };
    const weakest = landed.some((r) => r.status.confirmationStatus === 'processed') ? 'PROCESSED' : 'CONFIRMED';
    return { ...base, verdict: weakest, slot: txSlot };
  }
  if (failed.length) {
    const contradicting = missing.some((m) => m.headSlot !== null && m.headSlot > Math.max(...failed.map((r) => r.status.slot)) + graceSlots);
    return { ...base, verdict: contradicting ? 'DIVERGENT' : 'FAILED', slot: failed[0]!.status.slot };
  }
  return { ...base, verdict: 'MISSING', slot: null };
}

/**
 * INV-23 across views: dead only when every answering view has no record of the signature and every
 * answering view's block height is past the transaction's last valid height. One silent view is not proof.
 */
export async function proveDeadAcrossViews(observers: readonly QuorumObserver[], signature: string, lastValidBlockHeight: number | null): Promise<{ blockHeightExpired: boolean; signatureHistoryEmpty: boolean } | null> {
  if (lastValidBlockHeight === null || observers.length === 0) return null;
  const readings = await readSignature(observers, signature);
  if (readings.some((r) => r.kind === 'UNAVAILABLE')) return null;
  if (!readings.every((r) => r.kind === 'MISSING')) return null;
  const heights = await Promise.all(observers.map((o) => o.blockHeight().catch(() => null)));
  if (heights.some((h) => h === null || h <= lastValidBlockHeight)) return null;
  return { blockHeightExpired: true, signatureHistoryEmpty: true };
}
