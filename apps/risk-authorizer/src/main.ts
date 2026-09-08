import { randomUUID } from 'node:crypto';
import { DEFAULT_RISK_POLICY, getContractSetDigest, importSigningKeyPair, importVerificationKey, parseRiskAuthorizerEnv, systemClock, type Amount, type Bps, type Instant, type MintAddress, type Uuid, type VerificationKey } from '@sol-agent-trader/contracts';
import { createSql, listOpenAuthorizations, loadAccount, loadActionCycle, loadCandidateAsset, loadCustodyAccounts, loadLatestAttestation, loadLatestProjection, loadProposal, loadReleaseForStrategy, recordAuthorization, recordDenial, sessionEntryGate, type Sql } from '@sol-agent-trader/db/server';
import { redact, type Logger } from '@sol-agent-trader/observability';
import { initTelemetry } from '@sol-agent-trader/observability/server';
import { SolanaRpcClient } from '@sol-agent-trader/solana-hard-state';
import { close, isLoopback, listen, parseListen } from './api/http.js';
import { createAuthorizerApi } from './api/internal.js';
import { readIndependentChain, readMintHardState } from './chain/reads.js';
import { AuthorizerService } from './service/authorizer.js';

/**
 * risk-authorizer entrypoint (blueprint D21, D45, D52, §13.7, §15.5; GUARDRAILS Part 4).
 *
 * Isolated policy process: no LLM runtime, no provider-text ingestion, no wallet or signing
 * capability beyond its own Ed25519 authorization key. Reads immutable rows from Postgres and
 * chain truth from the allowlisted read-only RPC, recomputes the deterministic maximum with its
 * own ledger, and emits signed `RiskAuthorizedIntent` envelopes through an HMAC-authenticated
 * internal API. The environment is validated fail-closed first: a service-role key, signer
 * credential or LLM/provider key here is fatal. `--print-digest` prints the digest and exits.
 */
const SERVICE = 'risk-authorizer' as const;
const CONFIG = { projectionMaxAgeMs: 30_000, intentExpiryMs: 60_000, balanceToleranceBps: 10, maxSlotLag: 150 };

function issuesOf(err: unknown): unknown {
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues.map((i: { path?: unknown[]; message?: string }) => ({ path: (i.path ?? []).join('.'), message: i.message })) : String(err);
}

function fatal(event: string, fields: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event, ...(redact(fields) as Record<string, unknown>) }));
  process.exit(1);
}

async function main(): Promise<void> {
  const digest = await getContractSetDigest();
  if (process.argv.includes('--print-digest')) {
    console.log(JSON.stringify({ service: SERVICE, event: 'contract_digest', contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount }));
    return;
  }

  let env: ReturnType<typeof parseRiskAuthorizerEnv>;
  try {
    env = parseRiskAuthorizerEnv(process.env);
  } catch (err) {
    fatal('env_invalid', { issues: issuesOf(err) });
  }
  const telemetry = initTelemetry({ service: SERVICE, deploymentProfile: env.DEPLOYMENT_PROFILE, sentryDsn: env.SENTRY_DSN_RISK_AUTHORIZER, instanceId: env.SERVICE_INSTANCE_ID });
  const logger: Logger = telemetry.logger;
  const clock = systemClock;
  logger.info('startup', { contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount, cluster: env.SOLANA_CLUSTER, policyVersion: DEFAULT_RISK_POLICY.version });
  if (!env.INTERNAL_API_SECRETS || env.INTERNAL_API_SECRETS.length === 0) fatal('internal_api_secrets_missing', { hint: 'set INTERNAL_API_SECRETS (hex, ≥32 bytes) shared with the worker' });

  const signing = await importSigningKeyPair(env.RISK_AUTHORIZATION_KEY_PKCS8, env.RISK_AUTHORIZATION_PUBLIC_KEY);
  const projectionKeys: VerificationKey[] = await Promise.all(env.PROJECTION_VERIFICATION_PUBLIC_KEYS.map((k) => importVerificationKey(k)));
  const rpcUrl = env.SOLANA_RPC_ALLOWLIST[0];
  if (!rpcUrl) fatal('rpc_allowlist_empty');
  const rpc = new SolanaRpcClient({ url: rpcUrl, allowedOrigins: env.SOLANA_RPC_ALLOWLIST.map((u) => new URL(u).origin), nowMs: () => clock.nowMs() });
  const sql: Sql = createSql({ url: env.SUPABASE_DB_URL, applicationName: SERVICE, max: 4 });
  const actorRef = env.SERVICE_INSTANCE_ID ?? `${SERVICE}-${process.pid}`;

  const service = await AuthorizerService.create({
    sources: {
      cycle: (id) => loadActionCycle(sql, id),
      proposal: (id) => loadProposal(sql, id),
      candidateAsset: (id) => loadCandidateAsset(sql, id),
      account: (id) => loadAccount(sql, id),
      sessionGate: (accountId) => sessionEntryGate(sql, accountId),
      custodyAccounts: (accountId) => loadCustodyAccounts(sql, accountId),
      release: (v) => loadReleaseForStrategy(sql, v),
      attestation: (releaseId) => loadLatestAttestation(sql, releaseId),
      projection: (accountId) => loadLatestProjection(sql, accountId),
      chain: (wallet, settlementMint, custody) => readIndependentChain(rpc, wallet, settlementMint, custody),
      mint: (mint: MintAddress) => readMintHardState(rpc, mint, clock),
      // The authorizer holds no DEX client (GUARDRAILS Part 4): impact and price come from the worker's captured
      // reference probe once M7 wires it; until then the risk core sees "no quote" and sizes conservatively.
      referenceQuote: async () => null,
      openAuthorizations: () => listOpenAuthorizations(sql),
      persistAuthorization: (input) => recordAuthorization(sql, input),
      persistDenial: (denial) => recordDenial(sql, denial, actorRef),
    },
    signing,
    projectionKeys,
    trustedAttestationFingerprints: env.RELEASE_ATTESTATION_TRUST_FINGERPRINTS,
    policy: DEFAULT_RISK_POLICY,
    clock,
    logger,
    newId: () => randomUUID() as Uuid,
    config: CONFIG,
  });

  const api = createAuthorizerApi({ service, secretsHex: env.INTERNAL_API_SECRETS, clock, logger, contractSetDigest: digest.digest, signingKeyId: signing.keyId });
  const spec = parseListen(env.INTERNAL_API_LISTEN);
  if (!isLoopback(spec.host)) logger.warn('listener_not_loopback', { host: spec.host, hint: 'must be reachable only over the private control network (§15.8)' });
  const a = await listen(api, spec);
  logger.info('listening', { internal: a.url, signingKeyId: signing.keyId, rpc: new URL(rpcUrl).origin, maxPositionValueBaseUnits: DEFAULT_RISK_POLICY.maxPositionValueBaseUnits as Amount, maxSlippageBps: DEFAULT_RISK_POLICY.maxSlippageBps as Bps });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown', { signal, at: clock.now() as Instant });
    await close(api);
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
