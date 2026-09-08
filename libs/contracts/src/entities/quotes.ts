import { z } from 'zod';
import { Amount, Bps, Instant, MintAddress, SolanaAddress, Uuid } from '../primitives.js';
import { Quote, QuoteProvider } from '../envelopes/execution-adapter.js';

/**
 * Level B capture (blueprint §18.1, §17.1–17.2, D48): a quote that a decision or an execution
 * actually used, stored with the moment it was taken and the ledger object it served. Replay
 * reads these instead of reconstructing executable expectations from candles.
 */
export const QuoteProbePurpose = z.enum(['ENTRY_REFERENCE', 'DECISION', 'EXECUTABLE', 'EXIT_MARK']);
export type QuoteProbePurpose = z.infer<typeof QuoteProbePurpose>;

export const QuoteProbe = z.object({
  id: Uuid,
  assetId: Uuid.nullable(),
  provider: QuoteProvider,
  purpose: QuoteProbePurpose,
  inputMint: MintAddress,
  outputMint: MintAddress,
  inputAmount: Amount,
  expectedOutputAmount: Amount,
  minOutputAmount: Amount,
  priceImpactBps: Bps.nullable(),
  slippageBps: Bps,
  routerLabel: z.string().nullable(),
  routeProgramIds: z.array(SolanaAddress),
  usesAddressLookupTables: z.boolean(),
  quotedAt: Instant,
  observedAt: Instant,
  actionCycleId: Uuid.nullable(),
  intentId: Uuid.nullable(),
  positionId: Uuid.nullable(),
  orderAttemptId: Uuid.nullable(),
});
export type QuoteProbe = z.infer<typeof QuoteProbe>;

/** Builds a probe row from an adapter quote and the context it served. */
export function quoteProbeOf(id: Uuid, quote: Quote, purpose: QuoteProbePurpose, observedAt: Instant, refs: { assetId?: Uuid | null; actionCycleId?: Uuid | null; intentId?: Uuid | null; positionId?: Uuid | null; orderAttemptId?: Uuid | null }): QuoteProbe {
  return {
    id,
    assetId: refs.assetId ?? null,
    provider: quote.provider,
    purpose,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inputAmount: quote.inputAmount,
    expectedOutputAmount: quote.expectedOutputAmount,
    minOutputAmount: quote.minOutputAmount,
    priceImpactBps: quote.priceImpactBps,
    slippageBps: quote.slippageBps,
    routerLabel: quote.routerLabel,
    routeProgramIds: quote.routeProgramIds,
    usesAddressLookupTables: quote.usesAddressLookupTables,
    quotedAt: quote.quotedAt,
    observedAt,
    actionCycleId: refs.actionCycleId ?? null,
    intentId: refs.intentId ?? null,
    positionId: refs.positionId ?? null,
    orderAttemptId: refs.orderAttemptId ?? null,
  };
}
