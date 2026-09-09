import { randomUUID } from 'node:crypto';
import { DEFAULT_AUTOMATION_SET, DEFAULT_DISCRETIONARY_CYCLE_POLICY, DEFAULT_SPEND_LIMITS, MODEL_POLICY_V1, type SpendBudget, DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY, DEFAULT_ELIGIBILITY_POLICY, DEFAULT_FRESHNESS_REQUIREMENTS, DEFAULT_MOMENTUM_TRIGGER_POLICY, DEFAULT_PAPER_FILL_POLICY, DEFAULT_REPLAY_COST_MODEL, DEFAULT_COHORT_TAXONOMY, DEFAULT_CORRELATION_CLUSTER_POLICY, REFERENCE_SERIES_MINTS, WSOL_MINT, DEFAULT_RECONCILIATION_POLICY, DEFAULT_RISK_POLICY, DEFAULT_S0_SAFETY_GATE_POLICY, DEFAULT_SAFETY_POLICY, DEFAULT_SELF_INFLUENCE_POLICY, DEFAULT_SESSION_POLICY, DEFAULT_MARKET_REGIME_POLICY, FEATURE_ENGINE_V2, mulDiv, getContractSetDigest, parseWorkerEnv, systemClock, type CandleResolution, type MintAddress, type SolanaCluster, type Uuid } from '@sol-agent-trader/contracts';
import {
  applyExit,
  claimQueuedReplayRun,
  completeReplayRun,
  failReplayRun,
  insertReplayDecisions,
  insertReplayRun,
  insertReplayTrades,
  coldStartFacts,
  createIntent,
  createRuntimeSession,
  createSql,
  ensurePaperAccount,
  ensureSleeve,
  ensureStrategyVersion,
  entryHealth,
  findOpenSession,
  finishAttempt,
  highSince,
  insertPortfolioSnapshot,
  insertQuoteProbes,
  journalAttempt,
  latestFeatureValueByMint,
  listCyclesAwaitingEntry,
  listOpenPositionsForAccount,
  listRecentOwnFills,
  loadFeedHealth,
  listPendingControlRequests,
  loadSession,
  openPosition,
  paperBook,
  persistRuntimeTransition,
  recordExitDecision,
  recordRiskEvaluation,
  resolveControlRequest,
  saveColdStartGates,
  sessionEntryGate,
  setIntentState,
  stepUpVerifiedFor,
  loadPendingControlRequest,
  loadStepUpChallenge,
  loadPasskeyByCredentialId,
  activePasskeyCount,
  consumeStepUpChallenge,
  recordPasskeyUse,
  insertPasskey,
  revokePasskey,
  assetIdByMint,
  assetExists,
  addWatch,
  removeWatch,
  requestResearchRefresh,
  insertFundingEvent,
  fundingEventBySignature,
  confirmFundingEvent,
  tightenStop,
  updateMark,
  windDownFacts,
  listCandidatesAwaitingStrategy,
  persistS0Decisions,
  persistS0Expiry,
  loadStrategyVersion,
  heldBucketTimes,
  insertEmergencyRouteSnapshot,
  insertSnapshot,
  latestEligibilityBaseline,
  latestEmergencySnapshot,
  LeaseManager,
  ledgerExpectations,
  chargeProviderSpend,
  expireCandidates,
  ingestWalletEvents,
  insertCandidate,
  insertFeatureSnapshot,
  lastTerminalCandidateAt,
  listOpenCandidates,
  listScanInputs,
  latestEligibility,
  latestMarketSnapshotId,
  listAssetsForFeatures,
  installTaxonomy,
  insertClusterSet,
  latestClusterSet,
  listActiveMemberships,
  listAssetsWithCandles,
  listTrackedWallets,
  loadProviderSpend,
  walletCursor,
  lifecycleForSignature,
  listAssetsForEvaluation,
  listCustodyAccounts,
  listOpenPositions,
  listOwnedAddresses,
  listTrackedAssets,
  listTradingAccounts,
  loadCandles,
  previousSafetyBaseline,
  reconciliationCursor,
  recordEligibility,
  recordPositionSafety,
  recordReconciliation,
  registerOwnedAddress,
  runWithLease,
  upsertDiscoveredAssets,
  upsertFeedHealth,
  writeCandles,
  applyReleaseStatus,
  insertAttestation,
  insertCapitalAttestation,
  latestCapitalAttestation,
  loadLatestAttestation,
  loadRelease,
  loadReleaseForStrategy,
  stepUpEvidenceFor,
  insertApproval,
  listAuthorizedIntentsAwaitingExecution,
  listLiveAccounts,
  loadApprovalGrant,
  loadAuthorizationForIntent,
  ensureRelease,
  heldAssetEligibility,
  insertProjection,
  latestReconciliation,
  listOpenLotSummaries,
  listSleeves,
  nextProjectionSequence,
  listEventsVisibleAt,
  listRecentCandidateSignals,
  onchainFlowAt,
  listAssetEntities,
  listEventsForClustering,
  upsertEvent,
  PgmqClient,
  loadActionCycle,
  loadProposal,
  automationHistory,
  chargeSpendUsage,
  ensureSkillVersion,
  ensureGuidelineVersion,
  ensureSpendBudget,
  installAutomationSet,
  listActiveSpendBudgets,
  listCandidateTargets,
  listPositionTargets,
  listSpendUsageAt,
  persistDiscretionaryOutcome,
  recordAutomationRun,
  spendWindow,
  type Sql,
  insertChainHealth,
  lastHeadAdvance,
  auditHead,
  checkpointAuditChain,
  shadowPositions,
  activeEntryPauses,
  clearEntryPauses,
  windDownLots,
  watchdogLastRunAt,
  setOfflineResumeDeadline,
  acknowledgeNotification,
  listOpenNotifications,
  raiseNotification,
  lastImportedJournalSequence,
  importJournalEntry,
  importedEmergencyCorrelationIds,
  insertEntryPauseOnce,
  resolveNotifications,
  deliveriesFor,
  recordDelivery,
  escalateNotification,
  applyDeadManPause,
  lastHeartbeatAt,
  blockingFeeds,
  activeSessionCount,
  insertReadinessRow,
  latestReadinessRows,
  insertReadinessVerdict,
  latestReadinessVerdict,
  latestPresence,
  latestChainHealth,
  loadLatestProjection,
  FileCheckpointReplicator,
  verifyAgainstExternalCheckpoint,
  recordAuditVerification,
  recoveryFacts,
  expireStaleIntents,
  settleIntentsFromAttempts,
  failOrphanedExecuting,
  sleeveConflicts,
} from '@sol-agent-trader/db/server';
import { JupiterSwapClient, NoRouteError, PaperExecutionAdapter } from '@sol-agent-trader/execution';
import { LLM_STRATEGY_SPECS, llmStrategyVersion, llmStrategyVersions, s0StrategyVersion, s0TinyLiveVersion } from '@sol-agent-trader/strategies';
import { armingPreconditions } from '@sol-agent-trader/risk';
import type { CapitalAuthority, Instant } from '@sol-agent-trader/contracts';
import { DEFAULT_CHAIN_HEALTH_POLICY } from '@sol-agent-trader/contracts';
import type { PreviousHead } from '@sol-agent-trader/execution';
import { runChainHealthCycle, type ChainHealthDeps, type ChainViewSampler } from './roles/chain-health.js';
import { runManualActionsCycle, type ManualActionsDeps } from './roles/manual-actions.js';
import { ensureStepUpJudged, runOperatorSecurityCycle, type OperatorSecurityDeps } from './roles/operator-security.js';
import { runWatchlistCycle, type WatchlistDeps } from './roles/watchlist.js';
import { runFundingCycle, type FundingDeps } from './roles/funding.js';
import { runReplayExecutionCycle, runReplayRequestsCycle, type ReplayRoleDeps } from './roles/replay.js';
import { loadReplayDataset } from './replay/dataset.js';
import { guardedContextSources } from './agents/guarded-sources.js';
import { alertDeliveryDrill, dbDownCloseDrill, persistBeforeSubmitDrill } from './drills/drills.js';
import { liveGuardContext } from '@sol-agent-trader/replay';
import { runStartupRecovery } from './roles/recovery.js';
import { runAuditCheckpointCycle, type AuditCheckpointDeps } from './roles/audit-checkpoint.js';
import { runReadinessCycle, type ReadinessDeps } from './roles/readiness.js';
import { runNotificationsCycle, type NotificationsDeps } from './roles/notifications.js';
import { runShadowSyncCycle, type ShadowSyncDeps, type ShadowSyncState } from './roles/shadow-sync.js';
import { runJournalImportCycle, type JournalImportDeps } from './roles/journal-import.js';
import { runEmergencyDryRunCycle, type EmergencyDryRunDeps } from './roles/emergency-dry-run.js';
import { isOnCurve, SimulationRpcClient } from '@sol-agent-trader/execution';
import { base58Decode } from '@sol-agent-trader/solana-hard-state';
import { DEFAULT_EMERGENCY_ROUTE_POLICY } from '@sol-agent-trader/contracts';
import { dryRunTargets, latestEmergencySnapshots } from '@sol-agent-trader/db/server';
import { FileShadowJournal } from './shadow/journal.js';
import { impliedPrice } from '@sol-agent-trader/execution';
import { inAppSender, telegramSender, unconfiguredSender, type NotificationSender } from './notifications/channels.js';
import { DEFAULT_NOTIFICATION_POLICY, DEFAULT_WATCHDOG_POLICY } from '@sol-agent-trader/contracts';
import { verdictPermits } from '@sol-agent-trader/risk';
import { DEFAULT_READINESS_POLICY, DEFAULT_WALLET_RESERVE_POLICY, type ReadinessBinding } from '@sol-agent-trader/contracts';
import type { Sha256Hex, StrategyVersion, VersionId } from '@sol-agent-trader/contracts';
import { executeExit } from './roles/position-monitor.js';
import { createReasoningModel } from '@sol-agent-trader/agents';
import { GUIDELINES_V1, tradingSkillVersion } from '@sol-agent-trader/skills';
import { createRepoContextSources } from './agents/sources.js';
import { primeContractDigest, runAgentsCycle, type AgentsDeps } from './roles/agents.js';
import { executeClearedExit, type PositionMonitorDeps } from './roles/position-monitor.js';
import { runTradingActionsCycle } from './roles/trading-actions.js';
import { runIntelIngestCycle } from './roles/intel-ingest.js';
import { runStateProjectorCycle } from './roles/state-projector.js';
import { runLiveEntryCycle } from './roles/live-entry.js';
import { runApprovalsCycle } from './roles/approvals.js';
import { AuthorizerClient, ExecutorClient } from '@sol-agent-trader/execution';
import { releaseFor } from '@sol-agent-trader/strategies';
import { importSigningKeyPair, importVerificationKey, DEFAULT_FRESHNESS_REQUIREMENTS as PROJECTION_FRESHNESS } from '@sol-agent-trader/contracts';
import { CryptoPanicClient, LunarCrushClient } from '@sol-agent-trader/intelligence';
import { DEFAULT_CATALYST_TRIGGER_POLICY, DEFAULT_HYBRID_TRIGGER_POLICY, DEFAULT_NORMALIZATION_POLICY, DEFAULT_SMART_MONEY_TRIGGER_POLICY } from '@sol-agent-trader/contracts';
import { BIRDEYE_TIERS, BirdeyeClient, ComputeUnitLedger, defaultFreshnessContracts, fetchTransport, JupiterPriceClient } from '@sol-agent-trader/market';
import { redact, type Logger } from '@sol-agent-trader/observability';
import { HeliusClient } from '@sol-agent-trader/onchain';
import { initTelemetry } from '@sol-agent-trader/observability/server';
import { SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import { restoredEligibilityHealthState, runEligibilityCycle } from './roles/eligibility.js';
import { runHeldAssetSafetyCycle } from './roles/held-asset-safety.js';
import { runReconciliationCycle } from './roles/reconciliation.js';
import { runTrackedWalletsCycle } from './roles/tracked-wallets.js';
import { runFeaturesCycle } from './roles/features.js';
import { installCohortTaxonomy, runCohortsCycle } from './roles/cohorts.js';
import { runCandidatesCycle } from './roles/candidates.js';
import { runS0Cycle } from './roles/s0.js';
import { runPaperEntryCycle } from './roles/paper-entry.js';
import { runPositionMonitorCycle } from './roles/position-monitor.js';
import { runSessionCycle } from './roles/session.js';
import { newEntriesAllowed } from '@sol-agent-trader/risk';
import { initialIngestState, runMarketIngestCycle, type MarketRepo } from './roles/market-ingest.js';

/**
 * worker entrypoint.
 *
 * Multi-role runtime: ingestion, signals, agents, trading orchestration and reconciliation over
 * durable pgmq queues drained in risk-first order (§5.4). Holds no signer credential and no
 * risk-authorization private key: the environment is validated by the fail-closed worker schema
 * before anything else runs (§26.1, GUARDRAILS Part 4). Reports its contract-set digest at
 * startup (D50). `--print-digest` prints the digest and exits without touching the environment.
 *
 * Roles (WORKER_ROLES, each under its own ops.worker_leases lease so two workers never do the
 * same job twice):
 *   market-ingest  discovery, candles, snapshots, feed health (needs BIRDEYE_API_KEY)
 *   eligibility    chain-truth reads + analytics corroboration → §6.2 records (needs SOLANA_RPC_URL and BIRDEYE_API_KEY)
 *   held-asset-safety  open positions: chain truth, sell probe, emergency-pool re-verification → §7.5 safety state (same needs)
 *   reconciliation  chain/custody truth per trading account, movements via Helius, unknown-movement pause (D9; needs SOLANA_RPC_URL; HELIUS_API_KEY to explain movements)
 *   tracked-wallets  Helius parsed history for intelligence.wallets → append-only wallet events, owned wallets skipped (§6.7, D26; needs HELIUS_API_KEY)
 *   features        versioned point-in-time feature vectors per eligible/evaluating asset from closed 1m candles (§6.8, D63 warm-up)
 *   candidates      deterministic momentum trigger over the latest vectors under the entry gate and the self-influence guard; dedupe, cooldown, expiry (§9.1, §9.7)
 * All roles share one Birdeye client so the purchased compute-unit allowance is one budget.
 */
const SERVICE = 'worker' as const;
type WorkerEnv = ReturnType<typeof parseWorkerEnv>;

function issuesOf(err: unknown): unknown {
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues.map((i: { path?: unknown[]; message?: string }) => ({ path: (i.path ?? []).join('.'), message: i.message })) : String(err);
}

const LOOKBACK_BUCKETS: Readonly<Record<CandleResolution, number>> = { '15s': 240, '1m': 300, '5m': 288, '15m': 192, '1h': 168, '4h': 180 };

async function main(): Promise<void> {
  const digest = await getContractSetDigest();
  if (process.argv.includes('--print-digest')) {
    console.log(JSON.stringify({ service: SERVICE, event: 'contract_digest', contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount }));
    return;
  }

  let env: WorkerEnv;
  try {
    env = parseWorkerEnv(process.env);
  } catch (err) {
    console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'env_invalid', issues: redact(issuesOf(err)) }));
    process.exit(1);
  }

  const telemetry = initTelemetry({ service: SERVICE, deploymentProfile: env.DEPLOYMENT_PROFILE, sentryDsn: env.SENTRY_DSN_WORKER, instanceId: env.SERVICE_INSTANCE_ID });
  const logger = telemetry.logger;
  logger.info('startup', { contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount, cluster: env.SOLANA_CLUSTER, roles: env.WORKER_ROLES });

  const roles = new Set(env.WORKER_ROLES.split(',').map((r) => r.trim()).filter(Boolean));
  const wanted = [...roles].filter((r) => r === 'market-ingest' || r === 'eligibility' || r === 'held-asset-safety' || r === 'reconciliation' || r === 'tracked-wallets' || r === 'features' || r === 'candidates' || r === 's0' || r === 'paper-entry' || r === 'position-monitor' || r === 'session' || r === 'cohorts' || r === 'agents' || r === 'trading-actions' || r === 'intel-ingest' || r === 'state-projector' || r === 'chain-health' || r === 'manual-actions' || r === 'audit-checkpoint' || r === 'readiness' || r === 'notifications' || r === 'shadow-sync' || r === 'journal-import' || r === 'emergency-dry-run' || r === 'live-entry' || r === 'approvals' || r === 'operator-security' || r === 'watchlist' || r === 'funding' || r === 'replay');
  if (wanted.length > 0) await runRoles(env, logger, new Set(wanted));
  await telemetry.shutdown();
}

