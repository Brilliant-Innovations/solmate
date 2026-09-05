import { z } from 'zod';
import { CapitalAuthority, ExecutionPath, OrderAttemptState, TransactionClass } from '../enums.js';
import { Amount, Bps, Instant, Milliseconds, MintAddress, Sha256Hex, Slot, SolanaAddress, SolanaCluster, TxSignature, Uuid } from '../primitives.js';
import { TradeIntent } from '../entities/trading.js';
import { SignedAmount } from '../entities/common.js';
import { SignedRiskAuthorizedIntent } from './risk-authorized-intent.js';

/**
 * ExecutionAdapter contract (ADR-0003 guard; blueprint §17, §14.1, D18).
 *
 * There are exactly two implementations, `paper` and `live`, and both consume the one shared
 * Jupiter quote/order client in `libs/execution`. The paper adapter requests a real quote at
 * decision time and never signs; the live adapter runs the full §15.4 validation chain. Strategy
 * code sees only this contract, so P7's "only the execution adapter differs" holds by construction.
 */

// --- Quotes (provider shapes terminate in libs/execution; this is the normalized form) ---------

export const QuoteProvider = z.enum(['JUPITER', 'DIRECT_POOL']);

export const QuoteRequest = z.object({
  inputMint: MintAddress,
  outputMint: MintAddress,
  inputAmount: Amount,
  maxSlippageBps: Bps,
  taker: SolanaAddress,
  cluster: SolanaCluster,
  requestedAt: Instant,
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

export const Quote = z.object({
  provider: QuoteProvider,
  providerRequestId: z.string().nullable(),
  routerLabel: z.string().nullable(),
  inputMint: MintAddress,
  outputMint: MintAddress,
  inputAmount: Amount,
  expectedOutputAmount: Amount,
  minOutputAmount: Amount,
  priceImpactBps: Bps,
  slippageBps: Bps,
  /** Program ids on the route, for signer-policy and executor checks (D55, §15.7A). */
  routeProgramIds: z.array(SolanaAddress),
  usesAddressLookupTables: z.boolean(),
  quotedAt: Instant,
  expiresAt: Instant.nullable(),
  lastValidBlockHeight: z.number().int().nonnegative().nullable(),
});
export type Quote = z.infer<typeof Quote>;

/** A quote plus the assembled (unsigned) transaction from the provider, when one exists. */
export const OrderBuild = z.object({
  quote: Quote,
  transactionClass: TransactionClass,
  unsignedTransactionBase64: z.string().nullable(),
  unsignedTransactionHash: Sha256Hex.nullable(),
  feePayer: SolanaAddress.nullable(),
  requiredSigners: z.array(SolanaAddress),
});
export type OrderBuild = z.infer<typeof OrderBuild>;

export const ExecutionPreview = z.object({
  quote: Quote,
  executionPath: ExecutionPath,
  estimatedFees: z.object({
    networkLamports: Amount,
    priorityLamports: Amount,
    routerBaseUnits: Amount,
    transferFeeBaseUnits: Amount,
  }),
  /** §17.4 configured adverse-execution allowance for this path (paper) or the measured expectation (live). */
  adverseExecutionAllowanceBps: Bps,
  previewedAt: Instant,
});
export type ExecutionPreview = z.infer<typeof ExecutionPreview>;

// --- Execution --------------------------------------------------------------------------------

export const ExecutionRequest = z.object({
  intent: TradeIntent,
  capitalAuthority: CapitalAuthority,
  /** Required and verified when capitalAuthority is LIVE_APPROVAL or LIVE_AUTO. */
  authorization: SignedRiskAuthorizedIntent.nullable(),
  approvalHash: Sha256Hex.nullable(),
  executionPath: ExecutionPath,
  requestedAt: Instant,
});
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;

export const SimulationReport = z.object({
  rpcEndpointLabel: z.string(),
  slot: Slot,
  passed: z.boolean(),
  walletDeltas: z.array(z.object({ mint: MintAddress, delta: SignedAmount })),
  unexpectedAccounts: z.array(SolanaAddress),
  logs: z.array(z.string()),
});
export type SimulationReport = z.infer<typeof SimulationReport>;

export const PaperFillModel = z.object({
  modeledLatencyMs: Milliseconds,
  adverseAllowanceBps: Bps,
  modeledOutputAmount: Amount,
  quoteAtDecision: Quote,
});

export const ExecutionResult = z.object({
  intentId: Uuid,
  attemptId: Uuid,
  state: OrderAttemptState,
  executionPath: ExecutionPath,
  quote: Quote.nullable(),
  simulation: SimulationReport.nullable(),
  signedTxHash: Sha256Hex.nullable(),
  txSignature: TxSignature.nullable(),
  fillId: Uuid.nullable(),
  paper: PaperFillModel.nullable(),
  rejectionReasons: z.array(z.string()),
  completedAt: Instant,
});
export type ExecutionResult = z.infer<typeof ExecutionResult>;

// --- Interfaces (types only) -------------------------------------------------------------------

export interface JupiterQuoteClient {
  /** GET /swap/v2/order (or the price/quote-only form). Never signs. */
  buildOrder(request: QuoteRequest): Promise<OrderBuild>;
}

export interface ExecutionAdapter {
  readonly kind: 'paper' | 'live';
  preview(request: QuoteRequest, path: ExecutionPath): Promise<ExecutionPreview>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
