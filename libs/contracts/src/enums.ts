import { z } from 'zod';

/**
 * Closed vocabularies used across contracts. Values are the blueprint's own labels so that
 * UI copy, logs, audit rows and code agree (blueprint §20.0 principle 1).
 */

// --- Runtime axes (D60, D2) ------------------------------------------------------------------

export const CapitalAuthority = z.enum(['OBSERVE', 'PAPER', 'LIVE_APPROVAL', 'LIVE_AUTO']);
export type CapitalAuthority = z.infer<typeof CapitalAuthority>;

export const ActivityState = z.enum(['OFF', 'STARTING', 'WATCH', 'ACTIVE', 'EVENT_WINDOW', 'WIND_DOWN']);
export type ActivityState = z.infer<typeof ActivityState>;

export const DeploymentProfile = z.enum(['P0', 'P1A', 'P1B', 'P2', 'P3', 'P4']);
export type DeploymentProfile = z.infer<typeof DeploymentProfile>;

/** D61 exposure classification for a lot when the runtime intends to go OFF. */
export const ExposureManagementState = z.enum(['MANAGED', 'OFFLINE_PROTECTED', 'UNMANAGED']);
export type ExposureManagementState = z.infer<typeof ExposureManagementState>;

// --- Strategy / agent (D29–D32, §11, §12) ------------------------------------------------------

export const SpeedTier = z.enum(['T0_FAST', 'T1_MOMENTUM', 'T2_CONTEXTUAL', 'T3_CATALYST']);
export type SpeedTier = z.infer<typeof SpeedTier>;

export const TradingActionType = z.enum(['ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION', 'ADD']);
export type TradingActionType = z.infer<typeof TradingActionType>;