interface Shared {
  sql: Sql;
  /** Null without BIRDEYE_API_KEY: market roles are disabled, chain roles keep running (review R4-12). */
  birdeye: BirdeyeClient | null;
  /** One Jupiter quote client per process (ADR-0003; review R4-17): one rate bucket for every role. */
  jupiter: JupiterSwapClient;
  /** One read-only RPC client per process at `confirmed` for operational reads, plus one at `finalized` for reconciliation (review R4-13). */
  rpc: SolanaRpcClient | null;
  rpcFinalized: SolanaRpcClient | null;
  leases: LeaseManager;
  holder: string;
  stopping: () => boolean;
}

const MARKET_ROLES = new Set(['market-ingest', 'eligibility', 'held-asset-safety']);

async function runRoles(env: WorkerEnv, logger: Logger, roles: Set<string>): Promise<void> {
  const tier = BIRDEYE_TIERS[env.BIRDEYE_TIER];
  const holder = env.SERVICE_INSTANCE_ID ?? `worker-${process.pid}`;
  const sql = createSql({ url: env.SUPABASE_DB_URL, applicationName: 'worker' });
  // §20.12: the Trading Skill and its guideline text are ledger facts even while the agents role is
  // off (no model keys), so the Skill Console can render and diff them from the database.
  if (env.GIT_SHA) {
    try {
      const skill = tradingSkillVersion(env.GIT_SHA, systemClock.now());
      const skillOutcome = await ensureSkillVersion(sql, skill);
      const guidelineOutcome = await ensureGuidelineVersion(sql, { versionId: GUIDELINES_V1.version, skillId: skill.skillId, rules: GUIDELINES_V1.rules });
      logger.info('autonomy_versions_registered', { skill: skill.versionId, skillOutcome, guidelines: GUIDELINES_V1.version, guidelineOutcome });
    } catch (err) {
      logger.warn('autonomy_versions_not_registered', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  let writes: Promise<void> = Promise.resolve();
  let birdeye: BirdeyeClient | null = null;
  if (!env.BIRDEYE_API_KEY) {
    const disabled = [...roles].filter((r) => MARKET_ROLES.has(r));
    if (disabled.length) logger.warn('roles_disabled', { roles: disabled, reason: 'BIRDEYE_API_KEY not set; market feeds will report FAILED' });
  } else {
  // The purchased Birdeye allowance is metered per calendar month by the provider, so the ledger
  // resumes from the persisted spend instead of resetting on every restart (a restart loop could
  // otherwise burn the whole month). Charges are written through in order; a failed write is
  // logged and the in-memory ledger stays the stricter of the two.
  const ledger = new ComputeUnitLedger(systemClock, tier.computeUnitsPerMonth);
  const month = ComputeUnitLedger.monthKeyFor(systemClock.nowMs());
  const persisted = await loadProviderSpend(sql, 'BIRDEYE', month);
  if (persisted) ledger.restore({ month, used: persisted.usedCu, byEndpoint: persisted.byEndpoint });
  logger.info('birdeye_ledger_restored', { month, used: ledger.snapshot().used, allowance: tier.computeUnitsPerMonth });
  ledger.onCharge((c) => {
    writes = writes
      .then(async () => {
        const total = await chargeProviderSpend(sql, 'BIRDEYE', c.month, c.endpoint, c.cu);
        ledger.sync(c.month, total);
      })
      .catch((err: unknown) => {
        logger.error('birdeye_ledger_persist_failed', { error: err instanceof Error ? err.message : String(err) });
      });
  });
  birdeye = new BirdeyeClient({ apiKey: env.BIRDEYE_API_KEY, tier, transport: fetchTransport, clock: systemClock, ledger });
  }
  const jupiter = new JupiterSwapClient({ clock: systemClock, apiKey: env.JUPITER_API_KEY, requestsPerSecond: env.JUPITER_REQUESTS_PER_SECOND });
  const rpc = env.SOLANA_RPC_URL ? new SolanaRpcClient({ url: env.SOLANA_RPC_URL, allowedOrigins: [new URL(env.SOLANA_RPC_URL).origin], nowMs: () => systemClock.nowMs() }) : null;
  const rpcFinalized = env.SOLANA_RPC_URL ? new SolanaRpcClient({ url: env.SOLANA_RPC_URL, allowedOrigins: [new URL(env.SOLANA_RPC_URL).origin], commitment: 'finalized', nowMs: () => systemClock.nowMs() }) : null;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const shared: Shared = { sql, birdeye, jupiter, rpc, rpcFinalized, leases: new LeaseManager(sql, holder), holder, stopping: () => stopping };

  const loops: Promise<void>[] = [];
  const noRpc = (role: string) => logger.warn('roles_disabled', { roles: [role], reason: 'SOLANA_RPC_URL not set' });
  if (roles.has('market-ingest') && birdeye) loops.push(marketIngestLoop(env, logger, { ...shared, birdeye }, tier));
  if (roles.has('eligibility') && birdeye) {
    if (!rpc || !env.SOLANA_RPC_URL) noRpc('eligibility');
    else loops.push(eligibilityLoop(env, logger, { ...shared, birdeye }, rpc, env.SOLANA_RPC_URL));
  }
  if (roles.has('held-asset-safety') && birdeye) {
    if (!rpc || !env.SOLANA_RPC_URL) noRpc('held-asset-safety');
    else loops.push(heldAssetSafetyLoop(env, logger, { ...shared, birdeye }, rpc, env.SOLANA_RPC_URL));
  }
  if (roles.has('reconciliation')) {
    if (!rpcFinalized || !env.SOLANA_RPC_URL) noRpc('reconciliation');
    else loops.push(reconciliationLoop(env, logger, shared, rpcFinalized, env.SOLANA_RPC_URL));
  }
  if (roles.has('features')) loops.push(featuresLoop(env, logger, shared));
  if (roles.has('candidates')) loops.push(candidatesLoop(env, logger, shared));
  if (roles.has('s0')) loops.push(s0Loop(env, logger, shared));
  // §21.3: before any entry or monitoring loop accepts work, reconcile what the database believes is open against chain truth.
  const tradingRoles = ['paper-entry', 'position-monitor', 'live-entry', 'manual-actions', 'session'];
  if (tradingRoles.some((r) => roles.has(r)) && env.PAPER_TRADING_WALLET) {
    const { account } = await positionMonitorDeps(env, logger, shared, env.PAPER_TRADING_WALLET, env.POSITION_MONITOR_INTERVAL_MS);
    const recovery = await runStartupRecovery({
      repo: {
        facts: (id: Uuid) => recoveryFacts(sql, id),
        expireStaleIntents: (id: Uuid, now: Instant) => expireStaleIntents(sql, id, now),
        settleFromAttempts: (id: Uuid) => settleIntentsFromAttempts(sql, id),
        failOrphanedExecuting: (id: Uuid, now: Instant) => failOrphanedExecuting(sql, id, now),
      },
      reconcile: rpcFinalized
        ? async () => {
            const r = await runReconciliationCycle(reconciliationDeps(env, logger, shared, rpcFinalized));
            return { accounts: r.accounts, clean: r.clean, mismatch: r.mismatch, unavailable: r.unavailable, paused: r.paused };
          }
        : null,
      account: { id: account.id },
      clock: systemClock,
      logger,
    });
    if (!recovery.resume) {
      // Chain, market and session roles keep running; nothing that could open or manage exposure starts until a restart reconciles.
      for (const r of ['paper-entry', 'position-monitor', 'live-entry', 'manual-actions']) roles.delete(r);
      logger.error('recovery_blocks_trading_roles', { disabled: ['paper-entry', 'position-monitor', 'live-entry', 'manual-actions'], reconciliation: recovery.reconciliation, after: recovery.after });
    }
  }
  if (roles.has('paper-entry')) loops.push(paperEntryLoop(env, logger, shared));
  if (roles.has('cohorts')) loops.push(cohortsLoop(env, logger, shared));
  if (roles.has('position-monitor')) loops.push(positionMonitorLoop(env, logger, shared));
  if (roles.has('session')) loops.push(sessionLoop(env, logger, shared));
  if (roles.has('agents')) loops.push(agentsLoop(env, logger, shared));
  if (roles.has('trading-actions')) loops.push(tradingActionsLoop(env, logger, shared));
  if (roles.has('intel-ingest')) loops.push(intelIngestLoop(env, logger, shared));
  if (roles.has('state-projector')) loops.push(stateProjectorLoop(env, logger, shared));
  if (roles.has('chain-health')) {
    if (!env.SOLANA_RPC_URL) noRpc('chain-health');
    else loops.push(chainHealthLoop(env, logger, shared, env.SOLANA_RPC_URL));
  }
  if (roles.has('live-entry')) loops.push(liveEntryLoop(env, logger, shared));
  if (roles.has('approvals')) loops.push(approvalsLoop(env, logger, shared));
  if (roles.has('manual-actions')) loops.push(manualActionsLoop(env, logger, shared));
  if (roles.has('operator-security')) loops.push(operatorSecurityLoop(env, logger, shared));
  if (roles.has('watchlist')) loops.push(watchlistLoop(env, logger, shared));
  if (roles.has('funding')) loops.push(fundingLoop(env, logger, shared));
  if (roles.has('replay')) loops.push(replayLoop(env, logger, shared));
  if (roles.has('readiness')) loops.push(readinessLoop(env, logger, shared));
  if (roles.has('notifications')) loops.push(notificationsLoop(env, logger, shared));
  if (roles.has('shadow-sync')) loops.push(shadowSyncLoop(env, logger, shared));
  if (roles.has('journal-import')) loops.push(journalImportLoop(env, logger, shared));
  if (roles.has('emergency-dry-run')) {
    if (!env.SOLANA_RPC_URL) noRpc('emergency-dry-run');
    else if (!rpc) noRpc('emergency-dry-run');
    else loops.push(emergencyDryRunLoop(env, logger, shared, rpc, env.SOLANA_RPC_URL));
  }
  if (roles.has('audit-checkpoint')) {
    if (!env.AUDIT_CHECKPOINT_PATH) logger.warn('roles_disabled', { roles: ['audit-checkpoint'], reason: 'AUDIT_CHECKPOINT_PATH not set' });
    else loops.push(auditCheckpointLoop(env, logger, shared, env.AUDIT_CHECKPOINT_PATH));
  }
  if (roles.has('tracked-wallets')) {
    if (!env.HELIUS_API_KEY) logger.warn('roles_disabled', { roles: ['tracked-wallets'], reason: 'HELIUS_API_KEY not set' });
    else loops.push(trackedWalletsLoop(env, logger, shared, env.HELIUS_API_KEY));
  }
  await Promise.all(loops);
  await writes;
  await sql.end({ timeout: 5 });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LEASE_RETRY_MIN_MS = 15_000;
const LEASE_RETRY_MAX_MS = 120_000;

/**
 * Runs `cycle` every `intervalMs` under the named lease until stop. A fenced lease (a failed
 * heartbeat, typically a network fault) stops the role immediately, as the lease contract requires,
 * and the role then tries to re-acquire with bounded backoff instead of leaving the process to drain:
 * an attended paper run must survive a transient outage without an operator restart.
 */
async function loopUnderLease(role: string, intervalMs: number, logger: Logger, shared: Shared, cycle: () => Promise<void>): Promise<void> {
  const tag = role.replace('-', '_');
  let backoffMs = LEASE_RETRY_MIN_MS;
  while (!shared.stopping()) {
    let ran = false;
    let wasFenced = false;
    try {
      ran = await runWithLease(shared.leases, { role, ttlSeconds: 90, heartbeatIntervalMs: 30_000 }, async (isFenced) => {
        backoffMs = LEASE_RETRY_MIN_MS;
        while (!shared.stopping() && !isFenced()) {
          const started = systemClock.nowMs();
          try {
            await cycle();
          } catch (err) {
            logger.error(`${tag}_cycle_failed`, { error: err instanceof Error ? err.message : String(err) });
          }
          const deadline = started + intervalMs;
          while (!shared.stopping() && !isFenced() && systemClock.nowMs() < deadline) await sleep(Math.min(5_000, deadline - systemClock.nowMs()));
        }
        wasFenced = isFenced();
        logger.info(`${tag}_stopped`, { stopping: shared.stopping(), fenced: wasFenced });
      });
    } catch (err) {
      // acquire/release failed (database unreachable): treat like a fenced lease and retry
      wasFenced = true;
      logger.error(`${tag}_lease_failed`, { error: err instanceof Error ? err.message : String(err) });
    }
    if (shared.stopping()) return;
    if (!ran) logger.warn(`${tag}_lease_unavailable`, { holder: shared.holder, retryInMs: backoffMs });
    else if (wasFenced) logger.warn(`${tag}_lease_retry`, { holder: shared.holder, retryInMs: backoffMs });
    else return;
    const until = systemClock.nowMs() + backoffMs;
    while (!shared.stopping() && systemClock.nowMs() < until) await sleep(Math.min(5_000, until - systemClock.nowMs()));
    backoffMs = Math.min(LEASE_RETRY_MAX_MS, backoffMs * 2);
  }
}

type SharedWithBirdeye = Shared & { birdeye: BirdeyeClient };

async function marketIngestLoop(env: WorkerEnv, logger: Logger, shared: SharedWithBirdeye, tier: (typeof BIRDEYE_TIERS)[keyof typeof BIRDEYE_TIERS]): Promise<void> {
  const intervalMs = env.MARKET_INGEST_INTERVAL_MS;
  const cyclesPerMonth = (30 * 86_400_000) / intervalMs;
  // Smoothing only: the client's compute-unit ledger is the hard monthly cap.
  const cuBudgetPerCycle = Math.max(100, Math.floor(((tier.computeUnitsPerMonth ?? 0) * 0.9) / cyclesPerMonth));
  const requestBudgetPerCycle = Math.max(3, Math.floor(tier.requestsPerSecond * (intervalMs / 1000) * 0.5));
  const { sql } = shared;
  const jupiter = new JupiterPriceClient({ transport: fetchTransport, clock: systemClock, apiKey: env.JUPITER_API_KEY, requestsPerSecond: env.JUPITER_REQUESTS_PER_SECOND });
  const repo: MarketRepo = {
    listTrackedAssets: (limit) => listTrackedAssets(sql, limit, REFERENCE_SERIES_MINTS),
    heldBucketTimes: (assetId, resolution, from, to) => heldBucketTimes(sql, assetId, resolution, from, to),
    writeCandles: (candles) => writeCandles(sql, candles),
    loadCandles: (assetId, resolution, from, to) => loadCandles(sql, assetId, resolution, from, to),
    upsertDiscoveredAssets: (tokens, now) => upsertDiscoveredAssets(sql, tokens, now),
    insertSnapshot: (snapshot) => insertSnapshot(sql, snapshot),
    upsertFeedHealth: (health) => upsertFeedHealth(sql, health),
  };
  const deps = {
    birdeye: shared.birdeye,
    jupiter,
    repo,
    clock: systemClock,
    logger,
    // ADR-0011: requirements come from the strategy speed tier (T1_STANDARD until a Release binds one), never from the provider tier.
    contracts: defaultFreshnessContracts(DEFAULT_FRESHNESS_REQUIREMENTS),
    config: { trackedLimit: tier.requestsPerSecond <= 1 ? 10 : 100, lookbackBuckets: LOOKBACK_BUCKETS, discoveryIntervalMs: Math.max(300_000, intervalMs), cuBudgetPerCycle, requestBudgetPerCycle, backoffBaseMs: Math.max(intervalMs, 300_000), backoffMaxMs: 6 * 3_600_000 },
  };
  logger.info('market_ingest_starting', { tier: tier.tier, intervalMs, cuBudgetPerCycle, requestBudgetPerCycle, trackedLimit: deps.config.trackedLimit, holder: shared.holder });
  const state = initialIngestState();
  await loopUnderLease('market-ingest', intervalMs, logger, shared, async () => {
    await runMarketIngestCycle(deps, state);
  });
}

async function eligibilityLoop(env: WorkerEnv, logger: Logger, shared: SharedWithBirdeye, rpc: SolanaRpcClient, rpcUrl: string): Promise<void> {
  const intervalMs = env.ELIGIBILITY_INTERVAL_MS;
  // The one shared Jupiter quote client (ADR-0003): keyless lite host at 1 rps, keyed host faster.
  const { sql, jupiter } = shared;
  const deps = {
    rpc,
    birdeye: shared.birdeye,
    jupiter,
    repo: {
      listAssetsForEvaluation: (opts: { limit: number; reevaluateAfter: ReturnType<typeof systemClock.now>; blockedReevaluateAfter: ReturnType<typeof systemClock.now> }) => listAssetsForEvaluation(sql, opts),
      recordEligibility: (record: Parameters<typeof recordEligibility>[1], status: Parameters<typeof recordEligibility>[2]) => recordEligibility(sql, record, status),
      insertEmergencyRouteSnapshot: (snapshot: Parameters<typeof insertEmergencyRouteSnapshot>[1]) => insertEmergencyRouteSnapshot(sql, snapshot),
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_ELIGIBILITY_POLICY,
    cluster: env.SOLANA_CLUSTER,
    // Each evaluation costs 40 Birdeye CU (security 25 + overview 15) and about a dozen Jupiter quotes;
    // the ledger stops the batch when the Birdeye allowance is gone.
    config: { batchSize: 5, reevaluateAfterMs: env.ELIGIBILITY_REEVALUATE_AFTER_MS, blockedReevaluateAfterMs: env.ELIGIBILITY_BLOCKED_REEVALUATE_AFTER_MS },
    health: {
      contracts: defaultFreshnessContracts(DEFAULT_FRESHNESS_REQUIREMENTS).filter((c) => c.dataClass === 'TOKEN_SECURITY' || c.dataClass === 'TOKEN_OVERVIEW'),
      state: restoredEligibilityHealthState(await loadFeedHealth(sql, ['BIRDEYE:TOKEN_SECURITY', 'BIRDEYE:TOKEN_OVERVIEW'])),
      upsert: (h: Parameters<typeof upsertFeedHealth>[1]) => upsertFeedHealth(sql, h),
    },
  };
  logger.info('eligibility_starting', { intervalMs, batchSize: deps.config.batchSize, policyVersion: DEFAULT_ELIGIBILITY_POLICY.version, rpcOrigin: new URL(rpcUrl).origin, jupiterHost: env.JUPITER_API_KEY ? 'api.jup.ag' : 'lite-api.jup.ag', holder: shared.holder });
  await loopUnderLease('eligibility', intervalMs, logger, shared, async () => {
    await runEligibilityCycle(deps);
  });
}

async function heldAssetSafetyLoop(env: WorkerEnv, logger: Logger, shared: SharedWithBirdeye, rpc: SolanaRpcClient, rpcUrl: string): Promise<void> {
  const intervalMs = env.HELD_ASSET_SAFETY_INTERVAL_MS;
  const { sql, jupiter } = shared;
  const deps = {
    rpc,
    birdeye: shared.birdeye,
    jupiter,
    repo: {
      listOpenPositions: (limit: number) => listOpenPositions(sql, limit),
      previousSafetyBaseline: (positionId: Parameters<typeof previousSafetyBaseline>[1]) => previousSafetyBaseline(sql, positionId),
      latestEligibilityBaseline: (assetId: Parameters<typeof latestEligibilityBaseline>[1]) => latestEligibilityBaseline(sql, assetId),
      latestEmergencySnapshot: (assetId: Parameters<typeof latestEmergencySnapshot>[1]) => latestEmergencySnapshot(sql, assetId),
      recordPositionSafety: (evaluation: Parameters<typeof recordPositionSafety>[1]) => recordPositionSafety(sql, evaluation),
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_SAFETY_POLICY,
    cluster: env.SOLANA_CLUSTER,
    settlementMint: DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress,
    // Each position costs 40 Birdeye CU and one Jupiter quote per cycle; held assets are CRITICAL priority
    // in the ledger so entry-side discovery runs out of allowance before safety does.
    config: { batchSize: 50 },
  };
  logger.info('held_asset_safety_starting', { intervalMs, batchSize: deps.config.batchSize, policyVersion: DEFAULT_SAFETY_POLICY.version, rpcOrigin: new URL(rpcUrl).origin, holder: shared.holder });
  await loopUnderLease('held-asset-safety', intervalMs, logger, shared, async () => {
    await runHeldAssetSafetyCycle(deps);
  });
}

async function reconciliationLoop(env: WorkerEnv, logger: Logger, shared: Shared, rpc: SolanaRpcClient, rpcUrl: string): Promise<void> {
  const intervalMs = env.RECONCILIATION_INTERVAL_MS;
  const deps = reconciliationDeps(env, logger, shared, rpc);
  logger.info('reconciliation_starting', { intervalMs, policyVersion: DEFAULT_RECONCILIATION_POLICY.version, rpcOrigin: new URL(rpcUrl).origin, helius: deps.helius !== null, holder: shared.holder });
  await loopUnderLease('reconciliation', intervalMs, logger, shared, async () => {
    await runReconciliationCycle(deps);
  });
}

async function trackedWalletsLoop(env: WorkerEnv, logger: Logger, shared: Shared, heliusKey: string): Promise<void> {
  const intervalMs = env.TRACKED_WALLETS_INTERVAL_MS;
  const helius = new HeliusClient({ apiKey: heliusKey, clock: systemClock });
  const { sql } = shared;
  const deps = {
    helius,
    repo: {
      listTrackedWallets: () => listTrackedWallets(sql),
      listOwnedAddresses: () => listOwnedAddresses(sql),
      walletCursor: (wallet: Parameters<typeof walletCursor>[1]) => walletCursor(sql, wallet),
      ingestWalletEvents: (wallet: Parameters<typeof ingestWalletEvents>[1], events: Parameters<typeof ingestWalletEvents>[2], cursor: Parameters<typeof ingestWalletEvents>[3]) => ingestWalletEvents(sql, wallet, events, cursor),
    },
    clock: systemClock,
    logger,
    config: { pageSize: 100, maxPagesPerWallet: 3 },
  };
  logger.info('tracked_wallets_starting', { intervalMs, pageSize: deps.config.pageSize, holder: shared.holder });
  await loopUnderLease('tracked-wallets', intervalMs, logger, shared, async () => {
    await runTrackedWalletsCycle(deps);
  });
}

async function featuresLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.FEATURES_INTERVAL_MS;
  const { sql } = shared;
  const deps = {
    repo: {
      listAssetsForFeatures: (limit: number) => listAssetsForFeatures(sql, limit, REFERENCE_SERIES_MINTS),
      loadCandles: (assetId: Parameters<typeof loadCandles>[1], resolution: '1m', from: Parameters<typeof loadCandles>[3], to: Parameters<typeof loadCandles>[4]) => loadCandles(sql, assetId, resolution, from, to),
      latestEligibility: (assetId: Parameters<typeof latestEligibility>[1]) => latestEligibility(sql, assetId),
      latestMarketSnapshotId: (assetId: Parameters<typeof latestMarketSnapshotId>[1], asOf: Parameters<typeof latestMarketSnapshotId>[2]) => latestMarketSnapshotId(sql, assetId, asOf),
      insertFeatureSnapshot: (snapshot: Parameters<typeof insertFeatureSnapshot>[1]) => insertFeatureSnapshot(sql, snapshot),
      listActiveMemberships: async () => (await listActiveMemberships(sql, DEFAULT_COHORT_TAXONOMY.version)).map((m) => ({ assetId: m.assetId, cohortName: m.cohortName })),
      solReferenceReturn1h: (asOf: Parameters<typeof latestFeatureValueByMint>[4]) => latestFeatureValueByMint(sql, WSOL_MINT, 'ret_1h', 10 * 60_000, asOf),
      recentOwnFills: (assetId: Parameters<typeof listRecentOwnFills>[1], since: Parameters<typeof listRecentOwnFills>[2]) => listRecentOwnFills(sql, assetId, since).then((fills) => fills.map((f) => ({ ...f, signature: f.signature as never, estimatedImpactBps: f.estimatedImpactBps as never }))),
    },
    clock: systemClock,
    logger,
    spec: FEATURE_ENGINE_V2,
    regimePolicy: DEFAULT_MARKET_REGIME_POLICY,
    selfInfluence: DEFAULT_SELF_INFLUENCE_POLICY,
    config: { batchSize: 200 },
  };
  logger.info('features_starting', { intervalMs, engine: FEATURE_ENGINE_V2.version, regime: DEFAULT_MARKET_REGIME_POLICY.version, holder: shared.holder });
  await loopUnderLease('features', intervalMs, logger, shared, async () => {
    await runFeaturesCycle(deps);
  });
}

async function cohortsLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.COHORTS_INTERVAL_MS;
  const { sql } = shared;
  const deps = {
    repo: {
      installTaxonomy: (t: Parameters<typeof installTaxonomy>[1]) => installTaxonomy(sql, t),
      listAssetsWithCandles: (from: Parameters<typeof listAssetsWithCandles>[1], to: Parameters<typeof listAssetsWithCandles>[2], limit: number) => listAssetsWithCandles(sql, from, to, limit),
      loadCandles: (assetId: Parameters<typeof loadCandles>[1], resolution: '1m', from: Parameters<typeof loadCandles>[3], to: Parameters<typeof loadCandles>[4]) => loadCandles(sql, assetId, resolution, from, to),
      insertClusterSet: (set: Parameters<typeof insertClusterSet>[1]) => insertClusterSet(sql, set),
    },
    clock: systemClock,
    logger,
    taxonomy: DEFAULT_COHORT_TAXONOMY,
    clusterPolicy: DEFAULT_CORRELATION_CLUSTER_POLICY,
    config: { maxAssets: 200 },
  };
  logger.info('cohorts_starting', { intervalMs, taxonomy: DEFAULT_COHORT_TAXONOMY.version, clusters: DEFAULT_CORRELATION_CLUSTER_POLICY.version, holder: shared.holder });
  await installCohortTaxonomy(deps);
  await loopUnderLease('cohorts', intervalMs, logger, shared, async () => {
    await runCohortsCycle(deps);
  });
}

async function candidatesLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.CANDIDATES_INTERVAL_MS;
  const { sql } = shared;
  const deps = {
    repo: {
      listScanInputs: (limit: number) => listScanInputs(sql, limit),
      latestEligibility: (assetId: Parameters<typeof latestEligibility>[1]) => latestEligibility(sql, assetId),
      listOpenCandidates: (assetId: Parameters<typeof listOpenCandidates>[1], family: Parameters<typeof listOpenCandidates>[2]) => listOpenCandidates(sql, assetId, family),
      lastTerminalCandidateAt: (assetId: Parameters<typeof lastTerminalCandidateAt>[1], family: Parameters<typeof lastTerminalCandidateAt>[2]) => lastTerminalCandidateAt(sql, assetId, family),
      insertCandidate: (candidate: Parameters<typeof insertCandidate>[1]) => insertCandidate(sql, candidate),
      expireCandidates: (now: Parameters<typeof expireCandidates>[1]) => expireCandidates(sql, now),
      // LIVE fills only: paper fills never reach the chain, so they cannot be self-influence (§8.6, INV-11).
      recentOwnFills: (assetId: Parameters<typeof listRecentOwnFills>[1], since: Parameters<typeof listRecentOwnFills>[2]) => listRecentOwnFills(sql, assetId, since).then((fills) => fills.map((f) => ({ ...f, signature: f.signature as never, estimatedImpactBps: f.estimatedImpactBps as never }))),
      listOwnedAddresses: () => listOwnedAddresses(sql),
      // SOL 1h return from the wrapped-SOL reference series (tracked and featured whatever its eligibility); null = no fresh evidence.
      solReturn1h: (asOf: Parameters<typeof latestFeatureValueByMint>[4]) => latestFeatureValueByMint(sql, WSOL_MINT, 'ret_1h', 10 * 60_000, asOf),
      visibleEvents: async (assetId: Uuid, now: Parameters<typeof listEventsVisibleAt>[2], limit: number) => (await listEventsVisibleAt(sql, assetId, now, limit)).map((e) => ({ id: e.id, kind: e.kind, sourceQuality: e.sourceQuality, sourceTimeConfidence: e.sourceTimeConfidence, sourcePublishedAt: e.sourcePublishedAt, firstSeenAt: e.firstSeenAt, noveltyScore: e.noveltyScore, clusterId: e.clusterId, corroboratesEventId: e.corroboratesEventId })),
      smartMoneyFlow: async (assetId: Uuid, now: Parameters<typeof onchainFlowAt>[3]) => {
        const [a] = await sql<{ mint_address: string }[]>`select mint_address from core.assets where id = ${assetId}`;
        if (!a) return null;
        const flow = await onchainFlowAt(sql, assetId, a.mint_address, now);
        const usd = (v: string) => Number(BigInt(v)) / 1_000_000; // settlement USDC base units
        return { netFlowUsd: { h1: usd(flow.netQuoteFlow.h1), h4: usd(flow.netQuoteFlow.h4), h24: usd(flow.netQuoteFlow.h24) }, distinctBuyers: flow.buyers, distinctSellers: flow.sellers, topBuyerShare: null, ownWalletActivityExcluded: true as const };
      },
      recentFamilySignals: (assetId: Uuid, since: Parameters<typeof listRecentCandidateSignals>[2]) => listRecentCandidateSignals(sql, assetId, since).then((rows) => rows.filter((r) => r.family !== 'MANUAL_WATCH').map((r) => ({ family: r.family as Exclude<typeof r.family, 'MANUAL_WATCH'>, firedAt: r.firedAt, score: r.score }))),
    },
    clock: systemClock,
    logger,
    spec: FEATURE_ENGINE_V2,
    trigger: DEFAULT_MOMENTUM_TRIGGER_POLICY,
    earlyAcceleration: DEFAULT_EARLY_ACCELERATION_TRIGGER_POLICY,
    catalyst: DEFAULT_CATALYST_TRIGGER_POLICY,
    smartMoney: DEFAULT_SMART_MONEY_TRIGGER_POLICY,
    hybrid: DEFAULT_HYBRID_TRIGGER_POLICY,
    eligibility: DEFAULT_ELIGIBILITY_POLICY,
    selfInfluence: DEFAULT_SELF_INFLUENCE_POLICY,
    config: { batchSize: 200 },
  };
  logger.info('candidates_starting', { intervalMs, trigger: DEFAULT_MOMENTUM_TRIGGER_POLICY.version, holder: shared.holder });
  await loopUnderLease('candidates', intervalMs, logger, shared, async () => {
    await runCandidatesCycle(deps);
  });
}

async function s0Loop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.S0_INTERVAL_MS;
  const { sql } = shared;
  const activeFrom = systemClock.now();
  const strategies = { RAW: s0StrategyVersion('RAW', env.GIT_SHA, activeFrom), SAFE: s0StrategyVersion('SAFE', env.GIT_SHA, activeFrom) };
  const digestFor = await releaseDigests([strategies.RAW, strategies.SAFE]);
  for (const v of [strategies.RAW, strategies.SAFE]) {
    const outcome = await ensureStrategyVersion(sql, v);
    logger.info('strategy_version', { versionId: v.versionId, outcome, gitSha: v.gitSha });
  }
  if (env.GIT_SHA === '0000000') logger.warn('git_sha_unknown', { hint: 'set GIT_SHA so registered strategy versions carry the build commit' });
  const deps = {
    repo: {
      listAwaiting: (versionId: Parameters<typeof listCandidatesAwaitingStrategy>[1], now: Parameters<typeof listCandidatesAwaitingStrategy>[2], limit: number, families: Parameters<typeof listCandidatesAwaitingStrategy>[4]) => listCandidatesAwaitingStrategy(sql, versionId, now, limit, families),
      persist: (candidateId: Parameters<typeof persistS0Decisions>[1], decisions: Parameters<typeof persistS0Decisions>[2], status: Parameters<typeof persistS0Decisions>[3], reason: Parameters<typeof persistS0Decisions>[4]) => persistS0Decisions(sql, candidateId, decisions, status, reason, digestFor),
      persistExpired: (candidateId: Parameters<typeof persistS0Expiry>[1], cycles: Parameters<typeof persistS0Expiry>[2]) => persistS0Expiry(sql, candidateId, cycles),
    },
    clock: systemClock,
    logger,
    strategies,
    gatePolicy: DEFAULT_S0_SAFETY_GATE_POLICY,
    config: { batchSize: 100 },
  };
  logger.info('s0_starting', { intervalMs, gate: DEFAULT_S0_SAFETY_GATE_POLICY.version, holder: shared.holder });
  await loopUnderLease('s0', intervalMs, logger, shared, async () => {
    await runS0Cycle(deps);
  });
}

async function paperEntryLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.PAPER_ENTRY_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('paper_entry_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const taker = env.PAPER_TRADING_WALLET;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const startingCapital = env.PAPER_STARTING_CAPITAL_BASE_UNITS;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: taker, settlementMint });
  const activeFrom = systemClock.now();
  // S1 is registered here too so its sleeve exists and a CLEARED S1 ENTER is paper-filled exactly like an S0 decision (§32: the baseline and the LLM strategy share one execution path).
  const versions = [s0StrategyVersion('RAW', env.GIT_SHA, activeFrom), s0StrategyVersion('SAFE', env.GIT_SHA, activeFrom), ...llmStrategyVersions(env.GIT_SHA, activeFrom, { proposer: env.AGENT_PROPOSER_MODEL, adversary: env.AGENT_ADVERSARY_MODEL })];
  const strategies: Record<string, (typeof versions)[number]> = {};
  const sleeves: Record<string, Awaited<ReturnType<typeof ensureSleeve>>> = {};
  for (const v of versions) {
    await ensureStrategyVersion(sql, v);
    strategies[v.versionId] = v;
    sleeves[v.versionId] = await ensureSleeve(sql, {
      id: randomUUID() as Uuid,
      accountId: account.id,
      strategyVersionId: v.versionId,
      versionId: 'sleeve-v1' as (typeof v)['versionId'],
      settlementMint,
      capitalCapBaseUnits: mulDiv(startingCapital, 40n, 100n, 'FLOOR'),
      riskBudgetBaseUnits: mulDiv(startingCapital, 5n, 100n, 'FLOOR'),
      committedBaseUnits: '0' as typeof startingCapital,
      riskUsedBaseUnits: '0' as typeof startingCapital,
      active: true,
      createdAt: activeFrom,
    });
  }
  const adapter = new PaperExecutionAdapter({
    quotes: shared.jupiter,
    clock: systemClock,
    policy: DEFAULT_PAPER_FILL_POLICY,
    taker,
    cluster: env.SOLANA_CLUSTER,
    newId: () => randomUUID() as Uuid,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    journal: ({ order, attempt }) => journalAttempt(sql, order, attempt),
  });
  const deps = {
    repo: {
      listAwaiting: (ids: Parameters<typeof listCyclesAwaitingEntry>[1], limit: number) => listCyclesAwaitingEntry(sql, ids, limit),
      book: (now: Parameters<typeof paperBook>[4]) => paperBook(sql, account.id, settlementMint, startingCapital, now),
      cohorts: async (now: Parameters<typeof latestClusterSet>[1]) => ({ memberships: await listActiveMemberships(sql, DEFAULT_COHORT_TAXONOMY.version), clusterSet: await latestClusterSet(sql, now, 2 * DEFAULT_CORRELATION_CLUSTER_POLICY.windowMs) }),
      health: async () => {
        const h = await entryHealth(sql);
        const gate = await sessionEntryGate(sql, account.id);
        return { ...h, sessionAllowsEntries: gate !== null && newEntriesAllowed({ activity: gate.activity, authority: gate.authority, paused: gate.paused, pausedBy: null, attended: gate.attended, liveCapabilityEnabled: false }) };
      },
      recordRiskEvaluation: (e: Parameters<typeof recordRiskEvaluation>[1]) => recordRiskEvaluation(sql, e),
      createIntent: (i: Parameters<typeof createIntent>[1], lifecycle: 'AUTHORIZED') => createIntent(sql, i, lifecycle),
      setIntentState: (id: Parameters<typeof setIntentState>[1], state: Parameters<typeof setIntentState>[2]) => setIntentState(sql, id, state),
      finishAttempt: (order: Parameters<typeof finishAttempt>[1], attempt: Parameters<typeof finishAttempt>[2], fill: Parameters<typeof finishAttempt>[3]) => finishAttempt(sql, order, attempt, fill),
      openPosition: (p: Parameters<typeof openPosition>[1], lot: Parameters<typeof openPosition>[2]) => openPosition(sql, p, lot),
      writeSnapshot: (s: Parameters<typeof insertPortfolioSnapshot>[1]) => insertPortfolioSnapshot(sql, s),
      captureQuotes: async (probes: Parameters<typeof insertQuoteProbes>[1]) => {
        await insertQuoteProbes(sql, probes);
      },
    },
    adapter,
    referenceQuote: async (inputMint: MintAddress, outputMint: MintAddress, inputAmount: typeof startingCapital, maxSlippageBps: Parameters<typeof shared.jupiter.quote>[0]['maxSlippageBps'], now: Parameters<typeof paperBook>[4]) => {
      try {
        const { quote } = await shared.jupiter.quote({ inputMint, outputMint, inputAmount, maxSlippageBps, taker, cluster: env.SOLANA_CLUSTER, requestedAt: now });
        return { impactBps: quote.priceImpactBps, expectedOutputAmount: quote.expectedOutputAmount, slippageBps: quote.slippageBps, quotedAt: quote.quotedAt, quote };
      } catch (err) {
        if (err instanceof NoRouteError) return null;
        throw err;
      }
    },
    clock: systemClock,
    logger,
    account: { id: account.id, settlementMint, settlementDecimals: 6, startingCapital, virtualSolLamports: '1000000000' as typeof startingCapital },
    strategies,
    sleeves,
    policy: DEFAULT_RISK_POLICY,
    config: { batchSize: 20, featureMaxAgeMs: DEFAULT_S0_SAFETY_GATE_POLICY.maxFeatureAgeMs },
  };
  logger.info('paper_entry_starting', { intervalMs, accountId: account.id, strategies: Object.keys(strategies), fillModel: DEFAULT_PAPER_FILL_POLICY.version, riskPolicy: DEFAULT_RISK_POLICY.version, holder: shared.holder });
  await loopUnderLease('paper-entry', intervalMs, logger, shared, async () => {
    await runPaperEntryCycle(deps);
  });
}

/** `AGENT_MODEL_PRICING`: `<provider>:<model>=<inputUsdPerMTok>,<outputUsdPerMTok>;...` */
function parseModelPricing(spec: string): Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }> {
  const out: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }> = {};
  for (const part of spec.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [model, prices] = part.split('=');
    const [input, output] = (prices ?? '').split(',').map(Number);
    if (model && Number.isFinite(input) && Number.isFinite(output)) out[model] = { inputUsdPerMTok: input as number, outputUsdPerMTok: output as number };
  }
  return out;
}

