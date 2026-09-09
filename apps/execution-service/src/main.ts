import { hostname } from 'node:os';
import { DEFAULT_CHAIN_HEALTH_POLICY, getContractSetDigest, importVerificationKey, parseExecutionServiceEnv, systemClock, type Bps, type Instant, type TradingWalletSigner, type Uuid, type VerificationKey } from '@sol-agent-trader/contracts';
import { RpcTransactionSubmitter } from '@sol-agent-trader/execution';
import { DEFAULT_EMERGENCY_ROUTE_POLICY, type DirectPoolHop } from '@sol-agent-trader/contracts';
import { advanceAttemptFinality, createSql, decisionQuoteForCycle, executorModeFacts, latestEmergencyRouteForMint, loadApprovalGrant, loadTradeIntent, persistExecution, type Sql } from '@sol-agent-trader/db/server';
import { BASE_PROGRAMS, JUPITER_V6_PROGRAM, JupiterOrderHttpClient, JupiterSwapClient, RpcChainObserver, RpcCustodyReader, SimulationRpcClient, SoftwareDevSigner, TurnkeySigner, type DetailedExecution } from '@sol-agent-trader/execution';
import { redact, type Logger } from '@sol-agent-trader/observability';
import { initTelemetry } from '@sol-agent-trader/observability/server';
import { SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import { randomUUID } from 'node:crypto';
import { close, isLoopback, listen, parseListen } from './api/http.js';
import { createInternalApi } from './api/internal.js';
import { createOutOfBandApi } from './api/out-of-band.js';
import { ExecutorJournal, FencingError, JournalCorruptError } from './journal/journal.js';
import { ExecutorPipeline } from './pipeline/pipeline.js';
import type { ModeFacts } from './authority/mode-gate.js';

/**
 * execution-service entrypoint (blueprint §15, §21.3, D10, D12, D22, D25, D47).
 *
 * The only application process allowed to originate a normal autonomous signing request.
 * Startup order is deliberate: validate the environment fail-closed → build the signer and
 * refuse a wallet mismatch → open the fenced journal → recover every unresolved attempt from
 * chain truth → only then listen. Two listeners: the worker-facing internal API (HMAC, replay
 * protected) and the out-of-band operator endpoint (pinned-key signed commands, no database).
 * `--print-digest` prints the contract digest and exits without touching the environment.
 */
const SERVICE = 'execution-service' as const;

/** Deployment-local emergency close policy (D22). Slippage is further capped by the guardrails' protective ceiling. */
const EMERGENCY_CLOSE_POLICY = { slippageBps: 200 as Bps, maxPriceImpactBps: 500 as Bps, maxQuoteAgeMs: 15_000, validityMs: 60_000 };
/** How long a directly submitted emergency transaction may take to reach `confirmed` before it is left to recovery. */
const CONFIRM_BUDGET_MS = 45_000;
/** Last route seen per mint, so a database outage does not take the fallback with it (§15.10). */
const routeCache = new Map<string, DirectPoolHop>();
/** Fees, priority and one ATA rent the swap shape may debit from the wallet (0.02 SOL). */
const MAX_SOL_DEBIT_LAMPORTS = 20_000_000n;
const FINALITY_POLL_MS = 2_000;
const FINALITY_BUDGET_MS = 90_000;

function issuesOf(err: unknown): unknown {
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues.map((i: { path?: unknown[]; message?: string }) => ({ path: (i.path ?? []).join('.'), message: i.message })) : String(err);
}

function fatal(event: string, fields: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event, ...redact(fields) as Record<string, unknown> }));
  process.exit(1);
}

