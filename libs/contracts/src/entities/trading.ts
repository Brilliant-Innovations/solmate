import { z } from 'zod';
import {
  ChainCommitment,
  CustodyKind,
  ExecutionPath,
  ExposureEffect,
  IntentAction,
  OrderAttemptState,
  PositionReviewState,
  PositionSafetyState,
  PositionStatus,
  ProposalSource,
  ProtectionMode,
  StopModel,
  TakeProfitPolicy,
  TradeSide,
  TransactionClass,
  UnresolvedReason,
} from '../enums.js';
import {
  Amount,
  Bps,
  Fraction,
  IdempotencyKey,
  Instant,
  Milliseconds,
  Sha256Hex,
  Slot,
  SolanaAddress,
  MintAddress,
  Nonce,
  TxSignature,
  UsdValue,
  Uuid,
  VersionId,
} from '../primitives.js';
import { TradingActionProposal } from '../envelopes/trading-action.js';
import { SignedApprovalGrant } from '../envelopes/approval.js';
import { SignedRiskAuthorizedIntent } from '../envelopes/risk-authorized-intent.js';
import { PositionRiskShadow } from '../envelopes/journal.js';
import { JsonRecord, ReasonCodes, SignedAmount } from './common.js';

// §6.11 trading.proposals -----------------------------------------------------------------------

export const Proposal = z.object({
  id: Uuid,
  actionCycleId: Uuid,
  candidateId: Uuid.nullable(),
  positionId: Uuid.nullable(),
  strategyVersionId: VersionId,
  source: ProposalSource,
  proposal: TradingActionProposal,
  createdAt: Instant,
  expiresAt: Instant,
});
export type Proposal = z.infer<typeof Proposal>;

// §6.12 trading.risk_evaluations ----------------------------------------------------------------

export const StopPolicy = z.object({
  model: StopModel,
  /** Stop level as a price in settlement terms; analytics representation of the deterministic rule. */
  level: z.number().nonnegative().nullable(),
  distanceFraction: Fraction,
});

export const TargetPolicy = z.object({
  policy: TakeProfitPolicy,
  parameters: JsonRecord,
});

export const FreshnessCheck = z.object({
  dataClass: z.string().min(1).max(64),
  fresh: z.boolean(),
  ageMs: Milliseconds.nullable(),
  limitMs: Milliseconds,
});

export const RiskEvaluation = z.object({
  id: Uuid,
  proposalId: Uuid,
  actionCycleId: Uuid,
  policyVersion: VersionId,
  allowed: z.boolean(),
  reasonCodes: ReasonCodes,
  settlementMint: MintAddress,
  equityBaseUnits: Amount,
  equityUsd: UsdValue.nullable(),
  exposureBaseUnits: Amount,
  cohortExposure: z.record(z.string(), Fraction),
  clusterExposure: z.record(z.string(), Fraction),
  sleeveExposure: Fraction.nullable(),
  assetEligibilityEvaluationId: Uuid.nullable(),
  computedMaxLossBaseUnits: Amount.nullable(),
  computedPositionAmount: Amount.nullable(),
  maxSlippageBps: Bps,
  maxPriceImpactBps: Bps,
  stopPolicy: StopPolicy.nullable(),
  targetPolicy: TargetPolicy.nullable(),
  dailyDrawdownFraction: Fraction,
  circuitBreakerTripped: z.boolean(),
  staleDataChecks: z.array(FreshnessCheck),
  createdAt: Instant,
});
export type RiskEvaluation = z.infer<typeof RiskEvaluation>;

// §6.13 trading.intents -------------------------------------------------------------------------

export const ExecutionConstraints = z.object({
  maxSlippageBps: Bps,
  maxPriceImpactBps: Bps,
  chaseToleranceBps: Bps,
  maxQuoteAgeMs: Milliseconds,
});
export type ExecutionConstraints = z.infer<typeof ExecutionConstraints>;

