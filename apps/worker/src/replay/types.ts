import type { ActionCycle, ActionCycleTerminalState, AdversarialReview, AssetEligibility, Candidate, Candle, Clock, EligibilityPolicy, FeatureEngineSpec, FeatureSnapshot, Instant, IntelligenceEvent, MarketRegimePolicy, MintAddress, MomentumTriggerPolicy, PaperFillPolicy, QuoteProbe, ReplayCostModel, ReplayDecision, ReplayRun, ReplayVariant, RiskPolicy, S0SafetyGatePolicy, StrategyVersion, Uuid, VersionId } from '@sol-agent-trader/contracts';
import type { ClosedTrade, GuardContext, ObservationDiscipline } from '@sol-agent-trader/replay';
import type { ActiveMembership } from '@sol-agent-trader/risk';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Replay engine types (blueprint §18, P9; execution plan M10). A dataset is everything a run may
 * ever read, loaded once and frozen; every read the engine makes goes through the look-ahead
 * guard with the simulated clock, so the dataset can hold the whole window without the strategy
 * seeing past `now`.
 */

export interface ReplayAsset {
  id: Uuid;
  mint: MintAddress;
  symbol: string;
  decimals: number;
  tokenProgram: 'TOKEN' | 'TOKEN_2022' | 'UNKNOWN';
}

/** Recorded S1 decision (Level B): the stored cycle, proposal and review for a candidate the live worker decided. */
export interface RecordedDecision {
  candidateId: Uuid;
  strategyVersionId: VersionId;
  cycle: { id: Uuid; state: ActionCycle['state']; startedAt: Instant; verdict: string | null; reasonCodes: string[] };
  proposal: { proposal: Record<string, unknown>; expiresAt: Instant } | null;
  review: { verdict: AdversarialReview['verdict']; objections: { code: string }[]; confidence: number | null } | null;
  /** When the live worker finished deciding; the replay may not act before it (§18.3). */
  decidedAt: Instant;
}

export interface ReplayDataset {
  assets: ReplayAsset[];
  /** 1m candles per asset with `observedAt` (capture time), any order. */
  candles: Map<Uuid, Candle[]>;
  /** Eligibility evaluations per asset; only the newest evaluated at or before `now` counts. */
  eligibility: Map<Uuid, AssetEligibility[]>;
  /** Level B captured quotes per asset (§18.1); empty for Level A. */
  quoteProbes: Map<Uuid, QuoteProbe[]>;
  /** Intelligence events visible by first-seen time (catalyst family; unused by S0). */
  events: IntelligenceEvent[];
  /** Taxonomy memberships (§6.3) as observed; the sizing core treats an unknown cohort as zero capacity (ADR-0007). */
  memberships: ActiveMembership[];
  /** Level B recorded S1 decisions by candidate (live candidate ids), used by the recorded strategy. */
  recorded: RecordedDecision[];
  /** SOL 1h return series for relative strength, keyed by minute; empty = no reference. */
  solReturn1h: Map<string, number>;
  /**
   * How the universe was chosen and whether it was cut (review 2026-09-09, M-10). A run that
   * silently dropped assets is a run whose survivorship properties are unknown, so the selection
   * rule and the truncation travel with the results.
   */
  universe?: { requested: number | null; selected: number; available: number; truncated: boolean; selectionRule: string };
  /** Settlement units per SOL inside the window, for charging network and priority fees; null when unknown. */
  solPriceSettlement?: number | null;
}

/** What the run can say about its own fidelity, rather than what its label claims (§18.1). */
export interface DatasetFidelityReport {
  observationDiscipline: ObservationDiscipline;
  candles: { total: number; withObservedAt: number; lateObserved: number; medianLagMs: number | null; maxLagMs: number | null };
  universe: { requested: number | null; selected: number; available: number; truncated: boolean; selectionRule: string };
  solPriceSettlement: number | null;
}