/** D43: one usage window per limit kind, so an hourly cycle cap and a daily spend cap never share a row. */
function spendWindowUnit(b: SpendBudget): 'HOUR' | 'DAY' | 'MINUTE' {
  if (b.limits.providerRequestsPerMinute !== null) return 'MINUTE';
  if (b.limits.cyclesPerHour !== null) return 'HOUR';
  return 'DAY';
}

async function agentsLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.AGENTS_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('agents_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const keys = { anthropic: env.ANTHROPIC_API_KEY ?? null, openai: env.OPENAI_API_KEY ?? null };
  const pricing = parseModelPricing(env.AGENT_MODEL_PRICING);
  const make = (spec: string, temperature: number) => createReasoningModel(spec, keys, { temperature, maxOutputTokens: MODEL_POLICY_V1.maxOutputTokens, timeoutMs: MODEL_POLICY_V1.callTimeoutMs, pricing: pricing[spec] ?? null });
  const proposer = make(env.AGENT_PROPOSER_MODEL, MODEL_POLICY_V1.proposerTemperature);
  const adversary = make(env.AGENT_ADVERSARY_MODEL, MODEL_POLICY_V1.adversaryTemperature);
  if (!proposer.model || !adversary.model) {
    logger.warn('roles_disabled', { roles: ['agents'], reason: [proposer.model ? null : proposer.reason, adversary.model ? null : adversary.reason].filter(Boolean).join('; ') });
    return;
  }
  if (!pricing[env.AGENT_PROPOSER_MODEL] || !pricing[env.AGENT_ADVERSARY_MODEL]) logger.warn('agent_model_unpriced', { hint: 'set AGENT_MODEL_PRICING so agent runs carry a cost; unpriced models are recorded at zero' });
  const { sql } = shared;
  const taker = env.PAPER_TRADING_WALLET;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: taker, settlementMint });
  const activeFrom = systemClock.now();
  const skill = tradingSkillVersion(env.GIT_SHA, activeFrom);
  logger.info('skill_version', { versionId: skill.versionId, outcome: await ensureSkillVersion(sql, skill), toolManifest: skill.toolManifestVersion, guidelines: skill.guidelineVersion });
  const models = { proposer: env.AGENT_PROPOSER_MODEL, adversary: env.AGENT_ADVERSARY_MODEL };
  const digestFor = await releaseDigests(llmStrategyVersions(env.GIT_SHA, activeFrom, models));
  const providers = [proposer.model.identity().provider, adversary.model.identity().provider].filter((p, i, all) => all.indexOf(p) === i);
  const platformBudgets: SpendBudget[] = [
    { id: randomUUID() as Uuid, versionId: 'budget-model-v1' as SpendBudget['versionId'], scope: 'PLATFORM', scopeId: null, limits: { ...DEFAULT_SPEND_LIMITS.platform }, active: true, createdAt: activeFrom },
    ...providers.map((p) => ({ id: randomUUID() as Uuid, versionId: 'budget-provider-v1' as SpendBudget['versionId'], scope: 'PROVIDER' as const, scopeId: p, limits: { ...DEFAULT_SPEND_LIMITS.provider }, active: true, createdAt: activeFrom })),
  ];
  for (const b of platformBudgets) await ensureSpendBudget(sql, b);
  await primeContractDigest();
  // §18.3 across proposer, adversary and every skill tool: a source read for a moment after now is refused before the repository is touched (INV-13).
  const sources = guardedContextSources(createRepoContextSources({
    sql,
    account: { id: account.id, settlementMint, settlementDecimals: 6, startingCapital: env.PAPER_STARTING_CAPITAL_BASE_UNITS },
    taker,
    cluster: env.SOLANA_CLUSTER,
    quotes: shared.jupiter,
    policy: { maxPositionValueBaseUnits: DEFAULT_RISK_POLICY.maxPositionValueBaseUnits, maxSlippageBps: DEFAULT_RISK_POLICY.maxSlippageBps, maxQuoteAgeMs: DEFAULT_RISK_POLICY.maxQuoteAgeMs },
    taxonomyVersion: DEFAULT_COHORT_TAXONOMY.version,
    clusterWindowMs: 2 * DEFAULT_CORRELATION_CLUSTER_POLICY.windowMs,
    assetMint: async (assetId) => {
      const [r] = await sql<{ mint_address: string }[]>`select mint_address from core.assets where id = ${assetId}`;
      return r ? (r.mint_address as MintAddress) : null;
    },
  }), liveGuardContext(systemClock));
  const repo = {
    listCandidateTargets: (versionId: Parameters<typeof listCandidateTargets>[1], now: Parameters<typeof listCandidateTargets>[2], maxAgeMs: number, limit: number, families: readonly string[]) => listCandidateTargets(sql, versionId, now, maxAgeMs, limit, families),
    listPositionTargets: (versionId: Parameters<typeof listPositionTargets>[1], limit: number) => listPositionTargets(sql, versionId, limit),
    automationHistory: (targetId: Uuid) => automationHistory(sql, targetId),
    recordAutomationRun: (run: Parameters<typeof recordAutomationRun>[1]) => recordAutomationRun(sql, run),
    spendState: async (now: Parameters<typeof listSpendUsageAt>[2]) => {
      const active = await listActiveSpendBudgets(sql);
      return { budgets: active, usage: await listSpendUsageAt(sql, active.map((b) => b.id), now) };
    },
    chargeSpend: async (budgetIds: readonly Uuid[], now: Parameters<typeof spendWindow>[0], delta: { cycles: number; modelUsd: number; providerRequests: number }) => {
      const active = await listActiveSpendBudgets(sql);
      for (const b of active.filter((x) => budgetIds.includes(x.id))) await chargeSpendUsage(sql, b.id, spendWindow(now, spendWindowUnit(b)), delta);
    },
    persist: (outcome: Parameters<typeof persistDiscretionaryOutcome>[1], extra: Parameters<typeof persistDiscretionaryOutcome>[2]) => persistDiscretionaryOutcome(sql, outcome, { ...extra, releaseDigest: digestFor(outcome.cycle.strategyVersionId) }),
    sessionFacts: async () => {
      const g = await sessionEntryGate(sql, account.id);
      return g ? { activity: g.activity, authority: g.authority, paused: g.paused } : null;
    },
    catalystTiming: async (evidenceId: Uuid) => {
      const [e] = await sql<{ source_published_at: string | null; source_time_confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'ABSENT'; corroborates_event_id: string | null }[]>`select source_published_at, source_time_confidence, corroborates_event_id from intelligence.events where id = ${evidenceId}`;
      if (!e) return null;
      return { evidenceId, sourceTime: e.source_published_at ? (new Date(e.source_published_at).toISOString() as Parameters<typeof spendWindow>[0]) : null, sourceTimeConfidence: e.source_time_confidence, relation: e.corroborates_event_id === null ? ('NEW' as const) : ('CORROBORATION' as const) };
    },
    // Activation through the session machine (OPEN_EVENT_WINDOW) lands with the S2 paper run; the capped window is recorded for the Inspector now.
    openEventWindow: async (window: { t0: string; endsAt: string; cadenceMs: number; extensionsRemaining: number }, cycleId: Uuid) => {
      logger.info('event_window_capped', { cycleId, t0: window.t0, endsAt: window.endsAt, cadenceMs: window.cadenceMs, extensionsRemaining: window.extensionsRemaining });
    },
  };
  const strategiesDeps: AgentsDeps[] = [];
  for (const spec of LLM_STRATEGY_SPECS) {
    const strategy = llmStrategyVersion(spec, env.GIT_SHA, activeFrom, models);
    logger.info('strategy_version', { versionId: strategy.versionId, outcome: await ensureStrategyVersion(sql, strategy), gitSha: strategy.gitSha, models: strategy.modelSelections, families: spec.families });
    const automationIds = await installAutomationSet(sql, DEFAULT_AUTOMATION_SET, { strategyVersionId: strategy.versionId, skillVersionId: skill.versionId });
    for (const b of [
      { id: randomUUID() as Uuid, versionId: 'budget-cycles-v1' as SpendBudget['versionId'], scope: 'STRATEGY' as const, scopeId: strategy.strategyId, limits: { cyclesPerHour: DEFAULT_SPEND_LIMITS.strategy.cyclesPerHour, modelUsdPerDay: null, providerRequestsPerMinute: null }, active: true, createdAt: activeFrom },
      { id: randomUUID() as Uuid, versionId: 'budget-model-v1' as SpendBudget['versionId'], scope: 'STRATEGY' as const, scopeId: strategy.strategyId, limits: { cyclesPerHour: null, modelUsdPerDay: DEFAULT_SPEND_LIMITS.strategy.modelUsdPerDay, providerRequestsPerMinute: null }, active: true, createdAt: activeFrom },
    ]) await ensureSpendBudget(sql, b);
    strategiesDeps.push({ repo, sources, proposer: proposer.model, adversary: adversary.model, clock: systemClock, logger, strategy, skill, automations: DEFAULT_AUTOMATION_SET, automationIds, cyclePolicy: DEFAULT_DISCRETIONARY_CYCLE_POLICY, accountId: account.id, config: { batchSize: env.AGENTS_BATCH_SIZE, families: [...spec.families], producer: shared.holder } });
  }
  logger.info('agents_starting', { intervalMs, strategies: strategiesDeps.map((d) => d.strategy.versionId), skill: skill.versionId, proposer: env.AGENT_PROPOSER_MODEL, adversary: env.AGENT_ADVERSARY_MODEL, automations: DEFAULT_AUTOMATION_SET.version, cyclePolicy: DEFAULT_DISCRETIONARY_CYCLE_POLICY.version, holder: shared.holder });
  await loopUnderLease('agents', intervalMs, logger, shared, async () => {
    for (const d of strategiesDeps) await runAgentsCycle(d);
  });
}