/** Actions that can create, maintain, alter or voluntarily remove exposure (D30). IGNORE is not one. */
export const DiscretionaryExposureAction = z.enum(['ENTER', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION', 'ADD']);
export type DiscretionaryExposureAction = z.infer<typeof DiscretionaryExposureAction>;

export const ProposalSource = z.enum(['AI', 'DETERMINISTIC']);
export type ProposalSource = z.infer<typeof ProposalSource>;

export const AdversaryVerdict = z.enum(['CONFIRM', 'CHALLENGE', 'REJECT']);
export type AdversaryVerdict = z.infer<typeof AdversaryVerdict>;

export const AgentRole = z.enum(['TRADING_PROPOSER', 'ACTION_ADVERSARY', 'EVENT_CLASSIFIER', 'SUMMARIZER']);
export type AgentRole = z.infer<typeof AgentRole>;

/**
 * Action cycle machine states (ADR-0001). Terminal: CLEARED, REJECTED, EXPIRED, UNRESOLVED.
 * PROPOSED means "awaiting adversarial review"; REVISION_REQUESTED means "awaiting the single
 * permitted proposer revision". Every value here is entered by the machine in libs/agents.
 */
export const ActionCycleState = z.enum([
  'TRIGGERED',
  'CONTEXT_BUILT',
  'PROPOSED',
  'REVISION_REQUESTED',
  'CLEARED',
  'REJECTED',
  'EXPIRED',
  'UNRESOLVED',
]);
export type ActionCycleState = z.infer<typeof ActionCycleState>;

export const ActionCycleTerminalState = z.enum(['CLEARED', 'REJECTED', 'EXPIRED', 'UNRESOLVED']);
export type ActionCycleTerminalState = z.infer<typeof ActionCycleTerminalState>;

/** Six causes from D39 (ADR-0001). */
export const UnresolvedReason = z.enum([
  'DISAGREEMENT',
  'ADVERSARY_UNAVAILABLE',
  'TIMEOUT',
  'BUDGET',
  'MALFORMED_OUTPUT',
  'REVISION_EXHAUSTED',
]);
export type UnresolvedReason = z.infer<typeof UnresolvedReason>;

export const CatalystNovelty = z.enum(['new', 'confirming', 'stale', 'none', 'unknown']);
export type CatalystNovelty = z.infer<typeof CatalystNovelty>;

export const Urgency = z.enum(['normal', 'high']);
export type Urgency = z.infer<typeof Urgency>;

export const StrategyStatus = z.enum(['EXPERIMENTAL', 'PAPER', 'ELIGIBLE_LIVE', 'RETIRED']);
export type StrategyStatus = z.infer<typeof StrategyStatus>;

export const SkillStatus = z.enum(['DRAFT', 'PAPER', 'ELIGIBLE_LIVE', 'RETIRED']);
export type SkillStatus = z.infer<typeof SkillStatus>;

export const ReleaseStatus = z.enum(['DRAFT', 'PAPER_VALIDATED', 'ELIGIBLE_LIVE', 'ARMED', 'RETIRED']);
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;

export const AutomationTriggerFamily = z.enum(['CANDIDATE', 'OPEN_POSITION', 'SYSTEM']);
export type AutomationTriggerFamily = z.infer<typeof AutomationTriggerFamily>;

export const ToolClassification = z.enum(['READ_ONLY', 'PROPOSAL_ONLY']);
export type ToolClassification = z.infer<typeof ToolClassification>;

// --- Positions / protection (D13, D39, §7.5, §16) ---------------------------------------------

export const PositionReviewState = z.enum(['REVIEWED', 'PROTECTION_ONLY', 'BUDGET_PAUSED']);
export type PositionReviewState = z.infer<typeof PositionReviewState>;

export const PositionSafetyState = z.enum(['NORMAL', 'DEGRADED', 'EXIT_RECOMMENDED', 'CRITICAL_EXIT']);
export type PositionSafetyState = z.infer<typeof PositionSafetyState>;

export const PositionStatus = z.enum(['OPEN', 'CLOSING', 'CLOSED']);
export type PositionStatus = z.infer<typeof PositionStatus>;

export const ProtectionMode = z.enum(['MONITORED_EXIT', 'JUPITER_TRIGGER']);
export type ProtectionMode = z.infer<typeof ProtectionMode>;

export const StopModel = z.enum(['ATR', 'STRUCTURE_LOW', 'PERCENTAGE', 'STRATEGY_INVALIDATION']);
export type StopModel = z.infer<typeof StopModel>;

export const TakeProfitPolicy = z.enum([
  'FIXED_R',
  'PARTIAL_TIERS',
  'TRAILING_AFTER_THRESHOLD',
  'VOLATILITY_TRAIL',
  'MOMENTUM_DECAY',
  'TIME_STOP',
]);
export type TakeProfitPolicy = z.infer<typeof TakeProfitPolicy>;

// --- Execution (D12, D22, D49, §14.7, §17.4) ---------------------------------------------------

export const TradeSide = z.enum(['BUY', 'SELL']);
export type TradeSide = z.infer<typeof TradeSide>;

export const IntentAction = z.enum([
  'ENTER',
  'ADD',
  'REDUCE',
  'EXIT',
  'PROTECTION_INSTALL',
  'PROTECTION_CANCEL_WITHDRAW',
  'EMERGENCY_CLOSE',
]);
export type IntentAction = z.infer<typeof IntentAction>;

export const ExposureEffect = z.enum(['INCREASE', 'NEUTRAL', 'REDUCE']);
export type ExposureEffect = z.infer<typeof ExposureEffect>;

/** Order-attempt machine (§6.18, §14.7). NOT_LANDED is the conclusive non-execution terminal. */
export const OrderAttemptState = z.enum([
  'PREPARED',
  'SIGNED_NOT_SUBMITTED',
  'SUBMITTED',
  'CONFIRMED_PROVISIONAL',
  'FINALIZED',
  'REORG_PENDING',
  'NOT_LANDED',
]);
export type OrderAttemptState = z.infer<typeof OrderAttemptState>;

export const ChainCommitment = z.enum(['processed', 'confirmed', 'finalized']);
export type ChainCommitment = z.infer<typeof ChainCommitment>;

export const ExecutionPath = z.enum(['JUPITER_ORDER', 'PROVIDER_PROTECTIVE', 'DIRECT_POOL_PRIVATE', 'DIRECT_POOL_RPC']);
export type ExecutionPath = z.infer<typeof ExecutionPath>;

export const TransactionClass = z.enum([
  'SWAP_V2',
  'TRIGGER_DEPOSIT',
  'TRIGGER_CANCEL_WITHDRAW',
  'TRIGGER_AUTH_CHALLENGE',
  'DIRECT_POOL_EMERGENCY_EXIT',
  'SWEEP_TO_COLD_RECOVERY',
]);
export type TransactionClass = z.infer<typeof TransactionClass>;

export const EmergencyCommandType = z.enum(['PAUSE_NEW_ENTRIES', 'EMERGENCY_CLOSE_ASSET', 'EMERGENCY_CLOSE_ALL']);
export type EmergencyCommandType = z.infer<typeof EmergencyCommandType>;

export const CustodyKind = z.enum(['TRADING_WALLET', 'ASSOCIATED_TOKEN_ACCOUNT', 'JUPITER_TRIGGER_VAULT', 'APPROVED_OTHER']);
export type CustodyKind = z.infer<typeof CustodyKind>;

// --- Universe / signals (§6.1, §6.9, §8.5, §9, D62) --------------------------------------------

export const AssetStatus = z.enum(['DISCOVERED', 'EVALUATING', 'ELIGIBLE', 'BLOCKED', 'RETIRED']);
export type AssetStatus = z.infer<typeof AssetStatus>;

export const CandidateStatus = z.enum(['DETECTED', 'ENRICHING', 'REJECTED', 'AGENT_REVIEW', 'QUALIFIED', 'EXPIRED']);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const TriggerFamily = z.enum([
  'MOMENTUM_CONTINUATION',
  'EARLY_ACCELERATION',
  'SMART_MONEY_ACCUMULATION',
  'CATALYST_RESPONSE',
  'SOCIAL_ACCELERATION',
  'HOLDER_LIQUIDITY_EXPANSION',
  'MANUAL_WATCH',
]);
export type TriggerFamily = z.infer<typeof TriggerFamily>;

export const MarketRegime = z.enum([
  'RISK_ON_TREND',
  'BROAD_SELLOFF',
  'SOL_LED_RALLY',
  'NARRATIVE_ROTATION',
  'LOW_LIQUIDITY_CHOP',
  'VOLATILITY_SHOCK',
  'POST_EVENT_INSTABILITY',
]);
export type MarketRegime = z.infer<typeof MarketRegime>;

export const MarketSession = z.enum(['ASIA', 'EUROPE', 'US', 'ASIA_EUROPE_OVERLAP', 'EUROPE_US_OVERLAP', 'WEEKEND']);
export type MarketSession = z.infer<typeof MarketSession>;

export const DataProvenance = z.enum(['LIVE', 'BACKFILL', 'REPLAY']);
export type DataProvenance = z.infer<typeof DataProvenance>;

// --- Intelligence (§6.6, §6.7, §10.4) ----------------------------------------------------------

export const EventKind = z.enum(['NEWS', 'SOCIAL', 'ONCHAIN', 'PROJECT', 'MACRO', 'LISTING', 'SECURITY', 'OTHER']);
export type EventKind = z.infer<typeof EventKind>;

export const SourceQualityClass = z.enum([
  'OFFICIAL_PROJECT',
  'OFFICIAL_EXCHANGE_PROTOCOL',
  'PRIMARY_GOVERNMENT_REGULATORY',
  'REPUTABLE_PUBLICATION',
  'ANALYTICS_PROVIDER',
  'IDENTIFIED_CREATOR',
  'UNKNOWN_SOCIAL',
]);
export type SourceQualityClass = z.infer<typeof SourceQualityClass>;

export const SourceTimeConfidence = z.enum(['HIGH', 'MEDIUM', 'LOW', 'ABSENT']);
export type SourceTimeConfidence = z.infer<typeof SourceTimeConfidence>;

export const WalletClassification = z.enum([
  'SMART_MONEY',
  'WHALE',
  'DEV',
  'INSIDER',
  'SNIPER',
  'BUNDLER',
  'EXCHANGE',
  'TREASURY',
  'OWNED',
  'UNKNOWN',
]);
export type WalletClassification = z.infer<typeof WalletClassification>;

// --- Ops / audit (§6.17A, §6.16D, §6.22, §20.20, §20.26) ---------------------------------------

export const FundingEventState = z.enum(['PREPARED', 'WALLET_PROMPTED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'ABANDONED']);
export type FundingEventState = z.infer<typeof FundingEventState>;

export const AlertSeverity = z.enum(['INFO', 'NOTICE', 'HIGH', 'CRITICAL']);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const OperatorRole = z.enum(['viewer', 'operator', 'admin']);
export type OperatorRole = z.infer<typeof OperatorRole>;

export const ActorKind = z.enum([
  'OPERATOR',
  'WORKER',
  'RISK_AUTHORIZER',
  'EXECUTOR',
  'OUT_OF_BAND_KEY',
  'AUTOMATION',
  'WATCHDOG',
  'SCHEDULE',
]);
export type ActorKind = z.infer<typeof ActorKind>;

export const ProviderHealth = z.enum(['HEALTHY', 'DEGRADED', 'FAILED']);
export type ProviderHealth = z.infer<typeof ProviderHealth>;

export const QueueName = z.enum(['trade-critical', 'reconciliation', 'trading-actions', 'research']);
export type QueueName = z.infer<typeof QueueName>;

/** ops.control_requests.kind: the only thing a browser session may ask for (§20.23, §23.3). */
export const ControlRequestKind = z.enum([
  'SET_REQUESTED_MODE',
  'PAUSE_NEW_ENTRIES',
  'RESUME_NEW_ENTRIES',
  'APPROVE_AUTHORIZATION',
  'REJECT_AUTHORIZATION',
  'MANUAL_REDUCE',
  'MANUAL_CLOSE',
  'EMERGENCY_CLOSE_ALL',
  'ACKNOWLEDGE_ALERT',
  'PROMOTE_RELEASE',
  'ARM_RELEASE',
  'RUN_READINESS_DRILL',
  'START_SESSION',
  'END_SESSION',
  'REGISTER_PASSKEY',
  'REVOKE_PASSKEY',
  'WATCH_ASSET',
  'UNWATCH_ASSET',
  'REQUEST_RESEARCH_REFRESH',
]);
export type ControlRequestKind = z.infer<typeof ControlRequestKind>;

export const ControlRequestState = z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED']);
export type ControlRequestState = z.infer<typeof ControlRequestState>;

export const ReplayFidelity = z.enum(['A_HISTORICAL', 'B_CAPTURED', 'C_LIVE_PAPER']);
export type ReplayFidelity = z.infer<typeof ReplayFidelity>;
