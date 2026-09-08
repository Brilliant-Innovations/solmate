import { z } from 'zod';
import {
  ActivityState,
  ActorKind,
  AlertSeverity,
  CapitalAuthority,
  ControlRequestKind,
  ControlRequestState,
  DeploymentProfile,
  FundingEventState,
  MarketRegime,
  MarketSession,
} from '../enums.js';
import { Amount, Instant, MintAddress, SolanaAddress, SolanaCluster, TxSignature, UsdValue, Uuid, VersionId } from '../primitives.js';
import { JsonRecord, SignedAmount } from './common.js';

// §6.17A ops.wallet_funding_events --------------------------------------------------------------

/** Audit/reconciliation record only; never consumed as authority by the risk-authorizer or executor. */
export const WalletFundingEvent = z.object({
  id: Uuid,
  operatorUserId: Uuid,
  sourceWallet: SolanaAddress,
  destinationTradingWallet: SolanaAddress,
  destinationAta: SolanaAddress.nullable(),
  fundingMint: MintAddress,
  requestedAmount: Amount,
  cluster: SolanaCluster,
  state: FundingEventState,
  txSignature: TxSignature.nullable(),
  confirmedDeltas: z
    .object({
      source: SignedAmount,
      destination: SignedAmount,
    })
    .nullable(),
  createdAt: Instant,
  submittedAt: Instant.nullable(),
  confirmedAt: Instant.nullable(),
  failureReason: z.string().nullable(),
});
export type WalletFundingEvent = z.infer<typeof WalletFundingEvent>;

// §6.16B ops.spend_budgets / spend_usage (D43) --------------------------------------------------

export const SpendBudget = z.object({
  id: Uuid,
  versionId: VersionId,
  scope: z.enum(['PLATFORM', 'STRATEGY', 'PROVIDER']),
  scopeId: z.string().nullable(),
  limits: z.object({
    cyclesPerHour: z.number().int().nonnegative().nullable(),
    modelUsdPerDay: UsdValue.nullable(),
    providerRequestsPerMinute: z.number().int().nonnegative().nullable(),
  }),
  active: z.boolean(),
  createdAt: Instant,
});
export type SpendBudget = z.infer<typeof SpendBudget>;

export const SpendUsage = z.object({
  id: Uuid,
  budgetId: Uuid,
  windowStart: Instant,
  windowEnd: Instant,
  cycles: z.number().int().nonnegative(),
  modelUsd: UsdValue,
  providerRequests: z.number().int().nonnegative(),
  state: z.enum(['OK', 'BUDGET_PAUSED']),
  updatedAt: Instant,
});
export type SpendUsage = z.infer<typeof SpendUsage>;

// §6.16D ops.notifications / deliveries (D42, §20.20) -------------------------------------------

export const NotificationChannel = z.enum(['IN_APP', 'PUSH', 'TELEGRAM', 'SMS', 'EMAIL']);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const Notification = z.object({
  id: Uuid,
  severity: AlertSeverity,
  alertClass: z.string().min(1).max(64),
  summary: z.string().min(1).max(512),
  affected: z.object({
    assetId: Uuid.nullable(),
    strategyVersionId: VersionId.nullable(),
    positionId: Uuid.nullable(),
    system: z.string().nullable(),
  }),
  raisedAt: Instant,
  automatedResponse: z.string().nullable(),
  acknowledgedAt: Instant.nullable(),
  acknowledgedBy: Uuid.nullable(),
  resolvedAt: Instant.nullable(),
  escalationLevel: z.number().int().nonnegative(),
  deadManDeadline: Instant.nullable(),
  deadManActionTaken: z.enum(['PAUSE_NEW_ENTRIES']).nullable(),
});
export type Notification = z.infer<typeof Notification>;

export const NotificationDelivery = z.object({
  id: Uuid,
  notificationId: Uuid,
  channel: NotificationChannel,
  attemptedAt: Instant,
  confirmedAt: Instant.nullable(),
  error: z.string().nullable(),
});
export type NotificationDelivery = z.infer<typeof NotificationDelivery>;