/** Shared by the position monitor (mandatory exits) and the trading-actions consumer (cleared discretionary exits): one exit path (§32 one execution boundary). */
async function positionMonitorDeps(env: WorkerEnv, logger: Logger, shared: Shared, taker: NonNullable<WorkerEnv['PAPER_TRADING_WALLET']>, intervalMs: number): Promise<{ deps: PositionMonitorDeps; account: { id: Uuid } }> {
  const { sql } = shared;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const startingCapital = env.PAPER_STARTING_CAPITAL_BASE_UNITS;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: taker, settlementMint });
  const activeFrom = systemClock.now();
  const strategies: Record<string, ReturnType<typeof s0StrategyVersion>> = {};
  for (const v of [s0StrategyVersion('RAW', env.GIT_SHA, activeFrom), s0StrategyVersion('SAFE', env.GIT_SHA, activeFrom), ...llmStrategyVersions(env.GIT_SHA, activeFrom, { proposer: env.AGENT_PROPOSER_MODEL, adversary: env.AGENT_ADVERSARY_MODEL })]) strategies[v.versionId] = v;
  const digestFor = await releaseDigests(Object.values(strategies));
  const adapter = new PaperExecutionAdapter({
    quotes: shared.jupiter,
    clock: systemClock,
    policy: DEFAULT_PAPER_FILL_POLICY,
    taker,
    cluster: env.SOLANA_CLUSTER,
    newId: () => randomUUID() as Uuid,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    journal: ({ order, attempt }) => journalAttempt(sql, order, attempt),
  });
  const deps = {
    repo: {
      listOpenPositions: (limit: number) => listOpenPositionsForAccount(sql, account.id, limit),
      loadStrategyVersion: (id: Parameters<typeof loadStrategyVersion>[1]) => loadStrategyVersion(sql, id),
      highSince: (assetId: Uuid, since: Parameters<typeof highSince>[2], until: Parameters<typeof highSince>[3]) => highSince(sql, assetId, since, until),
      updateMark: (positionId: Uuid, pnl: Parameters<typeof updateMark>[2], next: Parameters<typeof updateMark>[3]) => updateMark(sql, positionId, pnl, next),
      tightenStop: (positionId: Uuid, level: number) => tightenStop(sql, positionId, level),
      recordExitDecision: (c: Parameters<typeof recordExitDecision>[1], p: Parameters<typeof recordExitDecision>[2], r: Parameters<typeof recordExitDecision>[3], e: Parameters<typeof recordExitDecision>[4]) => recordExitDecision(sql, c, p, r, e, digestFor(c.strategyVersionId)),
      recordRiskEvaluation: (e: Parameters<typeof recordRiskEvaluation>[1]) => recordRiskEvaluation(sql, e),
      createIntent: (i: Parameters<typeof createIntent>[1], lifecycle: 'AUTHORIZED') => createIntent(sql, i, lifecycle),
      setIntentState: (id: Parameters<typeof setIntentState>[1], state: Parameters<typeof setIntentState>[2]) => setIntentState(sql, id, state),
      finishAttempt: (order: Parameters<typeof finishAttempt>[1], attempt: Parameters<typeof finishAttempt>[2], fill: Parameters<typeof finishAttempt>[3]) => finishAttempt(sql, order, attempt, fill),
      applyExit: (x: Parameters<typeof applyExit>[1]) => applyExit(sql, x),
      book: (now: Parameters<typeof paperBook>[4]) => paperBook(sql, account.id, settlementMint, startingCapital, now),
      cohorts: async (now: Parameters<typeof latestClusterSet>[1]) => ({ memberships: await listActiveMemberships(sql, DEFAULT_COHORT_TAXONOMY.version), clusterSet: await latestClusterSet(sql, now, 2 * DEFAULT_CORRELATION_CLUSTER_POLICY.windowMs) }),
      writeSnapshot: (s: Parameters<typeof insertPortfolioSnapshot>[1]) => insertPortfolioSnapshot(sql, s),
      sessionActivity: async () => (await sessionEntryGate(sql, account.id))?.activity ?? null,
      captureQuotes: async (probes: Parameters<typeof insertQuoteProbes>[1]) => {
        await insertQuoteProbes(sql, probes);
      },
    },
    adapter,
    exitQuote: async (inputMint: MintAddress, outputMint: MintAddress, inputAmount: typeof startingCapital, maxSlippageBps: Parameters<typeof shared.jupiter.quote>[0]['maxSlippageBps'], now: Parameters<typeof paperBook>[4]) => {
      try {
        const { quote } = await shared.jupiter.quote({ inputMint, outputMint, inputAmount, maxSlippageBps, taker, cluster: env.SOLANA_CLUSTER, requestedAt: now });
        return { expectedOutputAmount: quote.expectedOutputAmount, impactBps: quote.priceImpactBps, quote };
      } catch (err) {
        if (err instanceof NoRouteError) return null;
        throw err;
      }
    },
    clock: systemClock,
    logger,
    account: { id: account.id, settlementMint, settlementDecimals: 6 },
    strategies,
    policy: DEFAULT_RISK_POLICY,
    config: { batchSize: 50, reassessMs: intervalMs },
  };
  return { deps, account };
}

