import { amountToBigInt, instantToMs, sha256Hex, type Amount, type Bps, type Instant, type MintAddress, type Sha256Hex } from '@sol-agent-trader/contracts';
import type { ExecutionBounds } from './bounds.js';

/**
 * Order-versus-authorization checks (blueprint §15.4 steps 1–3 and 7; ADR-0009 P7 bounds). The
 * router's order is trusted for nothing: every field the envelope binds is compared, the input
 * amount may never exceed the authorized maximum, slippage and impact may never exceed the
 * authorized limits, the quote must be inside its own validity, and the transaction bytes must
 * hash to the value the order build reported, so what is validated is what gets signed.
 */

export interface JupiterOrderFacts {
  requestId: string | null;
  inputMint: MintAddress;
  outputMint: MintAddress;
  inAmount: Amount;
  outAmount: Amount;
  /** Minimum output the transaction enforces (otherAmountThreshold for ExactIn). */
  minOutAmount: Amount;
  slippageBps: Bps;
  priceImpactBps: Bps | null;
  taker: string;
  quotedAt: Instant;
  expiresAt: Instant | null;
  lastValidBlockHeight: number | null;
  /** Exact bytes handed back by the router, and the hash the build step recorded for them. */
  transactionBytes: Uint8Array;
  reportedTransactionHash: Sha256Hex | null;
}

export type OrderRejection =
  | 'REQUEST_ID_MISSING'
  | 'INPUT_MINT_MISMATCH'
  | 'OUTPUT_MINT_MISMATCH'
  | 'AMOUNT_ABOVE_AUTHORIZED'
  | 'AMOUNT_ZERO'
  | 'SLIPPAGE_ABOVE_AUTHORIZED'
  | 'IMPACT_ABOVE_AUTHORIZED'
  | 'IMPACT_UNKNOWN'
  | 'MIN_OUT_BELOW_SLIPPAGE_FLOOR'
  | 'TAKER_MISMATCH'
  | 'QUOTE_TOO_OLD'
  | 'QUOTE_EXPIRED'
  | 'BLOCK_HEIGHT_EXPIRED'
  | 'TRANSACTION_HASH_MISMATCH'
  | 'AUTHORIZATION_EXPIRED';

export type OrderVerdict = { ok: true; transactionHash: Sha256Hex } | { ok: false; reasons: OrderRejection[]; detail: string[] };

export async function checkOrderAgainstAuthorization(order: JupiterOrderFacts, intent: ExecutionBounds, expected: { tradingWallet: string; now: Instant; currentBlockHeight: number | null }): Promise<OrderVerdict> {
  const reasons: OrderRejection[] = [];
  const detail: string[] = [];
  const nowMs = instantToMs(expected.now);
  if (!order.requestId) reasons.push('REQUEST_ID_MISSING');
  if (order.inputMint !== intent.inputMint) reasons.push('INPUT_MINT_MISMATCH');
  if (order.outputMint !== intent.outputMint) reasons.push('OUTPUT_MINT_MISMATCH');
  const inAmount = amountToBigInt(order.inAmount);
  if (inAmount === 0n) reasons.push('AMOUNT_ZERO');
  if (inAmount > amountToBigInt(intent.maxInputAmount)) {
    reasons.push('AMOUNT_ABOVE_AUTHORIZED');
    detail.push(`${order.inAmount} > ${intent.maxInputAmount}`);
  }
  if (order.slippageBps > intent.maxSlippageBps) reasons.push('SLIPPAGE_ABOVE_AUTHORIZED');
  if (order.priceImpactBps === null) reasons.push('IMPACT_UNKNOWN');
  else if (order.priceImpactBps > intent.maxPriceImpactBps) reasons.push('IMPACT_ABOVE_AUTHORIZED');
  // The transaction's own minimum must honour the authorized slippage: minOut ≥ expected × (1 − maxSlippage).
  const floor = (amountToBigInt(order.outAmount) * BigInt(10_000 - intent.maxSlippageBps)) / 10_000n;
  if (amountToBigInt(order.minOutAmount) < floor) {
    reasons.push('MIN_OUT_BELOW_SLIPPAGE_FLOOR');
    detail.push(`minOut ${order.minOutAmount} < floor ${floor}`);
  }
  if (order.taker !== expected.tradingWallet) reasons.push('TAKER_MISMATCH');
  if (nowMs - instantToMs(order.quotedAt) > intent.maxQuoteAgeMs) reasons.push('QUOTE_TOO_OLD');
  if (order.expiresAt !== null && nowMs >= instantToMs(order.expiresAt)) reasons.push('QUOTE_EXPIRED');
  if (order.lastValidBlockHeight !== null && expected.currentBlockHeight !== null && expected.currentBlockHeight > order.lastValidBlockHeight) reasons.push('BLOCK_HEIGHT_EXPIRED');
  if (nowMs >= instantToMs(intent.expiresAt)) reasons.push('AUTHORIZATION_EXPIRED');
  const transactionHash = await sha256Hex(order.transactionBytes);
  if (order.reportedTransactionHash !== null && order.reportedTransactionHash !== transactionHash) reasons.push('TRANSACTION_HASH_MISMATCH');
  return reasons.length ? { ok: false, reasons, detail } : { ok: true, transactionHash };
}