// §6.22A ops.runtime_sessions (D60, D61, D63) ---------------------------------------------------

export const ColdStartGate = z.object({
  name: z.string().min(1).max(64),
  passed: z.boolean(),
  checkedAt: Instant,
  detail: z.string().nullable(),
});

export type ColdStartGate = z.infer<typeof ColdStartGate>;

export const SessionTransition = z.object({
  from: ActivityState,
  to: ActivityState,
  at: Instant,
  actor: ActorKind,
  actorRef: z.string().nullable(),
  reason: z.string().nullable(),
});

export const RuntimeSession = z.object({
  id: Uuid,
  profile: DeploymentProfile,
  activityState: ActivityState,
  capitalAuthority: CapitalAuthority,
  paused: z.object({
    active: z.boolean(),
    reason: z.string().nullable(),
    since: Instant.nullable(),
    by: ActorKind.nullable(),
  }),
  attended: z.boolean(),
  lastPresenceHeartbeatAt: Instant.nullable(),
  scheduledStartAt: Instant.nullable(),
  intendedEndAt: Instant.nullable(),
  actualStartAt: Instant.nullable(),
  actualEndAt: Instant.nullable(),
  marketSessions: z.array(MarketSession),
  regime: MarketRegime.nullable(),
  eventWindow: z
    .object({
      catalystEventId: Uuid,
      sourceTimeT0: Instant,
      deadline: Instant,
      extensionsUsed: z.number().int().nonnegative(),
    })
    .nullable(),
  coldStartGates: z.array(ColdStartGate),
  exposureAtLastTransition: z.object({
    managedCount: z.number().int().nonnegative(),
    offlineProtectedCount: z.number().int().nonnegative(),
    unmanagedCount: z.number().int().nonnegative(),
    unmanagedUsd: UsdValue.nullable(),
  }),
  windDownBlockers: z.array(z.string()),
  inFlightExecutionIds: z.array(Uuid),
  offlineResumeDeadline: Instant.nullable(),
  resumeWatchdog: z.object({
    expectedCheckAt: Instant.nullable(),
    lastCheckAt: Instant.nullable(),
    status: z.enum(['NOT_REQUIRED', 'HEALTHY', 'OVERDUE', 'FAILED']),
  }),
  transitions: z.array(SessionTransition),
  metadata: JsonRecord,
});
export type RuntimeSession = z.infer<typeof RuntimeSession>;

// ops.control_requests (§20.23, §23.3, D41) ---------------------------------------------------

/**
 * The single browser write surface. Inserted by an authenticated operator under RLS (aal2 session
 * required); validated and acted on by the worker, which records the outcome. A request whose kind
 * widens financial authority carries step-up evidence (see policy/step-up.ts) and, once verified,
 * a reference to the immutable ops.step_up_assertions row.
 */
export const ControlRequest = z.object({
  id: Uuid,
  requestedBy: Uuid,
  kind: ControlRequestKind,
  payload: JsonRecord,
  /** ops.step_up_assertions.id once the worker verified the evidence for this request. */
  stepUpAssertionRef: Uuid.nullable(),
  state: ControlRequestState,
  resolution: JsonRecord.nullable(),
  createdAt: Instant,
  resolvedAt: Instant.nullable(),
});
export type ControlRequest = z.infer<typeof ControlRequest>;

// D56 ops.capital_attestations -------------------------------------------------------------------

/** The capital ceiling live arming attested to for an account under a Release; append-only. */
export const CapitalAttestation = z.object({
  id: Uuid,
  accountId: Uuid,
  releaseId: Uuid,
  attestationId: Uuid,
  ceilingUsd: UsdValue,
  recognizedUsdAtAttestation: UsdValue.nullable(),
  attestedBy: Uuid,
  attestedAt: Instant,
});
export type CapitalAttestation = z.infer<typeof CapitalAttestation>;