async function positionMonitorLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.POSITION_MONITOR_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('position_monitor_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { deps, account } = await positionMonitorDeps(env, logger, shared, env.PAPER_TRADING_WALLET, intervalMs);
  logger.info('position_monitor_starting', { intervalMs, accountId: account.id, riskPolicy: DEFAULT_RISK_POLICY.version, holder: shared.holder });
  await loopUnderLease('position-monitor', intervalMs, logger, shared, async () => {
    await runPositionMonitorCycle(deps);
  });
}

async function intelIngestLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.INTEL_INGEST_INTERVAL_MS;
  if (!env.CRYPTOPANIC_API_KEY && !env.LUNARCRUSH_API_KEY) {
    logger.warn('roles_disabled', { roles: ['intel-ingest'], reason: 'neither CRYPTOPANIC_API_KEY nor LUNARCRUSH_API_KEY is set' });
    return;
  }
  const { sql } = shared;
  const cryptopanic = env.CRYPTOPANIC_API_KEY ? new CryptoPanicClient({ apiKey: env.CRYPTOPANIC_API_KEY, transport: fetchTransport, clock: systemClock, requestsPerMinute: env.CRYPTOPANIC_REQUESTS_PER_MINUTE }) : null;
  const lunarcrush = env.LUNARCRUSH_API_KEY ? new LunarCrushClient({ apiKey: env.LUNARCRUSH_API_KEY, transport: fetchTransport, clock: systemClock, requestsPerMinute: env.LUNARCRUSH_REQUESTS_PER_MINUTE }) : null;
  const deps = {
    sources: {
      news: cryptopanic ? async (symbols: readonly string[]) => (await cryptopanic.recentPosts({ currencies: symbols })).events : null,
      social: lunarcrush ? (symbol: string) => lunarcrush.coinMetrics(symbol) : null,
    },
    repo: {
      listAssetEntities: () => listAssetEntities(sql),
      listTrackedSymbols: async (limit: number) => {
        const refs = await listTrackedAssets(sql, limit, REFERENCE_SERIES_MINTS);
        if (refs.length === 0) return [];
        const rows = await sql<{ id: string; symbol: string }[]>`select id, symbol from core.assets where id = any(${refs.map((r) => r.id)}::uuid[])`;
        const bySymbol = new Map(rows.map((r) => [r.id, r.symbol]));
        return refs.flatMap((r) => (bySymbol.get(r.id) ? [{ assetId: r.id, symbol: bySymbol.get(r.id) as string }] : []));
      },
      listEventsForClustering: (at: Parameters<typeof listEventsForClustering>[1], windowMs: number) => listEventsForClustering(sql, at, windowMs),
      upsertEvent: (e: Parameters<typeof upsertEvent>[1]) => upsertEvent(sql, e),
    },
    policy: DEFAULT_NORMALIZATION_POLICY,
    clock: systemClock,
    logger,
    config: { symbolsPerTick: 40, newsBatch: 40, socialPerTick: Math.max(1, Math.floor((env.LUNARCRUSH_REQUESTS_PER_MINUTE * intervalMs) / 60_000 / 2)) },
  };
  logger.info('intel_ingest_starting', { intervalMs, providers: { cryptopanic: cryptopanic !== null, lunarcrush: lunarcrush !== null }, policy: DEFAULT_NORMALIZATION_POLICY.version, holder: shared.holder });
  await loopUnderLease('intel-ingest', intervalMs, logger, shared, async () => {
    await runIntelIngestCycle(deps);
  });
}

async function stateProjectorLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.STATE_PROJECTOR_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('state_projector_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const taker = env.PAPER_TRADING_WALLET;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const startingCapital = env.PAPER_STARTING_CAPITAL_BASE_UNITS;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: taker, settlementMint });
  const activeFrom = systemClock.now();
  const key = await importSigningKeyPair(env.PROJECTION_SIGNING_KEY_PKCS8, env.PROJECTION_SIGNING_PUBLIC_KEY);
  // The projection binds to the S0_SAFE Release (M7 runs on S0_SAFE as the cleared input); the same digest is what the authorizer expects.
  const safe = s0StrategyVersion('SAFE', env.GIT_SHA, activeFrom);
  await ensureStrategyVersion(sql, safe);
  const release = await releaseFor(safe, { contractSetDigest: (await getContractSetDigest()).digest, freshnessPolicyVersion: PROJECTION_FRESHNESS.version }, activeFrom);
  const registered = await ensureRelease(sql, release);
  logger.info('release_registered', { releaseId: registered.id, outcome: registered.outcome, digest: release.digest, strategy: safe.versionId });
  const deps = {
    repo: {
      book: (now: Parameters<typeof paperBook>[4]) => paperBook(sql, account.id, settlementMint, startingCapital, now),
      sleeves: () => listSleeves(sql, account.id),
      openLots: () => listOpenLotSummaries(sql, account.id),
      latestReconciliation: () => latestReconciliation(sql, account.id),
      heldAssetEligibility: () => heldAssetEligibility(sql, account.id),
      feedHealth: () => loadFeedHealth(sql, ['BIRDEYE', 'JUPITER', 'HELIUS']),
      cohorts: async (now: Parameters<typeof latestClusterSet>[1]) => ({ memberships: await listActiveMemberships(sql, DEFAULT_COHORT_TAXONOMY.version), clusterSet: await latestClusterSet(sql, now, 2 * DEFAULT_CORRELATION_CLUSTER_POLICY.windowMs) }),
      nextSequence: () => nextProjectionSequence(sql, account.id),
      insert: (envelope: Parameters<typeof insertProjection>[2]) => insertProjection(sql, account.id, envelope),
      capitalCeilingUsd: async () => (await latestCapitalAttestation(sql, account.id))?.ceilingUsd ?? null,
      auditHead: () => auditHead(sql),
    },
    key,
    clock: systemClock,
    logger,
    account: { id: account.id, settlementMint, settlementDecimals: 6, startingCapital, virtualSolLamports: '1000000000' as typeof startingCapital },
    release: { ...release, id: registered.id },
    policy: DEFAULT_RISK_POLICY,
    freshness: PROJECTION_FRESHNESS,
    providerFor: (dataClass: string) => (dataClass === 'ACTIVE_POSITION_PRICE' || dataClass === 'CANDIDATE_PRICE' ? 'JUPITER' : dataClass === 'CANDLES' || dataClass === 'TOKEN_OVERVIEW' || dataClass === 'DISCOVERY_LIST' ? 'BIRDEYE' : null),
    config: { reconciliationMaxAgeMs: 5 * env.RECONCILIATION_INTERVAL_MS },
  };
  logger.info('state_projector_starting', { intervalMs, accountId: account.id, keyId: key.keyId, release: release.digest.slice(0, 12), holder: shared.holder });
  await loopUnderLease('state-projector', intervalMs, logger, shared, async () => {
    await runStateProjectorCycle(deps);
  });
}

async function liveEntryLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.LIVE_ENTRY_INTERVAL_MS;
  if (!env.RISK_AUTHORIZER_URL || !env.EXECUTION_SERVICE_URL || !env.INTERNAL_API_SECRET) {
    logger.warn('roles_disabled', { roles: ['live-entry'], reason: 'RISK_AUTHORIZER_URL, EXECUTION_SERVICE_URL and INTERNAL_API_SECRET are required' });
    return;
  }
  const { sql } = shared;
  const accounts = await listLiveAccounts(sql);
  if (accounts.length === 0) {
    logger.warn('roles_disabled', { roles: ['live-entry'], reason: 'no LIVE trading account is registered' });
    return;
  }
  const account = accounts[0]!;
  const authorizer = new AuthorizerClient({ baseUrl: env.RISK_AUTHORIZER_URL, secretHex: env.INTERNAL_API_SECRET, clock: systemClock });
  const executor = new ExecutorClient({ baseUrl: env.EXECUTION_SERVICE_URL, secretHex: env.INTERNAL_API_SECRET, clock: systemClock });
  const safe = s0StrategyVersion('SAFE', env.GIT_SHA, systemClock.now());
  const deps = {
    repo: {
      listAwaitingAuthorization: (ids: Parameters<typeof listCyclesAwaitingEntry>[1], limit: number) => listCyclesAwaitingEntry(sql, ids, limit),
      listAuthorizedAwaitingExecution: (accountId: Uuid, now: Parameters<typeof listAuthorizedIntentsAwaitingExecution>[2], limit: number) => listAuthorizedIntentsAwaitingExecution(sql, accountId, now, limit),
      approvalFor: (intentId: Uuid) => loadApprovalGrant(sql, intentId),
      setIntentState: (id: Parameters<typeof setIntentState>[1], state: Parameters<typeof setIntentState>[2]) => setIntentState(sql, id, state),
      sessionGate: (accountId: Uuid) => sessionEntryGate(sql, accountId),
    },
    authorizer,
    executor,
    clock: systemClock,
    logger,
    account: { id: account.id },
    strategyVersionIds: [safe.versionId],
    config: { batchSize: 10, protectionMode: 'MONITORED_EXIT' as const },
  };
  logger.info('live_entry_starting', { intervalMs, accountId: account.id, strategies: deps.strategyVersionIds, authorizer: env.RISK_AUTHORIZER_URL, executor: env.EXECUTION_SERVICE_URL, holder: shared.holder });
  await loopUnderLease('live-entry', intervalMs, logger, shared, async () => {
    await runLiveEntryCycle(deps);
  });
}