/** A database intent row alone is never execution authority (§6.13). */
export const TradeIntent = z.object({
  id: Uuid,
  idempotencyKey: IdempotencyKey,
  accountId: Uuid,
  strategyVersionId: VersionId,
  sleeveId: Uuid.nullable(),
  assetId: Uuid,
  action: IntentAction,
  side: TradeSide,
  exposureEffect: ExposureEffect,
  inputMint: MintAddress,
  outputMint: MintAddress,
  maxInputAmount: Amount,
  riskEvaluationId: Uuid,
  actionCycleId: Uuid,
  clearedCutoffVersion: z.number().int().positive(),
  constraints: ExecutionConstraints,
  protectionPolicyRef: VersionId.nullable(),
  targetLotIds: z.array(Uuid),
  approvalRequired: z.boolean(),
  createdAt: Instant,
  expiresAt: Instant,
});
export type TradeIntent = z.infer<typeof TradeIntent>;

// §6.14 trading.risk_authorizations / §6.15 approvals (stored envelopes) -------------------------

export const RiskAuthorizationRecord = z.object({
  id: Uuid,
  intentId: Uuid,
  authorizationHash: Sha256Hex,
  envelope: SignedRiskAuthorizedIntent,
  createdAt: Instant,
});
export type RiskAuthorizationRecord = z.infer<typeof RiskAuthorizationRecord>;