async function main(): Promise<void> {
  const digest = await getContractSetDigest();
  if (process.argv.includes('--print-digest')) {
    console.log(JSON.stringify({ service: SERVICE, event: 'contract_digest', contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount }));
    return;
  }

  let env: ReturnType<typeof parseExecutionServiceEnv>;
  try {
    env = parseExecutionServiceEnv(process.env);
  } catch (err) {
    fatal('env_invalid', { issues: issuesOf(err) });
  }
  const telemetry = initTelemetry({ service: SERVICE, deploymentProfile: env.DEPLOYMENT_PROFILE, sentryDsn: env.SENTRY_DSN_EXECUTION_SERVICE, instanceId: env.SERVICE_INSTANCE_ID });
  const logger: Logger = telemetry.logger;
  const guardrails = env.EXECUTOR_GUARDRAILS_JSON;
  const clock = systemClock;
  logger.info('startup', { contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount, cluster: env.SOLANA_CLUSTER, liveCapabilityEnabled: guardrails.liveCapabilityEnabled, signerBackend: env.SIGNER_BACKEND });

  if (!env.INTERNAL_API_SECRETS || env.INTERNAL_API_SECRETS.length === 0) fatal('internal_api_secrets_missing', { hint: 'set INTERNAL_API_SECRETS (hex, ≥32 bytes) shared with the worker' });
  if (guardrails.cluster !== env.SOLANA_CLUSTER) fatal('cluster_mismatch', { guardrails: guardrails.cluster, env: env.SOLANA_CLUSTER });

  // Signer (D47, D55, ADR-0008). SOFTWARE_DEV holds a throwaway key and can never serve live
  // capability on mainnet; TURNKEY holds a non-exportable identity behind the pinned policy layer,
  // which the adapter also mirrors locally so a denied shape never reaches the provider.
  let signer: TradingWalletSigner;
  if (env.SIGNER_BACKEND === 'SOFTWARE_DEV') {
    if (!env.SOFTWARE_SIGNER_KEY_PKCS8) fatal('software_signer_key_missing');
    signer = new SoftwareDevSigner({ privateKeyPkcs8Hex: env.SOFTWARE_SIGNER_KEY_PKCS8, cluster: guardrails.cluster, liveCapabilityEnabled: guardrails.liveCapabilityEnabled, clock });
  } else {
    // The env schema already refuses TURNKEY without the organization, key pair, wallet and policy.
    const base = env.TURNKEY_API_BASE_URL.replace(/\/+$/, '');
    signer = new TurnkeySigner({
      organizationId: env.TURNKEY_ORGANIZATION_ID!,
      signWith: env.TURNKEY_WALLET_ADDRESS!,
      apiPublicKeyHex: env.TURNKEY_API_PUBLIC_KEY!,
      apiPrivateKeyHex: env.TURNKEY_API_PRIVATE_KEY!,
      policy: env.SIGNER_POLICY_JSON!,
      cluster: guardrails.cluster,
      clock,
      transport: async ({ path, body, stamp }) => {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Stamp': stamp }, body });
        return { status: res.status, body: await res.text() };
      },
    });
    const digest = await (signer as TurnkeySigner).policyDigest();
    logger.info('signer_policy_pinned', { backend: 'TURNKEY', policyVersion: env.SIGNER_POLICY_JSON!.version, policyDigest: digest, wallet: env.TURNKEY_WALLET_ADDRESS });
  }
  if (signer.publicKey !== guardrails.tradingWalletAddress) fatal('signer_wallet_mismatch', { signer: signer.publicKey, guardrails: guardrails.tradingWalletAddress });

  const authorizerKeys: VerificationKey[] = await Promise.all(env.RISK_AUTHORIZER_PUBLIC_KEYS.map((k) => importVerificationKey(k)));
  const emergencyOperatorKeys: VerificationKey[] = await Promise.all(env.EMERGENCY_OPERATOR_PUBLIC_KEYS.map((k) => importVerificationKey(k)));
  const approverKeys: VerificationKey[] = await Promise.all((env.APPROVAL_PUBLIC_KEYS ?? []).map((k) => importVerificationKey(k)));
  const unpinned = guardrails.acceptedRiskAuthorizerKeyIds.filter((id) => !authorizerKeys.some((k) => k.keyId === id));
  if (unpinned.length) logger.warn('accepted_authorizer_key_without_public_key', { keyIds: unpinned });

  const primaryOrigin = new URL(env.SOLANA_RPC_PRIMARY).origin;
  const simulationOrigin = new URL(env.SOLANA_RPC_SIMULATION).origin;
  if (primaryOrigin === simulationOrigin) logger.warn('simulation_rpc_not_independent', { origin: primaryOrigin });
  const rpc = new SolanaRpcClient({ url: env.SOLANA_RPC_PRIMARY, allowedOrigins: [primaryOrigin], nowMs: () => clock.nowMs() });
  const chain = new RpcChainObserver({ url: env.SOLANA_RPC_PRIMARY, allowedOrigins: [primaryOrigin], label: 'primary' });
  // §14.7: a second independent view for staged finality; without it divergence cannot be observed and REORG_PENDING rests on one node.
  let secondaryChains: RpcChainObserver[] = [];
  if (env.SOLANA_RPC_SECONDARY) {
    const secondaryOrigin = new URL(env.SOLANA_RPC_SECONDARY).origin;
    if (secondaryOrigin === primaryOrigin) logger.warn('secondary_rpc_not_independent', { origin: secondaryOrigin });
    else secondaryChains = [new RpcChainObserver({ url: env.SOLANA_RPC_SECONDARY, allowedOrigins: [secondaryOrigin], label: 'secondary' })];
  } else logger.warn('finality_single_view', { effect: 'cross-RPC divergence cannot be detected; set SOLANA_RPC_SECONDARY' });
  const simulation = new SimulationRpcClient({ url: env.SOLANA_RPC_SIMULATION, allowedOrigins: [simulationOrigin], label: 'simulation' });
  const custody = new RpcCustodyReader(rpc);
  const orders = new JupiterOrderHttpClient({ apiKey: env.JUPITER_API_KEY, clock });
  const quotes = new JupiterSwapClient({ clock, apiKey: env.JUPITER_API_KEY, requestsPerSecond: env.JUPITER_REQUESTS_PER_SECOND });
  const sql: Sql = createSql({ url: env.SUPABASE_DB_URL, applicationName: SERVICE, max: 4 });

  const holder = env.SERVICE_INSTANCE_ID ?? `${hostname()}-${process.pid}`;
  let journal: ExecutorJournal;
  try {
    journal = await ExecutorJournal.open(env.EXECUTOR_JOURNAL_PATH, holder, () => clock.now());
  } catch (err) {
    if (err instanceof FencingError) fatal('journal_fenced', { holder: err.holder, attempted: err.attempted, hint: 'another executor holds the journal; release it out of band before starting a second instance' });
    if (err instanceof JournalCorruptError) fatal('journal_corrupt', { error: err.message });
    throw err;
  }

  const modeFacts = async (): Promise<ModeFacts> => {
    try {
      const m = await executorModeFacts(sql);
      return { activity: m.activity, authority: m.authority, paused: m.paused, localPause: false, liveCapabilityEnabled: guardrails.liveCapabilityEnabled };
    } catch (err) {
      // Postgres unavailable: new entries stop; risk reduction is never gated (D22).
      logger.error('mode_facts_unavailable', { error: err instanceof Error ? err.message : String(err) });
      return { activity: 'OFF', authority: 'OBSERVE', paused: true, localPause: false, liveCapabilityEnabled: guardrails.liveCapabilityEnabled };
    }
  };

  const awaitFinalized = async (signature: string): Promise<{ slot: number } | null> => {
    const deadline = clock.nowMs() + FINALITY_BUDGET_MS;
    while (clock.nowMs() < deadline) {
      const s = await chain.signatureStatus(signature).catch(() => null);
      if (s && s.err === null && s.confirmationStatus === 'finalized') return { slot: s.slot };
      if (s && s.err !== null) return null;
      await new Promise((r) => setTimeout(r, FINALITY_POLL_MS));
    }
    return null;
  };

  const pipeline = new ExecutorPipeline({
    journal, guardrails, authorizerKeys, approverKeys, emergencyOperatorKeys, signer, chain, custody, clock, newId: () => randomUUID() as Uuid,
    modeFacts,
    emergency: EMERGENCY_CLOSE_POLICY,
    // §14.6 / D33: provider-independent emergency exit over the primary RPC; routes come from the persisted snapshots and stay cached for a database outage.
    directPool: {
      submitter: new RpcTransactionSubmitter({ url: env.SOLANA_RPC_PRIMARY, allowedOrigins: [primaryOrigin], label: 'primary' }),
      routes: async (mint) => {
        try {
          const s = await latestEmergencyRouteForMint(sql, mint);
          const hop = s?.hops[0] ?? null;
          if (hop) routeCache.set(mint, hop);
          return hop ?? routeCache.get(mint) ?? null;
        } catch (err) {
          logger.error('emergency_route_read_failed', { mint, error: err instanceof Error ? err.message : String(err), cached: routeCache.has(mint) });
          return routeCache.get(mint) ?? null;
        }
      },
      policy: DEFAULT_EMERGENCY_ROUTE_POLICY,
      awaitConfirmed: async (signature) => {
        const deadline = clock.nowMs() + CONFIRM_BUDGET_MS;
        while (clock.nowMs() < deadline) {
          const s = await chain.signatureStatus(signature).catch(() => null);
          if (s && s.err === null && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { slot: s.slot };
          if (s && s.err !== null) return null;
          await new Promise((r) => setTimeout(r, FINALITY_POLL_MS));
        }
        return null;
      },
    },
    adapter: {
      orders, quotes, simulation, cluster: guardrails.cluster,
      structure: { allowedPrograms: [...BASE_PROGRAMS, JUPITER_V6_PROGRAM], allowLookupTables: true, allowedTransferRecipients: [] },
      maxSolDebitLamports: MAX_SOL_DEBIT_LAMPORTS,
      decisionQuote: async (intent) => {
        try {
          return await decisionQuoteForCycle(sql, intent.actionCycleId);
        } catch (err) {
          logger.error('decision_quote_unavailable', { intentId: intent.id, error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      },
    },
    awaitFinalized,
    maxSkewMs: 5_000,
    secondaryChains,
    signatureGraceSlots: DEFAULT_CHAIN_HEALTH_POLICY.signatureGraceSlots,
    persistFinality: async (u) => {
      const r = await advanceAttemptFinality(sql, u);
      await journal.append('RECONCILED_INTO_DB', u.intentId, { attemptId: r.attemptId, state: u.state, tracked: true, fillPromoted: r.fillPromoted });
      if (!r.attemptId) logger.warn('finality_row_not_found', { intentId: u.intentId, state: u.state });
    },
  });

  // §21.3: reconcile every signed or submitted attempt before accepting new work.
  const recovered = await pipeline.recover();
  logger.info('recovery_complete', { resolved: recovered.length, resolutions: recovered.map((r) => ({ correlationId: r.correlationId, resolution: r.resolution })), localPause: pipeline.localPause });
  if (recovered.some((r) => r.resolution === 'STILL_LANDABLE')) logger.warn('unresolved_attempts_still_landable', { count: recovered.filter((r) => r.resolution === 'STILL_LANDABLE').length });

  const persist = async (execution: DetailedExecution, lifecycle: 'COMPLETED' | 'FAILED' | 'EXECUTING'): Promise<void> => {
    try {
      await persistExecution(sql, execution.order, execution.attempt, execution.fill, lifecycle);
      await journal.append('RECONCILED_INTO_DB', execution.attempt.intentId, { attemptId: execution.attempt.id, state: execution.attempt.state, lifecycle });
    } catch (err) {
      logger.error('persist_execution_failed', { intentId: execution.attempt.intentId, attemptId: execution.attempt.id, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const internal = createInternalApi({
    pipeline, secretsHex: env.INTERNAL_API_SECRETS, clock, logger, contractSetDigest: digest.digest,
    loadIntent: (id) => loadTradeIntent(sql, id),
    loadApproval: (id) => loadApprovalGrant(sql, id),
    signerHealth: () => signer.health(),
    persist,
  });
  const outOfBand = createOutOfBandApi({ pipeline, clock, logger });
  const internalSpec = parseListen(env.INTERNAL_API_LISTEN);
  const oobSpec = parseListen(env.OUT_OF_BAND_LISTEN);
  for (const [name, spec] of [['internal', internalSpec], ['out-of-band', oobSpec]] as const) if (!isLoopback(spec.host)) logger.warn('listener_not_loopback', { listener: name, host: spec.host, hint: 'must be reachable only over the private control network (§15.8)' });
  const a = await listen(internal, internalSpec);
  const b = await listen(outOfBand, oobSpec);
  logger.info('listening', { internal: a.url, outOfBand: b.url, wallet: signer.publicKey, journal: env.EXECUTOR_JOURNAL_PATH, holder });

  // §14.7 staged finality: every open attempt is re-read from the chain views between submissions.
  let tracking = false;
  const track = async (): Promise<void> => {
    if (tracking) return;
    tracking = true;
    try {
      const updates = await pipeline.trackFinality();
      if (updates.length) logger.info('finality_tracked', { updates, localPause: pipeline.localPause });
    } catch (err) {
      logger.error('finality_tracker_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      tracking = false;
    }
  };
  const finalityTimer = setInterval(() => void track(), env.FINALITY_TRACK_INTERVAL_MS);
  logger.info('finality_tracker_starting', { intervalMs: env.FINALITY_TRACK_INTERVAL_MS, views: 1 + secondaryChains.length });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown', { signal, at: clock.now() as Instant });
    clearInterval(finalityTimer);
    await close(internal);
    await close(outOfBand);
    journal.release();
    await sql.end({ timeout: 5 });
    await telemetry.shutdown();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