async function approvalsLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.APPROVALS_INTERVAL_MS;
  if (!env.APPROVAL_SIGNING_KEY_PKCS8 || !env.APPROVAL_SIGNING_PUBLIC_KEY || !env.RISK_AUTHORIZER_PUBLIC_KEYS?.length) {
    logger.warn('roles_disabled', { roles: ['approvals'], reason: 'APPROVAL_SIGNING_KEY_PKCS8, APPROVAL_SIGNING_PUBLIC_KEY and RISK_AUTHORIZER_PUBLIC_KEYS are required' });
    return;
  }
  const { sql } = shared;
  const signing = await importSigningKeyPair(env.APPROVAL_SIGNING_KEY_PKCS8, env.APPROVAL_SIGNING_PUBLIC_KEY);
  const authorizerKeys = await Promise.all(env.RISK_AUTHORIZER_PUBLIC_KEYS.map((k) => importVerificationKey(k)));
  const deps = {
    repo: {
      listPending: (kinds: Parameters<typeof listPendingControlRequests>[1], limit: number) => listPendingControlRequests(sql, kinds, limit),
      stepUpVerified: stepUpVerifiedLazily(env, logger, shared),
      loadAuthorization: (intentId: Uuid) => loadAuthorizationForIntent(sql, intentId),
      insertApproval: (envelope: Parameters<typeof insertApproval>[1]) => insertApproval(sql, envelope),
      setIntentState: (id: Parameters<typeof setIntentState>[1], state: Parameters<typeof setIntentState>[2]) => setIntentState(sql, id, state),
      resolve: (id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Parameters<typeof resolveControlRequest>[4]) => resolveControlRequest(sql, id, state, resolution, at),
      loadRelease: (id: Uuid) => loadRelease(sql, id),
      applyReleaseStatus: (from: Parameters<typeof applyReleaseStatus>[1], to: Parameters<typeof applyReleaseStatus>[2]) => applyReleaseStatus(sql, from, to),
      insertAttestation: (a: Parameters<typeof insertAttestation>[1]) => insertAttestation(sql, a),
      insertCapitalAttestation: (c: Parameters<typeof insertCapitalAttestation>[1]) => insertCapitalAttestation(sql, c),
      stepUpEvidence: (requestId: Uuid, now: Parameters<typeof stepUpEvidenceFor>[2]) => stepUpEvidenceFor(sql, requestId, now),
      sleeveConflicts: (accountId: Uuid) => sleeveConflicts(sql, accountId),
      paperEvidence: async (release: Parameters<typeof applyReleaseStatus>[1]) => {
        const [c] = await sql<{ n: string | number }[]>`select count(*)::int as n from agents.action_cycles where strategy_version_id = ${release.binding.strategyVersionId} and state = 'CLEARED'`;
        const [r] = await sql<{ status: string | null }[]>`select status from trading.custody_reconciliations order by evaluated_at desc limit 1`;
        return { paperCycles: Number(c?.n ?? 0), reconciliationClean: r?.status !== 'MISMATCH' };
      },
      recognizedUsd: async () => null,
      approverRole: async (userId: Uuid) => {
        const [r] = await sql<{ role: 'operator' | 'admin' | 'viewer' }[]>`select role from ops.operators where user_id = ${userId} and disabled_at is null`;
        return r && (r.role === 'operator' || r.role === 'admin') ? r.role : null;
      },
    },
    authorizerKeys,
    signing,
    // Live Readiness (M8a) answers here; until it exists arming fails closed (§15.9).
    // Live Readiness (§29): the worker's readiness role computes READY_FOR_ATTENDED_TINY_LIVE; arming needs a fresh READY verdict for exactly this Release.
    readinessPermits: async (releaseId: Uuid) => verdictPermits(await latestReadinessVerdict(sql, 'READY_FOR_ATTENDED_TINY_LIVE', env.DEPLOYMENT_PROFILE, 'DETERMINISTIC'), releaseId, systemClock.now(), DEFAULT_READINESS_POLICY),
    liveCapabilityEnabled: false,
    clock: systemClock,
    logger,
    config: { batchSize: 20, maxValidityMs: env.APPROVAL_MAX_VALIDITY_MS, attestationValidityMs: 24 * 3_600_000, minPaperCycles: 20 },
  };
  logger.info('approvals_starting', { intervalMs, keyId: signing.keyId, authorizerKeys: authorizerKeys.map((k) => k.keyId), maxValidityMs: env.APPROVAL_MAX_VALIDITY_MS, holder: shared.holder });
  await loopUnderLease('approvals', intervalMs, logger, shared, async () => {
    await runApprovalsCycle(deps);
  });
}

async function tradingActionsLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.TRADING_ACTIONS_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('trading_actions_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const { deps: monitor, account } = await positionMonitorDeps(env, logger, shared, env.PAPER_TRADING_WALLET, env.POSITION_MONITOR_INTERVAL_MS);
  const digest = (await getContractSetDigest()).digest;
  const loop = {
    sql,
    client: new PgmqClient(sql),
    holder: shared.holder,
    expectedContractSetDigest: digest,
    batch: 5,
    leaseSeconds: 120,
    loadCycle: (id: Uuid) => loadActionCycle(sql, id),
    loadProposal: (id: Uuid) => loadProposal(sql, id),
    loadPosition: async (id: Uuid) => {
      const row = (await listOpenPositionsForAccount(sql, account.id, 500)).find((p) => p.id === id) ?? null;
      if (!row) return null;
      const [r] = await sql<{ review_state: string }[]>`select review_state from trading.positions where id = ${id}`;
      return r ? { ...row, reviewState: r.review_state } : null;
    },
    tightenStop: (positionId: Uuid, level: number) => tightenStop(sql, positionId, level),
    execute: (p: Parameters<typeof executeClearedExit>[1], c: Parameters<typeof executeClearedExit>[2], pr: Parameters<typeof executeClearedExit>[3], now: Parameters<typeof executeClearedExit>[4]) => executeClearedExit(monitor, p, c, pr, now),
    clock: systemClock,
    logger,
  };
  logger.info('trading_actions_starting', { intervalMs, accountId: account.id, holder: shared.holder });
  await loopUnderLease('trading-actions', intervalMs, logger, shared, async () => {
    await runTradingActionsCycle(loop);
  });
}

async function sessionLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.SESSION_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('session_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: env.PAPER_TRADING_WALLET, settlementMint });
  const attended = env.DEPLOYMENT_PROFILE === 'P1A' || env.DEPLOYMENT_PROFILE === 'P2';
  const deps = {
    repo: {
      findOpenSession: (accountId: Uuid) => findOpenSession(sql, accountId),
      createSession: async (input: { accountId: Uuid; profile: Parameters<typeof createRuntimeSession>[1]['profile']; attended: boolean; capitalAuthority: Parameters<typeof createRuntimeSession>[1]['capitalAuthority'] }) => (await createRuntimeSession(sql, input)) as Uuid,
      loadSession: (id: Uuid) => loadSession(sql, id),
      persistTransition: async (t: Parameters<typeof persistRuntimeTransition>[1]) => {
        await persistRuntimeTransition(sql, t);
      },
      saveColdStartGates: (id: Uuid, gates: Parameters<typeof saveColdStartGates>[2]) => saveColdStartGates(sql, id, gates),
      coldStartFacts: (now: Parameters<typeof coldStartFacts>[1]) => coldStartFacts(sql, now, { requiredFeatures: FEATURE_ENGINE_V2.requiredForScoring, featureWindowMs: DEFAULT_SESSION_POLICY.safetyMaxAgeMs, safetyMaxAgeMs: DEFAULT_SESSION_POLICY.safetyMaxAgeMs }),
      windDownFacts: (accountId: Uuid) => windDownFacts(sql, accountId),
      listPendingControlRequests: (kinds: Parameters<typeof listPendingControlRequests>[1], limit: number) => listPendingControlRequests(sql, kinds, limit),
      stepUpVerifiedFor: stepUpVerifiedLazily(env, logger, shared),
      resolveControlRequest: (id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Parameters<typeof resolveControlRequest>[4]) => resolveControlRequest(sql, id, state, resolution, at),
      // §15.9: a live authority needs an ARMED Release with a valid ARM attestation and a readiness verdict; readiness lands in M8a, so live cannot be set yet.
      activeEntryPauses: () => activeEntryPauses(sql),
      clearEntryPauses: (by: Uuid, ref: string) => clearEntryPauses(sql, by, ref),
      windDownLots: (accountId: Uuid) => windDownLots(sql, accountId),
      strategyOfflineTerms: async (v: VersionId) => {
        const strategy = await loadStrategyVersion(sql, v);
        return strategy ? { permitted: strategy.offlineProtection.permitted, maxOfflineMs: strategy.offlineProtection.maxOfflineMs } : null;
      },
      watchdogLastRunAt: () => watchdogLastRunAt(sql),
      setOfflineResumeDeadline: (sessionId: Uuid, deadline: Instant | null, protectedLots: number) => setOfflineResumeDeadline(sql, sessionId, deadline, protectedLots),
      armingFacts: async (authority: CapitalAuthority, now: Instant) => {
        if (authority !== 'LIVE_APPROVAL' && authority !== 'LIVE_AUTO') return { releaseAttested: true, readinessPermits: true };
        const release = await loadReleaseForStrategy(sql, s0TinyLiveVersion(env.GIT_SHA, now).versionId);
        const attestation = release ? await loadLatestAttestation(sql, release.id, 'ARM') : null;
        const facts = armingPreconditions({ requestedAuthority: authority, liveCapabilityEnabled: true, release, attestation, readinessPermits: true, stepUpVerified: true, now });
        const readinessPermits = release ? verdictPermits(await latestReadinessVerdict(sql, 'READY_FOR_ATTENDED_TINY_LIVE', env.DEPLOYMENT_PROFILE, 'DETERMINISTIC'), release.id, now, DEFAULT_READINESS_POLICY) : false;
        return { releaseAttested: facts.ok, readinessPermits };
      },
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_SESSION_POLICY,
    account: { id: account.id },
    profile: env.DEPLOYMENT_PROFILE,
    attended,
    authority: 'PAPER' as const,
    autoStart: env.SESSION_AUTOSTART === 'true',
    liveCapabilityEnabled: false,
    watchdogPolicy: DEFAULT_WATCHDOG_POLICY,
  };
  logger.info('session_starting', { intervalMs, accountId: account.id, profile: env.DEPLOYMENT_PROFILE, attended, autoStart: deps.autoStart, policy: DEFAULT_SESSION_POLICY.version, holder: shared.holder });
  await loopUnderLease('session', intervalMs, logger, shared, async () => {
    await runSessionCycle(deps);
  });
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});

async function chainHealthLoop(env: WorkerEnv, logger: Logger, shared: Shared, primaryUrl: string): Promise<void> {
  const intervalMs = env.CHAIN_HEALTH_INTERVAL_MS;
  const { sql } = shared;
  const sampler = (url: string, label: string): ChainViewSampler => {
    const origin = new URL(url).origin;
    const confirmed = new SolanaRpcClient({ url, allowedOrigins: [origin], nowMs: () => systemClock.nowMs() });
    const finalized = new SolanaRpcClient({ url, allowedOrigins: [origin], commitment: 'finalized', nowMs: () => systemClock.nowMs() });
    return {
      label,
      async sample() {
        const [slotConfirmed, slotFinalized, blockHeight] = await Promise.all([confirmed.getSlot(), finalized.getSlot(), confirmed.getBlockHeight()]);
        return { slotConfirmed, slotFinalized, blockHeight };
      },
    };
  };
  const samplers = [sampler(primaryUrl, 'primary')];
  if (env.SOLANA_RPC_SECONDARY_URL) {
    if (new URL(env.SOLANA_RPC_SECONDARY_URL).origin === new URL(primaryUrl).origin) logger.warn('secondary_rpc_not_independent', { origin: new URL(primaryUrl).origin });
    else samplers.push(sampler(env.SOLANA_RPC_SECONDARY_URL, 'secondary'));
  } else logger.warn('chain_health_single_view', { effect: 'cross-RPC divergence cannot be detected; set SOLANA_RPC_SECONDARY_URL' });
  const deps: ChainHealthDeps = {
    samplers,
    repo: { insert: (s) => insertChainHealth(sql, s), lastHeadAdvance: () => lastHeadAdvance(sql), upsertFeedHealth: (h) => upsertFeedHealth(sql, h) },
    policy: DEFAULT_CHAIN_HEALTH_POLICY,
    clock: systemClock,
    logger,
  };
  let previous: PreviousHead | null = null;
  logger.info('chain_health_starting', { intervalMs, policyVersion: DEFAULT_CHAIN_HEALTH_POLICY.version, views: samplers.map((s) => s.label), holder: shared.holder });
  await loopUnderLease('chain-health', intervalMs, logger, shared, async () => {
    previous = (await runChainHealthCycle(deps, previous)).previous;
  });
}

/** Reconciliation dependencies, shared by the reconciliation loop and startup recovery (§21.3). */
function reconciliationDeps(env: WorkerEnv, logger: Logger, shared: Shared, rpc: SolanaRpcClient) {
  const helius = env.HELIUS_API_KEY ? new HeliusClient({ apiKey: env.HELIUS_API_KEY, clock: systemClock }) : null;
  if (!helius) logger.warn('reconciliation_without_helius', { effect: 'any signature touching a trading wallet pauses new entries until HELIUS_API_KEY is set' });
  const { sql } = shared;
  return {
    rpc,
    helius,
    repo: {
      listTradingAccounts: () => listTradingAccounts(sql),
      listCustodyAccounts: (accountId: Parameters<typeof listCustodyAccounts>[1], now: Parameters<typeof listCustodyAccounts>[2]) => listCustodyAccounts(sql, accountId, now),
      ledgerExpectations: (accountId: Parameters<typeof ledgerExpectations>[1]) => ledgerExpectations(sql, accountId),
      reconciliationCursor: (accountId: Parameters<typeof reconciliationCursor>[1]) => reconciliationCursor(sql, accountId),
      lifecycleForSignature: (signature: Parameters<typeof lifecycleForSignature>[1]) => lifecycleForSignature(sql, signature),
      recordReconciliation: (report: Parameters<typeof recordReconciliation>[1]) => recordReconciliation(sql, report),
      fundingEventBySignature: async (signature: Parameters<typeof fundingEventBySignature>[1]) => {
        const e = await fundingEventBySignature(sql, signature);
        return e ? { id: e.id, destinationTradingWallet: e.destinationTradingWallet, destinationAta: e.destinationAta, fundingMint: e.fundingMint, sourceWallet: e.sourceWallet } : null;
      },
      confirmFundingEvent: (id: Uuid, deltas: { source: string; destination: string }, at: Instant) => confirmFundingEvent(sql, id, { source: deltas.source as never, destination: deltas.destination as never }, at),
      listOwnedAddresses: () => listOwnedAddresses(sql),
      registerOwnedAddress: (a: Parameters<typeof registerOwnedAddress>[1]) => registerOwnedAddress(sql, a),
    },
    clock: systemClock,
    logger,
    policy: DEFAULT_RECONCILIATION_POLICY,
  };
}

/** Step-up verification deps shared by the operator-security role and the roles that consume verified assertions (ADR-0006). Null when no relying party is configured. */
function operatorSecurityDeps(env: WorkerEnv, logger: Logger, shared: Shared): OperatorSecurityDeps | null {
  if (!env.WEBAUTHN_RP_ID || !env.WEBAUTHN_ORIGINS?.length) return null;
  const { sql } = shared;
  return {
    repo: {
      listPending: (kinds, limit) => listPendingControlRequests(sql, kinds, limit),
      loadPendingRequest: (id) => loadPendingControlRequest(sql, id),
      loadChallenge: (id) => loadStepUpChallenge(sql, id),
      loadPasskeyByCredentialId: (cid) => loadPasskeyByCredentialId(sql, cid),
      activePasskeys: (userId) => activePasskeyCount(sql, userId),
      consume: (input) => consumeStepUpChallenge(sql, input),
      recordUse: (id, count, at) => recordPasskeyUse(sql, id, count, at),
      insertPasskey: (p) => insertPasskey(sql, p),
      revokePasskey: (id, userId, at) => revokePasskey(sql, id, userId, at),
      operatorRole: async (userId) => {
        const [r] = await sql<{ role: 'operator' | 'admin' | 'viewer' }[]>`select role from ops.operators where user_id = ${userId} and disabled_at is null`;
        return r?.role ?? null;
      },
      resolve: (id, state, resolution, at) => resolveControlRequest(sql, id, state, resolution, at),
      raise: (n) => raiseNotification(sql, { ...n, deadManDeadline: null }),
    },
    rp: { rpId: env.WEBAUTHN_RP_ID, origins: env.WEBAUTHN_ORIGINS },
    clock: systemClock,
    logger,
    config: { batchSize: 20 },
  };
}