export const ApprovalRecord = z.object({
  id: Uuid,
  authorizationHash: Sha256Hex,
  intentId: Uuid,
  approverId: Uuid,
  role: z.enum(['operator', 'admin']),
  stepUpAssertionRef: z.string().nullable(),
  grantedAt: Instant,
  expiresAt: Instant,
  nonce: Nonce,
  envelope: SignedApprovalGrant,
  revokedAt: Instant.nullable(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

// §6.16 sleeves and lots ------------------------------------------------------------------------

export const StrategySleeve = z.object({
  id: Uuid,
  accountId: Uuid,
  strategyVersionId: VersionId,
  versionId: VersionId,
  settlementMint: MintAddress,
  capitalCapBaseUnits: Amount,
  riskBudgetBaseUnits: Amount,
  committedBaseUnits: Amount,
  riskUsedBaseUnits: Amount,
  active: z.boolean(),
  createdAt: Instant,
});
export type StrategySleeve = z.infer<typeof StrategySleeve>;

export const PositionLot = z.object({
  id: Uuid,
  positionId: Uuid,
  sleeveId: Uuid,
  strategyVersionId: VersionId,
  assetId: Uuid,
  mint: MintAddress,
  quantity: Amount,
  costBasisBaseUnits: Amount,
  entryIntentId: Uuid,
  entryFillIds: z.array(Uuid),
  exitFillIds: z.array(Uuid),
  realizedPnlBaseUnits: SignedAmount,
  protectionMode: ProtectionMode,
  providerOrderId: z.string().nullable(),
  reservedForProtection: Amount,
  status: z.enum(['OPEN', 'CLOSED']),
  openedAt: Instant,
  closedAt: Instant.nullable(),
});
export type PositionLot = z.infer<typeof PositionLot>;

// §6.17 trading.custody_accounts ----------------------------------------------------------------

export const CustodyAccount = z.object({
  id: Uuid,
  kind: CustodyKind,
  address: SolanaAddress,
  ownerProvider: z.string(),
  mint: MintAddress.nullable(),
  allowedMovementTypes: z.array(TransactionClass),
  activeFrom: Instant,
  activeTo: Instant.nullable(),
  verificationState: z.enum(['VERIFIED', 'PENDING', 'REVOKED']),
});
export type CustodyAccount = z.infer<typeof CustodyAccount>;

// §6.18 orders, attempts, fills -----------------------------------------------------------------

export const Order = z.object({
  id: Uuid,
  intentId: Uuid,
  authorizationHash: Sha256Hex.nullable(),
  executionPath: ExecutionPath,
  transactionClass: TransactionClass,
  createdAt: Instant,
});
export type Order = z.infer<typeof Order>;

export const SubmissionResult = z.object({
  at: Instant,
  path: ExecutionPath,
  ok: z.boolean(),
  providerResponseSignature: TxSignature.nullable(),
  error: z.string().nullable(),
});

/** The pre-submit record is persisted before any network submission (D12, §6.18, §15.4 step 10). */
export const OrderAttempt = z.object({
  id: Uuid,
  orderId: Uuid,
  intentId: Uuid,
  authorizationHash: Sha256Hex.nullable(),
  attemptNumber: z.number().int().positive(),
  state: OrderAttemptState,
  jupiterRequestId: z.string().nullable(),
  router: z.string().nullable(),
  signedTxHash: Sha256Hex.nullable(),
  walletSignature: TxSignature.nullable(),
  expectedTxSignature: TxSignature.nullable(),
  blockhash: z.string().nullable(),
  lastValidBlockHeight: z.number().int().nonnegative().nullable(),
  quoteExpiresAt: Instant.nullable(),
  signedAt: Instant.nullable(),
  submittedAt: Instant.nullable(),
  submissions: z.array(SubmissionResult),
  confirmedAt: Instant.nullable(),
  confirmedSlot: Slot.nullable(),
  finalizedAt: Instant.nullable(),
  finalizedSlot: Slot.nullable(),
  reorgDetectedAt: Instant.nullable(),
  notLandedReason: z.string().nullable(),
  reconciliationOutcome: z.string().nullable(),
  createdAt: Instant,
});
export type OrderAttempt = z.infer<typeof OrderAttempt>;

export const FeeBreakdown = z.object({
  networkBaseUnits: Amount,
  priorityBaseUnits: Amount,
  routerBaseUnits: Amount,
  transferFeeBaseUnits: Amount,
});

export const Fill = z.object({
  id: Uuid,
  orderAttemptId: Uuid,
  txSignature: TxSignature,
  commitment: ChainCommitment,
  slot: Slot,
  inputMint: MintAddress,
  outputMint: MintAddress,
  inputAmount: Amount,
  outputAmount: Amount,
  fees: FeeBreakdown,
  /** Realized shortfall versus the contemporaneous executable expectation (D48). Never labeled "MEV" by itself. */
  executionShortfallBps: z.number().nullable(),
  executionPath: ExecutionPath,
  lotAllocations: z.array(z.object({ lotId: Uuid, quantity: Amount })),
  filledAt: Instant,
});
export type Fill = z.infer<typeof Fill>;

// §6.19 trading.positions -----------------------------------------------------------------------

export const Position = z.object({
  id: Uuid,
  accountId: Uuid,
  assetId: Uuid,
  mint: MintAddress,
  quantity: Amount,
  averageEntryPrice: z.number().nonnegative().nullable(),
  costBasisBaseUnits: Amount,
  realizedPnlBaseUnits: SignedAmount,
  unrealizedPnlBaseUnits: SignedAmount.nullable(),
  stop: StopPolicy.nullable(),
  target: TargetPolicy.nullable(),
  /** Deterministic stop that may only tighten while unreviewed (D39). */
  unreviewedStop: z.number().nonnegative().nullable(),
  custodySplit: z.array(z.object({ custodyAccountId: Uuid, quantity: Amount })),
  status: PositionStatus,
  reviewState: PositionReviewState,
  reviewStateReason: UnresolvedReason.nullable(),
  reviewStateSince: Instant,
  lastReviewedCycleId: Uuid.nullable(),
  nextReassessmentAt: Instant.nullable(),
  safetyState: PositionSafetyState,
  lotIds: z.array(Uuid),
  openedAt: Instant,
  closedAt: Instant.nullable(),
});
export type Position = z.infer<typeof Position>;

// §6.20 trading.portfolio_snapshots -------------------------------------------------------------

export const PortfolioSnapshot = z.object({
  id: Uuid,
  accountId: Uuid,
  asOf: Instant,
  settlementMint: MintAddress,
  equityBaseUnits: Amount,
  equityUsd: UsdValue.nullable(),
  exposureBaseUnits: Amount,
  exposureFraction: Fraction,
  perSleeve: z.array(z.object({ sleeveId: Uuid, committedBaseUnits: Amount, pnlBaseUnits: SignedAmount })),
  perCohort: z.array(z.object({ cohortId: Uuid, exposureFraction: Fraction })),
  drawdown: z.object({ dailyFraction: Fraction, rollingFraction: Fraction }),
  createdAt: Instant,
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshot>;

// §6.16C trading.position_shadow_journal --------------------------------------------------------

export const PositionShadowJournalEntry = z.object({
  id: Uuid,
  sequence: z.number().int().nonnegative(),
  hash: Sha256Hex,
  shadow: PositionRiskShadow,
  createdAt: Instant,
  synchronizedAt: Instant.nullable(),
});
export type PositionShadowJournalEntry = z.infer<typeof PositionShadowJournalEntry>;
