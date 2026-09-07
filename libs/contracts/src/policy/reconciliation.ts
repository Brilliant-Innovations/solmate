import { z } from 'zod';
import { Bps, Milliseconds, VersionId } from '../primitives.js';

/**
 * Deterministic reconciliation policy (blueprint D9, §13.6). Versioned like every other policy;
 * the worker records the version on each report so a later loosening is visible in history.
 */
export const ReconciliationPolicy = z.strictObject({
  version: VersionId,
  /** Token balances must match the ledger exactly; any non-zero tolerance is an explicit decision. */
  tokenToleranceBaseUnits: z.number().int().nonnegative(),
  /**
   * Lamports of unexplained SOL drift per cycle before it counts as a mismatch. Fees are
   * subtracted from expectation when the trading wallet paid them, but rent for token accounts
   * created or closed inside an expected lifecycle is not itemised by every parser. Default 0.005 SOL.
   */
  solToleranceLamports: z.number().int().nonnegative(),
  /** Signatures fetched per cycle; more than this in one interval is itself suspicious and is reported. */
  maxSignaturesPerCycle: z.number().int().min(1).max(1000),
  /** Token accounts with a zero balance are noise (closed or dust-swept), not custody. */
  ignoreEmptyTokenAccounts: z.boolean(),
});
export type ReconciliationPolicy = z.infer<typeof ReconciliationPolicy>;

export const DEFAULT_RECONCILIATION_POLICY: ReconciliationPolicy = {
  version: 'reconciliation-v1' as VersionId,
  tokenToleranceBaseUnits: 0,
  solToleranceLamports: 5_000_000,
  maxSignaturesPerCycle: 100,
  ignoreEmptyTokenAccounts: true,
};

/** Self-influence guard (D26, §8.6): suppression window after our own fill, sized by our impact. */
export const SelfInfluencePolicy = z.strictObject({
  version: VersionId,
  /** Minimum suppression after any own fill. */
  baseWindowMs: Milliseconds,
  /** Added per basis point of estimated market impact of our fill. */
  perImpactBpsMs: Milliseconds,
  maxWindowMs: Milliseconds,
  /** Below this impact the window is the base window only. */
  impactFloorBps: Bps,
});
export type SelfInfluencePolicy = z.infer<typeof SelfInfluencePolicy>;

export const DEFAULT_SELF_INFLUENCE_POLICY: SelfInfluencePolicy = {
  version: 'self-influence-v1' as VersionId,
  baseWindowMs: 5 * 60_000,
  perImpactBpsMs: 30_000,
  maxWindowMs: 60 * 60_000,
  impactFloorBps: 5 as Bps,
};