/** A `stepUpVerifiedFor` that first judges any evidence still sitting on the request, so the owning role never races the operator-security role. */
function stepUpVerifiedLazily(env: WorkerEnv, logger: Logger, shared: Shared): (requestId: Uuid, now: Instant) => Promise<boolean> {
  const deps = operatorSecurityDeps(env, logger, shared);
  return async (requestId, now) => {
    if (deps) await ensureStepUpJudged(deps, requestId).catch((err) => logger.error('step_up_judge_failed', { requestId, error: err instanceof Error ? err.message : String(err) }));
    return stepUpVerifiedFor(shared.sql, requestId, now);
  };
}

/** Role operator-security (§5.7, §20.26, D41): passkey registration/revocation and step-up verification for every control request. */
async function operatorSecurityLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.OPERATOR_SECURITY_INTERVAL_MS;
  const deps = operatorSecurityDeps(env, logger, shared);
  if (!deps) {
    logger.warn('roles_disabled', { roles: ['operator-security'], reason: 'WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS not set' });
    return;
  }
  logger.info('operator_security_starting', { intervalMs, rpId: deps.rp.rpId, origins: deps.rp.origins, holder: shared.holder });
  await loopUnderLease('operator-security', intervalMs, logger, shared, async () => {
    const r = await runOperatorSecurityCycle(deps);
    if (r.verified || r.verificationFailed || r.registered || r.revoked || r.errors.length || Object.keys(r.refused).length) logger.info('operator_security_cycle', { ...r });
  });
}

/** Role watchlist (§20.4, §20.27): WATCH_ASSET / UNWATCH_ASSET / REQUEST_RESEARCH_REFRESH, attention only. */
async function watchlistLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.MANUAL_ACTIONS_INTERVAL_MS;
  const { sql } = shared;
  const deps: WatchlistDeps = {
    repo: {
      listPending: (kinds, limit) => listPendingControlRequests(sql, kinds, limit),
      operatorRole: async (userId) => {
        const [r] = await sql<{ role: 'operator' | 'admin' | 'viewer' }[]>`select role from ops.operators where user_id = ${userId} and disabled_at is null`;
        return r?.role ?? null;
      },
      assetIdByMint: (mint) => assetIdByMint(sql, mint),
      assetExists: (id) => assetExists(sql, id),
      addWatch: (w) => addWatch(sql, w),
      removeWatch: (id, by, at) => removeWatch(sql, id, by, at),
      requestResearchRefresh: (assetId, at) => requestResearchRefresh(sql, assetId, at),
      resolve: (id, state, resolution, at) => resolveControlRequest(sql, id, state, resolution, at),
    },
    clock: systemClock,
    logger,
    config: { batchSize: 20 },
  };
  logger.info('watchlist_starting', { intervalMs, holder: shared.holder });
  await loopUnderLease('watchlist', intervalMs, logger, shared, async () => {
    const r = await runWatchlistCycle(deps);
    if (r.requests > 0) logger.info('watchlist_cycle', { ...r });
  });
}

/** Role replay (§18, §19, P9; M10): queues RUN_REPLAY requests as reproducibility records and executes one run at a time under the simulated clock. */
async function replayLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.REPLAY_INTERVAL_MS;
  const { sql } = shared;
  const activeFrom = systemClock.now();
  const skill = tradingSkillVersion(env.GIT_SHA, activeFrom);
  const strategies: Record<string, ReturnType<typeof s0StrategyVersion>> = {};
  for (const v of [s0StrategyVersion('RAW', env.GIT_SHA, activeFrom), s0StrategyVersion('SAFE', env.GIT_SHA, activeFrom), ...llmStrategyVersions(env.GIT_SHA, activeFrom, { proposer: env.AGENT_PROPOSER_MODEL, adversary: env.AGENT_ADVERSARY_MODEL })]) strategies[v.versionId] = v;
  let modelCutoffs: Record<string, string> = {};
  try {
    modelCutoffs = JSON.parse(env.MODEL_TRAINING_CUTOFFS) as Record<string, string>;
  } catch {
    logger.warn('replay_model_cutoffs_invalid', { detail: 'MODEL_TRAINING_CUTOFFS is not JSON; every model is labelled UNKNOWN' });
  }
  const policies = {
    featureSpec: FEATURE_ENGINE_V2,
    momentum: DEFAULT_MOMENTUM_TRIGGER_POLICY,
    gate: DEFAULT_S0_SAFETY_GATE_POLICY,
    risk: DEFAULT_RISK_POLICY,
    costModel: DEFAULT_REPLAY_COST_MODEL,
    eligibility: DEFAULT_ELIGIBILITY_POLICY,
    regime: DEFAULT_MARKET_REGIME_POLICY,
  };
  const lookbackMs = (Math.max(...Object.values(FEATURE_ENGINE_V2.lookbackBuckets)) + 2) * 60_000;
  const recordedIds = Object.values(strategies).filter((v) => v.strategyId !== 'S0_RAW' && v.strategyId !== 'S0_SAFE').map((v) => v.versionId);
  const deps: ReplayRoleDeps = {
    repo: {
      listPending: (kinds, limit) => listPendingControlRequests(sql, kinds, limit),
      operatorRole: async (userId) => {
        const [r] = await sql<{ role: 'operator' | 'admin' | 'viewer' }[]>`select role from ops.operators where user_id = ${userId} and disabled_at is null`;
        return r?.role ?? null;
      },
      resolve: (id, state, resolution, at) => resolveControlRequest(sql, id, state, resolution, at),
      insertRun: (run, extra) => insertReplayRun(sql, run, extra),
      claimQueued: (now) => claimQueuedReplayRun(sql, now),
      complete: (id, done) => completeReplayRun(sql, id, done),
      fail: (id, error, at) => failReplayRun(sql, id, error, at),
      insertDecisions: (rows) => insertReplayDecisions(sql, rows),
      insertTrades: (rows) => insertReplayTrades(sql, rows),
    },
    clock: systemClock,
    logger,
    versions: {
      gitSha: env.GIT_SHA,
      contractSetDigest: (await getContractSetDigest()).digest,
      strategies,
      skillVersionId: skill.versionId,
      guidelineVersionId: skill.guidelineVersion,
      modelCutoffs: modelCutoffs as Record<string, never>,
      providerDatasetVersions: { birdeye: 'ohlcv-v3', helius: 'parsed-events-v1', jupiter: 'quote-v1' },
    },
    policies,
    account: {
      settlementMint: DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress,
      settlementDecimals: 6,
      startingCapital: env.PAPER_STARTING_CAPITAL_BASE_UNITS,
      virtualSolLamports: '1000000000',
      sleeveCap: mulDiv(env.PAPER_STARTING_CAPITAL_BASE_UNITS, 40n, 100n, 'FLOOR'),
      sleeveRiskBudget: mulDiv(env.PAPER_STARTING_CAPITAL_BASE_UNITS, 5n, 100n, 'FLOOR'),
    },
    platformMonthlyUsd: env.REPLAY_PLATFORM_MONTHLY_USD,
    loadDataset: (run, assetIds) => loadReplayDataset(sql, run, assetIds, { lookbackMs, taxonomyVersion: DEFAULT_COHORT_TAXONOMY.version, solMint: WSOL_MINT, recordedStrategyVersionIds: recordedIds.filter((id) => run.strategyVersionIds.includes(id)) }),
    newId: () => randomUUID() as Uuid,
    config: { batchSize: 10, maxWindowMs: 14 * 86_400_000 },
  };
  logger.info('replay_starting', { intervalMs, strategies: Object.keys(strategies), costModel: DEFAULT_REPLAY_COST_MODEL.version, platformMonthlyUsd: env.REPLAY_PLATFORM_MONTHLY_USD, holder: shared.holder });
  await loopUnderLease('replay', intervalMs, logger, shared, async () => {
    const q = await runReplayRequestsCycle(deps);
    if (q.requests > 0) logger.info('replay_requests_cycle', { ...q });
    const x = await runReplayExecutionCycle(deps);
    if (x.claimed) logger.info('replay_execution_cycle', { ...x });
  });
}

/** Role funding (§20.18, D56): records what the operator's own wallet did with a reviewed transfer; reconciliation confirms from chain deltas. */
async function fundingLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.MANUAL_ACTIONS_INTERVAL_MS;
  const { sql } = shared;
  const deps: FundingDeps = {
    repo: {
      listPending: (kinds, limit) => listPendingControlRequests(sql, kinds, limit),
      operatorRole: async (userId) => {
        const [r] = await sql<{ role: 'operator' | 'admin' | 'viewer' }[]>`select role from ops.operators where user_id = ${userId} and disabled_at is null`;
        return r?.role ?? null;
      },
      accountByTradingWallet: async (wallet) => {
        const [a] = await sql<{ id: string; cluster: SolanaCluster; trading_wallet: string; settlement_mint: string }[]>`select id, cluster, trading_wallet, settlement_mint from trading.accounts where trading_wallet = ${wallet}`;
        if (!a) return null;
        const [ata] = await sql<{ address: string }[]>`select address from trading.custody_accounts where account_id = ${a.id} and kind = 'ASSOCIATED_TOKEN_ACCOUNT' and mint = ${a.settlement_mint} and active_to is null limit 1`;
        return { id: a.id as Uuid, cluster: a.cluster, tradingWallet: a.trading_wallet, settlementMint: a.settlement_mint, settlementAta: ata?.address ?? null };
      },
      insertFundingEvent: (e) => insertFundingEvent(sql, e),
      resolve: (id, state, resolution, at) => resolveControlRequest(sql, id, state, resolution, at),
    },
    clock: systemClock,
    logger,
    config: { batchSize: 20 },
  };
  logger.info('funding_starting', { intervalMs, holder: shared.holder });
  await loopUnderLease('funding', intervalMs, logger, shared, async () => {
    const r = await runFundingCycle(deps);
    if (r.requests > 0) logger.info('funding_cycle', { ...r });
  });
}

async function manualActionsLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.MANUAL_ACTIONS_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('manual_actions_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { deps: monitor, account } = await positionMonitorDeps(env, logger, shared, env.PAPER_TRADING_WALLET, env.POSITION_MONITOR_INTERVAL_MS);
  const { sql } = shared;
  const deps: ManualActionsDeps = {
    repo: {
      listPending: (kinds: Parameters<typeof listPendingControlRequests>[1], limit: number) => listPendingControlRequests(sql, kinds, limit),
      operatorRole: async (userId: Uuid) => {
        const [r] = await sql<{ role: 'operator' | 'admin' | 'viewer' }[]>`select role from ops.operators where user_id = ${userId} and disabled_at is null`;
        return r?.role ?? null;
      },
      listOpenPositions: (limit: number) => listOpenPositionsForAccount(sql, account.id, limit),
      resolve: (id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant) => resolveControlRequest(sql, id, state, resolution, at),
    },
    exit: async (p, action, fraction, requested, reason, now) => {
      const quote = await monitor.exitQuote(p.mint, monitor.account.settlementMint, requested, monitor.policy.maxSlippageBps, now);
      return executeExit(monitor, p, action, fraction, requested, quote?.impactBps ?? null, reason, now);
    },
    clock: systemClock,
    logger,
    config: { batchSize: 10, maxOpenPositions: 200 },
  };
  logger.info('manual_actions_starting', { intervalMs, accountId: account.id, holder: shared.holder });
  await loopUnderLease('manual-actions', intervalMs, logger, shared, async () => {
    await runManualActionsCycle(deps);
  });
}

/** Release digests per strategy version (ADR-0009 P2): what a CLEARED transition is recorded against and what the authorizer expects. */
async function releaseDigests(versions: readonly StrategyVersion[]): Promise<(strategyVersionId: VersionId) => Sha256Hex | null> {
  const ctx = { contractSetDigest: (await getContractSetDigest()).digest, freshnessPolicyVersion: PROJECTION_FRESHNESS.version };
  const map = new Map<VersionId, Sha256Hex>();
  for (const v of versions) map.set(v.versionId, (await releaseFor(v, ctx, v.activeFrom)).digest);
  return (id) => map.get(id) ?? null;
}

async function auditCheckpointLoop(env: WorkerEnv, logger: Logger, shared: Shared, path: string): Promise<void> {
  const intervalMs = env.AUDIT_CHECKPOINT_INTERVAL_MS;
  const { sql } = shared;
  const replicator = new FileCheckpointReplicator(path);
  const deps: AuditCheckpointDeps = {
    repo: {
      checkpoint: () => checkpointAuditChain(sql, [replicator]),
      verify: () => verifyAgainstExternalCheckpoint(sql, replicator),
      record: (v) => recordAuditVerification(sql, v),
      openAlertExists: async (alertClass) => (await listOpenNotifications(sql)).some((n) => n.alertClass === alertClass),
      raise: (n) => raiseNotification(sql, { ...n, deadManDeadline: null }),
      resolve: (alertClass, at) => resolveNotifications(sql, alertClass, at),
    },
    logger,
    replica: replicator.label,
    clock: systemClock,
  };
  logger.info('audit_checkpoint_starting', { intervalMs, replica: replicator.label, holder: shared.holder });
  await loopUnderLease('audit-checkpoint', intervalMs, logger, shared, async () => {
    await runAuditCheckpointCycle(deps);
  });
}