/** What a strategy sees when asked to decide: the candidate, its snapshot and the clock; reads go through `guard`. */
export interface ReplayDecisionContext {
  candidate: Candidate;
  snapshot: FeatureSnapshot;
  now: Instant;
  guard: GuardContext;
  dataset: ReplayDataset;
  newId: () => Uuid;
  variant: ReplayVariant;
}

export interface StrategyVerdict {
  cycleState: ActionCycleTerminalState;
  action: 'ENTER' | null;
  proposerConfidence: number | null;
  adversaryVerdict: AdversarialReview['verdict'] | null;
  reasonCodes: string[];
  /** Decision moment (candidate discovery + the strategy's own latency); the engine takes the executable quote after it. */
  decidedAt: Instant;
  decisionLatencyMs: number;
  /** Proposal expiry used for the intent; null = the strategy's default. */
  expiresAt: Instant | null;
}

export interface ReplayStrategy {
  version: StrategyVersion;
  /** Which run variants this strategy participates in. */
  variants: readonly ReplayVariant[];
  decide(ctx: ReplayDecisionContext): StrategyVerdict;
}

export interface ReplayPolicies {
  featureSpec: FeatureEngineSpec;
  momentum: MomentumTriggerPolicy;
  gate: S0SafetyGatePolicy;
  risk: RiskPolicy;
  costModel: ReplayCostModel;
  eligibility: EligibilityPolicy;
  regime: MarketRegimePolicy;
}

export interface ReplayAccount {
  settlementMint: MintAddress;
  settlementDecimals: number;
  /** Every strategy starts with this balance in its own isolated book (P9: same timeline, same capital). */
  startingCapital: string;
  virtualSolLamports: string;
  sleeveCap: string;
  sleeveRiskBudget: string;
}

export interface ReplayEngineDeps {
  run: ReplayRun;
  dataset: ReplayDataset;
  strategies: ReplayStrategy[];
  policies: ReplayPolicies;
  account: ReplayAccount;
  logger: Logger;
  /** Tick spacing; 60 000 = one feature vector per closed minute (the live cadence). */
  tickMs?: number;
  /** For tests: swaps the detector; default is the momentum family through the real detector. */
  detect?: DetectFn;
  /** Plan M10 latency-matched baseline: the latency the baseline is also decided at; default = the slowest non-baseline strategy's budget. */
  latencyMatchedMs?: number;
}

export type DetectFn = (input: { snapshot: FeatureSnapshot; now: Instant; newId: () => Uuid; entryGate: { allowed: boolean; reason: string | null; eligibilityEvaluationId: Uuid | null }; openCandidates: readonly Pick<Candidate, 'dedupeKey' | 'discoveredAt'>[]; lastTerminalAt: Instant | null; spec: FeatureEngineSpec; policy: MomentumTriggerPolicy; solRelativeReturn1h: number | null }) => { kind: 'CANDIDATE'; candidate: Candidate } | { kind: 'REJECTED'; candidate: Candidate } | { kind: 'SKIP'; reason: string };

export interface ReplayStrategyResult {
  strategyVersionId: VersionId;
  variant: ReplayVariant;
  decisions: number;
  fills: number;
  rejections: Record<string, number>;
  closedTrades: number;
  finalEquity: string;
  realizedPnlBaseUnits: string;
}

export type ReplayTrade = ClosedTrade & { variant: ReplayVariant; sample: 'IN_SAMPLE' | 'HOLD_OUT' };

export interface ReplayOutput {
  run: ReplayRun;
  decisions: ReplayDecision[];
  trades: ReplayTrade[];
  perStrategy: ReplayStrategyResult[];
  candidates: number;
  ticks: number;
  dataset: DatasetFidelityReport;
  /** The latency the LATENCY_MATCHED variant decided at, so the latency report can say whether the difference is measurable. */
  latencyMatchedMs: number | null;
}

export interface ReplayClockDeps {
  clock: Clock;
  fill: PaperFillPolicy;
}
