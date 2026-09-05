import { z } from 'zod';
import { Instant } from '../primitives.js';

export const Timestamps = z.object({
  createdAt: Instant,
  updatedAt: Instant,
});

/** Reason codes are short, stable, machine-readable tokens (e.g. `LIQUIDITY_BELOW_FLOOR`). */
export const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const ReasonCodes = z.array(ReasonCode);

/** Free-form structured detail carried alongside typed fields. Never authority. */
export const JsonRecord = z.record(z.string(), z.unknown());
export type JsonRecord = z.infer<typeof JsonRecord>;

/** Signed integer base-unit delta as a decimal string (realized P&L, balance deltas). */
export const SignedAmount = z.string().regex(/^-?(0|[1-9][0-9]*)$/).brand<'SignedAmount'>();
export type SignedAmount = z.infer<typeof SignedAmount>;