async function readinessLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.READINESS_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('readiness_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const drillExecutor = env.EXECUTION_SERVICE_URL && env.INTERNAL_API_SECRET ? new ExecutorClient({ baseUrl: env.EXECUTION_SERVICE_URL, secretHex: env.INTERNAL_API_SECRET, clock: systemClock, timeoutMs: 15_000 }) : null;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  // Profile 0/1 worker: the account is the paper account (ensurePaperAccount refuses anything else), so the LIVE-only rows fail by construction until Profile 2.
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: env.PAPER_TRADING_WALLET, settlementMint });
  const activeFrom = systemClock.now();
  // The verdict is computed for the tiny-live S0_SAFE Release (ADR-0004); its DRAFT row is registered by digest so evidence can bind to it.
  const tiny = s0TinyLiveVersion(env.GIT_SHA, activeFrom);
  await ensureStrategyVersion(sql, tiny);
  const tinyRelease = await releaseFor(tiny, { contractSetDigest: (await getContractSetDigest()).digest, freshnessPolicyVersion: PROJECTION_FRESHNESS.version }, activeFrom);
  const registered = await ensureRelease(sql, tinyRelease);
  const binding: ReadinessBinding = {
    gitSha: env.GIT_SHA,
    imageDigest: null,
    contractSetDigest: (await getContractSetDigest()).digest,
    policyDigests: { risk: DEFAULT_RISK_POLICY.version, session: DEFAULT_SESSION_POLICY.version, chainHealth: DEFAULT_CHAIN_HEALTH_POLICY.version, readiness: DEFAULT_READINESS_POLICY.version, walletReserve: DEFAULT_WALLET_RESERVE_POLICY.version, freshness: PROJECTION_FRESHNESS.version },
    tradingWallet: account.tradingWallet,
    cluster: env.SOLANA_CLUSTER,
    profile: env.DEPLOYMENT_PROFILE,
    releaseId: registered.id,
    releaseDigest: tinyRelease.digest,
  };
  const deps: ReadinessDeps = {
    repo: {
      facts: async () => {
        const release = await loadReleaseForStrategy(sql, tiny.versionId);
        const [recon, attestation, capital, projection, presence, chainHealth, conflicts] = await Promise.all([
          latestReconciliation(sql, account.id),
          release ? loadLatestAttestation(sql, release.id) : Promise.resolve(null),
          latestCapitalAttestation(sql, account.id),
          loadLatestProjection(sql, account.id),
          latestPresence(sql, account.id),
          latestChainHealth(sql),
          sleeveConflicts(sql, account.id),
        ]);
        return {
          accountMode: 'PAPER' as const,
          reconciliation: recon ? { status: recon.status, evaluatedAt: recon.evaluatedAt } : null,
          release,
          attestation,
          capital,
          projection: projection?.envelope.payload ?? null,
          presence: presence ? { attended: presence.attended, lastPresenceHeartbeatAt: presence.lastPresenceHeartbeatAt } : null,
          chainHealth,
          sleeveConflicts: conflicts,
        };
      },
      latestRows: () => latestReadinessRows(sql, env.DEPLOYMENT_PROFILE, 'DETERMINISTIC'),
      insertRow: (row) => insertReadinessRow(sql, row),
      latestVerdict: () => latestReadinessVerdict(sql, 'READY_FOR_ATTENDED_TINY_LIVE', env.DEPLOYMENT_PROFILE, 'DETERMINISTIC'),
      insertVerdict: (v) => insertReadinessVerdict(sql, v),
      listPending: (kinds: Parameters<typeof listPendingControlRequests>[1], limit: number) => listPendingControlRequests(sql, kinds, limit),
      operatorRole: async (userId: Uuid) => {
        const [r] = await sql<{ role: 'operator' | 'admin' | 'viewer' }[]>`select role from ops.operators where user_id = ${userId} and disabled_at is null`;
        return r?.role ?? null;
      },
      stepUpVerified: stepUpVerifiedLazily(env, logger, shared),
      resolve: (id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant) => resolveControlRequest(sql, id, state, resolution, at),
    },
    binding,
    strategyClass: 'DETERMINISTIC',
    // Provider protection is off until the Trigger lifecycle row is green (ADR-0004): the verdict states MONITORED_EXIT-only through TRIGGER_LIFECYCLE = NOT_APPLICABLE.
    enabledCapabilities: ['LIVE_SIGNING'],
    policy: DEFAULT_READINESS_POLICY,
    reservePolicy: DEFAULT_WALLET_RESERVE_POLICY,
    presenceTimeoutMs: DEFAULT_SESSION_POLICY.presenceTimeoutMs,
    reconciliationMaxAgeMs: 5 * env.RECONCILIATION_INTERVAL_MS,
    clock: systemClock,
    logger,
    // M11 automated drills (§29, P10): executed here on an admin's EXECUTE_READINESS_DRILL, recorded with the transcript.
    drills: {
      CRITICAL_ALERT_DELIVERY: alertDeliveryDrill({
        senders: notificationSenders(env),
        policy: DEFAULT_NOTIFICATION_POLICY,
        clock: systemClock,
        newId: () => randomUUID() as Uuid,
        repo: {
          raise: (n) => raiseNotification(sql, n),
          recordDelivery: (d) => recordDelivery(sql, d),
          escalate: (id, level) => escalateNotification(sql, id, level),
          resolve: (alertClass, at) => resolveNotifications(sql, alertClass, at),
        },
      }),
      DB_DOWN_EMERGENCY_CLOSE: dbDownCloseDrill(drillExecutor, systemClock),
      PERSIST_BEFORE_SUBMIT_DRILL: persistBeforeSubmitDrill(drillExecutor, systemClock),
    },
  };
  logger.info('readiness_starting', { intervalMs, accountId: account.id, profile: env.DEPLOYMENT_PROFILE, strategy: tiny.versionId, releaseId: registered.id, releaseOutcome: registered.outcome, policyVersion: DEFAULT_READINESS_POLICY.version, holder: shared.holder });
  await loopUnderLease('readiness', intervalMs, logger, shared, async () => {
    await runReadinessCycle(deps);
  });
}

function notificationSenders(env: WorkerEnv): NotificationSender[] {
  return [
    inAppSender,
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? telegramSender({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }) : unconfiguredSender('TELEGRAM'),
    unconfiguredSender('EMAIL'),
    unconfiguredSender('PUSH'),
    unconfiguredSender('SMS'),
  ];
}

async function notificationsLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.NOTIFICATIONS_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('notifications_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  const { sql } = shared;
  const settlementMint = DEFAULT_ELIGIBILITY_POLICY.settlementMints[0] as MintAddress;
  const account = await ensurePaperAccount(sql, { id: randomUUID() as Uuid, name: `paper-${env.SOLANA_CLUSTER}`, cluster: env.SOLANA_CLUSTER, tradingWallet: env.PAPER_TRADING_WALLET, settlementMint });
  const executor = env.EXECUTION_SERVICE_URL && env.INTERNAL_API_SECRET ? new ExecutorClient({ baseUrl: env.EXECUTION_SERVICE_URL, secretHex: env.INTERNAL_API_SECRET, clock: systemClock, timeoutMs: 8_000 }) : null;
  const senders: NotificationSender[] = notificationSenders(env);
  const deps: NotificationsDeps = {
    repo: {
      facts: async () => {
        const [recon, chainHealth, projection, presence, recovery, feeds, sessions] = await Promise.all([
          latestReconciliation(sql, account.id),
          latestChainHealth(sql),
          loadLatestProjection(sql, account.id),
          latestPresence(sql, account.id),
          recoveryFacts(sql, account.id),
          blockingFeeds(sql),
          activeSessionCount(sql),
        ]);
        let executorHealth: { reachable: boolean; signerHealthy: boolean | null; detail: string | null } | null = null;
        if (executor) {
          try {
            const h = await executor.health();
            const signer = h['signer'] as { ok?: boolean; available?: boolean; healthy?: boolean; state?: string } | undefined;
            const signerHealthy = signer ? (typeof signer.ok === 'boolean' ? signer.ok : typeof signer.available === 'boolean' ? signer.available : typeof signer.healthy === 'boolean' ? signer.healthy : signer.state ? signer.state !== 'UNAVAILABLE' : null) : null;
            executorHealth = { reachable: true, signerHealthy, detail: signerHealthy === false ? JSON.stringify(signer).slice(0, 200) : null };
          } catch (err) {
            executorHealth = { reachable: false, signerHealthy: null, detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
          }
        }
        return {
          reconciliation: recon ? { status: recon.status, evaluatedAt: recon.evaluatedAt } : null,
          chainHealth,
          projection: projection ? { gasReserveLamports: projection.envelope.payload.gasReserveLamports, settlementAvailableBaseUnits: projection.envelope.payload.settlementAvailableBaseUnits } : null,
          presence: presence ? { attended: presence.attended, lastPresenceHeartbeatAt: presence.lastPresenceHeartbeatAt } : null,
          openPositions: recovery.openPositions,
          blockingFeeds: feeds,
          executor: executorHealth,
          sessionActive: sessions > 0,
        };
      },
      listOpen: () => listOpenNotifications(sql),
      raise: (n) => raiseNotification(sql, n),
      resolve: (alertClass: string, at: Instant) => resolveNotifications(sql, alertClass, at),
      deliveries: (ids: readonly Uuid[]) => deliveriesFor(sql, ids),
      recordDelivery: (d) => recordDelivery(sql, d),
      escalate: (id: Uuid, level: number) => escalateNotification(sql, id, level),
      applyDeadManPause: (input) => applyDeadManPause(sql, input),
      lastHeartbeatAt: () => lastHeartbeatAt(sql),
      listPending: (kinds: Parameters<typeof listPendingControlRequests>[1], limit: number) => listPendingControlRequests(sql, kinds, limit),
      operatorRole: async (userId: Uuid) => {
        const [r] = await sql<{ role: 'operator' | 'admin' | 'viewer' }[]>`select role from ops.operators where user_id = ${userId} and disabled_at is null`;
        return r?.role ?? null;
      },
      acknowledge: (id: Uuid, by: Uuid, at: Instant) => acknowledgeNotification(sql, id, by, at),
      resolveRequest: (id: Uuid, state: 'ACCEPTED' | 'REJECTED', resolution: Record<string, unknown>, at: Instant) => resolveControlRequest(sql, id, state, resolution, at),
    },
    senders,
    policy: DEFAULT_NOTIFICATION_POLICY,
    reservePolicy: DEFAULT_WALLET_RESERVE_POLICY,
    presenceTimeoutMs: DEFAULT_SESSION_POLICY.presenceTimeoutMs,
    clock: systemClock,
    logger,
  };
  const configured = senders.filter((x) => x.configured).map((x) => x.channel);
  if (configured.length < DEFAULT_NOTIFICATION_POLICY.criticalMinConfirmedChannels) logger.warn('critical_channels_insufficient', { configured, required: DEFAULT_NOTIFICATION_POLICY.criticalMinConfirmedChannels, hint: 'set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for an out-of-app channel' });
  logger.info('notifications_starting', { intervalMs, accountId: account.id, channels: configured, executorHealth: executor !== null, policyVersion: DEFAULT_NOTIFICATION_POLICY.version, holder: shared.holder });
  await loopUnderLease('notifications', intervalMs, logger, shared, async () => {
    await runNotificationsCycle(deps);
  });
}

/**
 * §15.10A: runs without a database lease on purpose. The shadow role must keep working while Postgres is
 * down, and the journal it writes is host-local, so one instance per host is the natural scope.
 */
async function shadowSyncLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.SHADOW_SYNC_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.error('shadow_sync_disabled', { reason: 'PAPER_TRADING_WALLET is not set' });
    return;
  }
  if (!env.SHADOW_JOURNAL_PATH) {
    logger.warn('roles_disabled', { roles: ['shadow-sync'], reason: 'SHADOW_JOURNAL_PATH not set' });
    return;
  }
  const { deps: monitor, account } = await positionMonitorDeps(env, logger, shared, env.PAPER_TRADING_WALLET, env.POSITION_MONITOR_INTERVAL_MS);
  const { sql } = shared;
  const executor = env.EXECUTION_SERVICE_URL && env.INTERNAL_API_SECRET ? new ExecutorClient({ baseUrl: env.EXECUTION_SERVICE_URL, secretHex: env.INTERNAL_API_SECRET, clock: systemClock, timeoutMs: 15_000 }) : null;
  const deps: ShadowSyncDeps = {
    repo: { positions: () => shadowPositions(sql, account.id) },
    journal: new FileShadowJournal(env.SHADOW_JOURNAL_PATH),
    executor,
    price: async (mint, quantity, decimals, now) => {
      const q = await monitor.exitQuote(mint, monitor.account.settlementMint, quantity, monitor.policy.maxSlippageBps, now);
      return q ? impliedPrice(q.expectedOutputAmount, monitor.account.settlementDecimals, quantity, decimals) : null;
    },
    settlementMints: [monitor.account.settlementMint],
    clock: systemClock,
    logger,
    config: { dbDownAfterFailures: 2 },
  };
  const state: ShadowSyncState = { consecutiveDbFailures: 0 };
  logger.info('shadow_sync_starting', { intervalMs, accountId: account.id, journal: env.SHADOW_JOURNAL_PATH, executor: executor !== null, holder: shared.holder });
  while (!shared.stopping()) {
    try {
      await runShadowSyncCycle(deps, state);
    } catch (err) {
      logger.error('shadow_sync_cycle_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Role journal-import (§15.10, §20.25): executor journal → audit ledger, with the operator review gate after a DB-outage emergency action. */
async function journalImportLoop(env: WorkerEnv, logger: Logger, shared: Shared): Promise<void> {
  const intervalMs = env.JOURNAL_IMPORT_INTERVAL_MS;
  if (!env.EXECUTION_SERVICE_URL || !env.INTERNAL_API_SECRET) {
    logger.warn('roles_disabled', { roles: ['journal-import'], reason: 'EXECUTION_SERVICE_URL / INTERNAL_API_SECRET not set' });
    return;
  }
  const { sql } = shared;
  const executor = new ExecutorClient({ baseUrl: env.EXECUTION_SERVICE_URL, secretHex: env.INTERNAL_API_SECRET, clock: systemClock, timeoutMs: 15_000 });
  const deps: JournalImportDeps = {
    repo: {
      lastImportedSequence: () => lastImportedJournalSequence(sql),
      importEntry: (entry) => importJournalEntry(sql, entry, shared.holder),
      emergencyCorrelationIds: () => importedEmergencyCorrelationIds(sql),
      insertEntryPauseOnce: (reason, ref) => insertEntryPauseOnce(sql, reason, 'WORKER', ref),
      openAlertExists: async (alertClass) => (await listOpenNotifications(sql)).some((n) => n.alertClass === alertClass),
      raise: (n) => raiseNotification(sql, { ...n, deadManDeadline: null }),
    },
    executor,
    clock: systemClock,
    logger,
    config: { batchSize: 200 },
  };
  logger.info('journal_import_starting', { intervalMs, holder: shared.holder });
  await loopUnderLease('journal-import', intervalMs, logger, shared, async () => {
    await runJournalImportCycle(deps);
  });
}

/** Role emergency-dry-run (§14.6, D33): unsigned build+simulate of each held / eligible asset's direct-pool exit; appends the verdict to its snapshot. */
async function emergencyDryRunLoop(env: WorkerEnv, logger: Logger, shared: Shared, rpc: SolanaRpcClient, rpcUrl: string): Promise<void> {
  const intervalMs = env.EMERGENCY_DRY_RUN_INTERVAL_MS;
  if (!env.PAPER_TRADING_WALLET) {
    logger.warn('roles_disabled', { roles: ['emergency-dry-run'], reason: 'PAPER_TRADING_WALLET not set' });
    return;
  }
  const { account } = await positionMonitorDeps(env, logger, shared, env.PAPER_TRADING_WALLET, env.POSITION_MONITOR_INTERVAL_MS);
  const { sql } = shared;
  const reader = new SimulationRpcClient({ url: rpcUrl, allowedOrigins: [new URL(rpcUrl).origin], label: 'worker-dry-run', timeoutMs: 20_000 });
  const deps: EmergencyDryRunDeps = {
    repo: {
      targets: (limit) => dryRunTargets(sql, account.id, limit),
      latestSnapshots: (ids) => latestEmergencySnapshots(sql, ids),
      insertSnapshot: (snapshot) => insertEmergencyRouteSnapshot(sql, snapshot),
    },
    reader,
    tradingWallet: env.PAPER_TRADING_WALLET,
    // §14.6 dry-run for an asset the wallet does not hold: simulate as the mint's largest holder with SOL for fees.
    standInPayer: async (mint) => {
      const largest = await rpc.getTokenLargestAccounts(mint);
      const addresses = largest.value.slice(0, 5).map((a) => a.address);
      if (addresses.length === 0) return null;
      const parsed = await rpc.getMultipleAccountsParsed(addresses);
      for (const [i, acc] of parsed.value.entries()) {
        const info = (acc?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed?.info;
        const tokenAccount = addresses[i];
        // program-owned authorities (pool vaults, PDAs) cannot pay fees or sign; only a real wallet with SOL stands in
        if (!info?.owner || !tokenAccount || !isOnCurve(base58Decode(info.owner))) continue;
        const balance = await rpc.getBalance(info.owner);
        // enough SOL to pay fees and, in simulation, the rent of a fresh settlement ATA (0.05 SOL)
        if (balance.value >= 50_000_000) return { owner: info.owner, tokenAccount };
      }
      return null;
    },
    policy: DEFAULT_EMERGENCY_ROUTE_POLICY,
    clock: systemClock,
    logger,
    config: {},
  };
  logger.info('emergency_dry_run_starting', { intervalMs, accountId: account.id, policyVersion: DEFAULT_EMERGENCY_ROUTE_POLICY.version, supported: DEFAULT_EMERGENCY_ROUTE_POLICY.supportedPrograms, rpcOrigin: new URL(rpcUrl).origin, holder: shared.holder });
  await loopUnderLease('emergency-dry-run', intervalMs, logger, shared, async () => {
    await runEmergencyDryRunCycle(deps);
  });
}
