import { z } from 'zod';
import { ExecutionPath } from '../enums.js';
import { Amount, Bps, Milliseconds, VersionId } from '../primitives.js';

/**
 * Paper fill model parameters (blueprint §17.1–17.4, §18.4; execution plan M5a "explicit,
 * reproducible latency/fill model"). Versioned so every paper fill names the model that produced
 * it. The model is applied in one place (`libs/execution/src/adapter/fill-model.ts`) so the
 * adverse-execution allowance is never double-counted, and `executionShortfallBps` on the fill
 * is measured against the decision quote separately from this modelled attribution (D48).
 */
export const PaperFillPolicy = z.strictObject({
  version: VersionId,
  /** Decision quote → modelled submission moment; the executable quote is taken after this delay. */
  submissionDelayMs: Milliseconds,
  /** Modelled submission → `confirmed`; `confirmed` → `finalized`. Timestamps only, no real waiting. */
  confirmationDelayMs: Milliseconds,
  finalizationDelayMs: Milliseconds,
  /** §17.4 adverse-execution/MEV allowance by execution/landing path, taken off the executable output. */
  adverseAllowanceBpsByPath: z.record(ExecutionPath, Bps),
  fees: z.strictObject({
    networkLamports: Amount,
    priorityLamports: Amount,
    /** Router fee as bps of the input amount. */
    routerBps: Bps,
    /** Token-2022 transfer fee as bps of the output amount; 0 when the asset has none. */
    transferFeeBps: Bps,
  }),
  /** Slots advanced between the modelled `confirmed` and `finalized` observations. */
  finalizationSlots: z.number().int().positive(),
});
export type PaperFillPolicy = z.infer<typeof PaperFillPolicy>;

export const DEFAULT_PAPER_FILL_POLICY: PaperFillPolicy = {
  version: 'paper-fill-v1' as VersionId,
  submissionDelayMs: 1_500,
  confirmationDelayMs: 800,
  finalizationDelayMs: 13_000,
  adverseAllowanceBpsByPath: { JUPITER_ORDER: 15 as Bps, PROVIDER_PROTECTIVE: 30 as Bps, DIRECT_POOL_PRIVATE: 25 as Bps, DIRECT_POOL_RPC: 60 as Bps },
  fees: { networkLamports: '5000' as Amount, priorityLamports: '20000' as Amount, routerBps: 0 as Bps, transferFeeBps: 0 as Bps },
  finalizationSlots: 32,
};

/** Reasons an execution attempt can end without a fill; shared by paper and live so the parity suite compares like with like. */
export const EXECUTION_REJECTIONS = ['NOT_PAPER_AUTHORITY', 'DUPLICATE_INTENT', 'INTENT_EXPIRED', 'QUOTE_STALE', 'NO_ROUTE', 'QUOTE_AMOUNT_MISMATCH', 'CHASE_EXCEEDED', 'IMPACT_ABOVE_MAX', 'SLIPPAGE_EXCEEDED'] as const;
export type ExecutionRejection = (typeof EXECUTION_REJECTIONS)[number];
