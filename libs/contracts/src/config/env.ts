import { z } from 'zod';
import { Amount, Bps, Ed25519PublicKeyHex, KeyId, MintAddress, SolanaAddress, SolanaCluster, Sha256Hex } from '../primitives.js';
import { DeploymentProfile } from '../enums.js';

/**
 * Per-deployable environment schemas (blueprint §26.1 deployment secrets / trust roots, §26.2
 * executor guardrails). Pure parsers over a string record; each service calls its own parser at
 * startup and refuses to boot on failure.
 *
 * Trust separation is encoded as *absence*: a service schema rejects the presence of a credential
 * it must never hold, so a misconfigured environment fails closed rather than silently widening a
 * boundary (GUARDRAILS Part 4 Credentials).
 */

const Url = z.url();
const NonEmpty = z.string().min(1);
const Pkcs8Hex = z.string().regex(/^[0-9a-f]+$/).min(64);

/** Comma-separated list of `inner` values (trimmed, empties dropped). */
function Csv<T extends z.ZodType>(inner: T) {
  return z.string().transform((s, ctx): z.output<T>[] => {
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    const r = z.array(inner).safeParse(parts);
    if (!r.success) {
      for (const issue of r.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path as (string | number)[] });
      return z.NEVER;
    }
    return r.data as z.output<T>[];
  });
}

/** Names that only one service may ever see. Used by every other service's schema to fail closed. */
export const EXCLUSIVE_CREDENTIALS = {
  serviceRole: 'SUPABASE_SERVICE_ROLE_KEY',
  projectionSigningKey: 'PROJECTION_SIGNING_KEY_PKCS8',
  riskAuthorizationKey: 'RISK_AUTHORIZATION_KEY_PKCS8',
  signerCredential: 'TURNKEY_API_PRIVATE_KEY',
  signerCredentialPublic: 'TURNKEY_API_PUBLIC_KEY',
  emergencyOperatorPrivateKey: 'EMERGENCY_OPERATOR_KEY_PKCS8',
  /** Throwaway development signer key; execution-service only, never with live capability on mainnet (D47). */
  softwareSignerKey: 'SOFTWARE_SIGNER_KEY_PKCS8',
} as const;

function forbiddenIssues(env: Record<string, unknown>, names: readonly string[], service: string): z.core.$ZodIssue[] {
  const issues: z.core.$ZodIssue[] = [];
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== '') {
      issues.push({ code: 'custom', message: `${service} must never hold ${name}`, path: [name] });
    }
  }
  return issues;
}

/**
 * Parse a service environment. Forbidden credentials are reported first and regardless of whether
 * the required ones are present (review R2-02): an environment that is both incomplete and carries
 * a foreign credential names the credential, never its value.
 */
function parseService<T extends z.ZodType>(schema: T, forbidden: readonly string[], service: string, env: Record<string, string | undefined>): z.output<T> {
  const issues = forbiddenIssues(env, forbidden, service);
  const r = schema.safeParse(env);
  if (!r.success) issues.push(...r.error.issues);
  if (issues.length > 0) throw new z.ZodError(issues);
  return r.data as z.output<T>;
}

const Common = z.looseObject({
  DEPLOYMENT_PROFILE: DeploymentProfile,
  SOLANA_CLUSTER: SolanaCluster,
  SERVICE_INSTANCE_ID: NonEmpty.optional(),
});

// --- web ------------------------------------------------------------------------------------------

export const WebEnv = Common.extend({
  NEXT_PUBLIC_SUPABASE_URL: Url,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: NonEmpty,
  SENTRY_DSN_WEB: Url.optional(),
});

export function parseWebEnv(env: Record<string, string | undefined>) {
  return parseService(
    WebEnv,
    [
      EXCLUSIVE_CREDENTIALS.serviceRole,
      EXCLUSIVE_CREDENTIALS.projectionSigningKey,
      EXCLUSIVE_CREDENTIALS.riskAuthorizationKey,
      EXCLUSIVE_CREDENTIALS.signerCredential,
      EXCLUSIVE_CREDENTIALS.signerCredentialPublic,
      EXCLUSIVE_CREDENTIALS.emergencyOperatorPrivateKey,
      EXCLUSIVE_CREDENTIALS.softwareSignerKey,
      'SUPABASE_DB_URL',
      'DATABASE_URL',
    ],
    'web',
    env,
  );
}

// --- worker ---------------------------------------------------------------------------------------

export const WorkerEnv = Common.extend({
  SUPABASE_URL: Url,
  SUPABASE_SERVICE_ROLE_KEY: NonEmpty,
  SUPABASE_DB_URL: NonEmpty,
  PROJECTION_SIGNING_KEY_PKCS8: Pkcs8Hex,
  PROJECTION_SIGNING_PUBLIC_KEY: Ed25519PublicKeyHex,
  EMERGENCY_OPERATOR_PUBLIC_KEYS: Csv(Ed25519PublicKeyHex),
  SENTRY_DSN_WORKER: Url.optional(),
  /** Executor internal API (§15.8); absent in paper-only profiles. */
  EXECUTION_SERVICE_URL: Url.optional(),
  INTERNAL_API_SECRET: z.string().regex(/^[0-9a-f]{64,}$/).optional(),
  // Market-data providers (M4). Absent key = that provider's roles stay disabled and report FAILED.
  BIRDEYE_API_KEY: NonEmpty.optional(),
  BIRDEYE_TIER: z.enum(['STANDARD', 'LITE', 'STARTER', 'PREMIUM', 'BUSINESS']).default('STANDARD'),
  JUPITER_API_KEY: NonEmpty.optional(),
  /** Requests per second the Jupiter plan allows (free keys are throttled hard by the API gateway; 1 is safe). */
  JUPITER_REQUESTS_PER_SECOND: z.coerce.number().positive().max(100).default(1),
  /** Read-only Solana RPC for chain-truth reads (D45). The worker never signs; this is the only endpoint it may call. */
  SOLANA_RPC_URL: Url.optional(),
  /** Helius Parsed Events for movement parsing (§3.2). Absent = signatures on the trading wallet cannot be explained and reconciliation pauses entries. */
  HELIUS_API_KEY: NonEmpty.optional(),
  /** Comma-separated worker roles to run; empty = start, report, exit (skeleton). */
  WORKER_ROLES: z.string().default(''),
  ELIGIBILITY_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
  /** §7.4 periodic refresh: re-evaluate DISCOVERED/EVALUATING/ELIGIBLE assets older than this. */
  ELIGIBILITY_REEVALUATE_AFTER_MS: z.coerce.number().int().min(60_000).max(7 * 86_400_000).default(6 * 3_600_000),
  /** BLOCKED assets come back on this slower cadence; only RETIRED is final. */
  ELIGIBILITY_BLOCKED_REEVALUATE_AFTER_MS: z.coerce.number().int().min(60_000).max(30 * 86_400_000).default(24 * 3_600_000),
  /** Held-asset safety revalidation cadence (§7.5); short because a CRITICAL_EXIT must be seen quickly. */
  HELD_ASSET_SAFETY_INTERVAL_MS: z.coerce.number().int().min(10_000).max(900_000).default(60_000),
  /** Chain/custody reconciliation cadence (D9); an unknown movement pauses new entries within one interval. */
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(10_000).max(900_000).default(60_000),
  /** Feature-snapshot cadence (§6.8); one snapshot per tracked asset per closed minute at most. */
  FEATURES_INTERVAL_MS: z.coerce.number().int().min(15_000).max(900_000).default(60_000),
  /** Candidate scan cadence (§9.1, §9.7). */
  CANDIDATES_INTERVAL_MS: z.coerce.number().int().min(15_000).max(900_000).default(60_000),
  /** Paper book (§17): the account's wallet identifier (quotes and attribution only, never custody), starting settlement capital, entry cadence. */
  PAPER_TRADING_WALLET: SolanaAddress.optional(),
  PAPER_STARTING_CAPITAL_BASE_UNITS: Amount.default('10000000000' as never),
  PAPER_ENTRY_INTERVAL_MS: z.coerce.number().int().min(15_000).max(900_000).default(60_000),
  /** Runtime session tick (D60–D63): control requests, cold-start gates, presence, wind-down. */
  SESSION_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),
  /** D62 schedule-driven start of the PAPER session when no operator request is pending; never applies to live authority. */
  SESSION_AUTOSTART: z.enum(['true', 'false']).default('false'),
  /** MONITORED_EXIT cadence (§13.4–13.5): executable marks and deterministic exits for open paper positions. */
  POSITION_MONITOR_INTERVAL_MS: z.coerce.number().int().min(10_000).max(900_000).default(30_000),
  /** S0 decision cadence (§12.1): RAW and SAFE action cycles over new candidates. */
  S0_INTERVAL_MS: z.coerce.number().int().min(15_000).max(900_000).default(60_000),
  /** Git commit of the running build, recorded on strategy versions it registers (§6.21). */
  GIT_SHA: z.string().regex(/^[0-9a-f]{7,40}$/).default('0000000'),
  /** Tracked-wallet polling cadence (§3.2); webhooks replace polling once a public receiver exists. */
  TRACKED_WALLETS_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(120_000),
  MARKET_INGEST_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
});

export function parseWorkerEnv(env: Record<string, string | undefined>) {
  return parseService(
    WorkerEnv,
    [
      EXCLUSIVE_CREDENTIALS.riskAuthorizationKey,
      EXCLUSIVE_CREDENTIALS.signerCredential,
      EXCLUSIVE_CREDENTIALS.signerCredentialPublic,
      EXCLUSIVE_CREDENTIALS.emergencyOperatorPrivateKey,
      EXCLUSIVE_CREDENTIALS.softwareSignerKey,
    ],
    'worker',
    env,
  );
}

// --- risk-authorizer ------------------------------------------------------------------------------

export const RiskAuthorizerEnv = Common.extend({
  SUPABASE_DB_URL: NonEmpty,
  RISK_AUTHORIZATION_KEY_PKCS8: Pkcs8Hex,
  RISK_AUTHORIZATION_PUBLIC_KEY: Ed25519PublicKeyHex,
  PROJECTION_VERIFICATION_PUBLIC_KEYS: Csv(Ed25519PublicKeyHex),
  RELEASE_ATTESTATION_TRUST_FINGERPRINTS: Csv(Sha256Hex),
  SOLANA_RPC_ALLOWLIST: Csv(Url),
  SENTRY_DSN_RISK_AUTHORIZER: Url.optional(),
  /** host:port for the worker-facing authorize API (§15.8). Loopback or private network only. */
  INTERNAL_API_LISTEN: z.string().regex(/^.*:\d{1,5}$/).default('127.0.0.1:8781'),
  /** Shared HMAC secrets (hex, ≥32 bytes each); required to serve. */
  INTERNAL_API_SECRETS: Csv(z.string().regex(/^[0-9a-f]{64,}$/)).optional(),
});

export function parseRiskAuthorizerEnv(env: Record<string, string | undefined>) {
  return parseService(
    RiskAuthorizerEnv,
    [
      EXCLUSIVE_CREDENTIALS.serviceRole,
      EXCLUSIVE_CREDENTIALS.projectionSigningKey,
      EXCLUSIVE_CREDENTIALS.signerCredential,
      EXCLUSIVE_CREDENTIALS.signerCredentialPublic,
      EXCLUSIVE_CREDENTIALS.emergencyOperatorPrivateKey,
      EXCLUSIVE_CREDENTIALS.softwareSignerKey,
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'BIRDEYE_API_KEY',
      'LUNARCRUSH_API_KEY',
      'CRYPTOPANIC_API_KEY',
    ],
    'risk-authorizer',
    env,
  );
}

// --- execution-service (§26.2 absolute guardrails live here, never in the database) --------------

export const ExecutorGuardrails = z.strictObject({
  liveCapabilityEnabled: z.boolean(),
  cluster: SolanaCluster,
  tradingWalletAddress: SolanaAddress,
  allowedSettlementMints: z.array(MintAddress).min(1),
  allowedFundingMints: z.array(MintAddress).min(1),
  maxPerEntryNotionalBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  maxAggregateNonSettlementExposureBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  maxSignerOutageUnprotectedExposureBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  maxEmergencyCloseTxBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  hardMaxSlippageBps: Bps,
  hardMaxProtectiveSlippageBps: Bps,
  acceptedRiskAuthorizerKeyIds: z.array(KeyId).min(1),
  acceptedEmergencyOperatorKeyIds: z.array(KeyId).min(1),
  expectedSignerPolicyDigest: Sha256Hex.nullable(),
  expectedSignerWorkloadFingerprint: z.string().nullable(),
});
export type ExecutorGuardrails = z.infer<typeof ExecutorGuardrails>;

export const ExecutionServiceEnv = Common.extend({
  SUPABASE_DB_URL: NonEmpty,
  EXECUTOR_GUARDRAILS_JSON: z.string().transform((s, ctx) => {
    try {
      return ExecutorGuardrails.parse(JSON.parse(s));
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `EXECUTOR_GUARDRAILS_JSON invalid: ${e instanceof Error ? e.message : String(e)}` });
      return z.NEVER;
    }
  }),
  RISK_AUTHORIZER_PUBLIC_KEYS: Csv(Ed25519PublicKeyHex),
  EMERGENCY_OPERATOR_PUBLIC_KEYS: Csv(Ed25519PublicKeyHex),
  SOLANA_RPC_PRIMARY: Url,
  SOLANA_RPC_SIMULATION: Url,
  SIGNER_BACKEND: z.enum(['SOFTWARE_DEV', 'TURNKEY']),
  TURNKEY_ORGANIZATION_ID: NonEmpty.optional(),
  TURNKEY_API_PUBLIC_KEY: NonEmpty.optional(),
  TURNKEY_API_PRIVATE_KEY: NonEmpty.optional(),
  TURNKEY_WALLET_ADDRESS: SolanaAddress.optional(),
  EXECUTOR_JOURNAL_PATH: NonEmpty,
  SENTRY_DSN_EXECUTION_SERVICE: Url.optional(),
  /** host:port for the worker-facing internal API (§15.8). Loopback or private network only. */
  INTERNAL_API_LISTEN: z.string().regex(/^.*:d{1,5}$/).default('127.0.0.1:8791'),
  /** Shared HMAC secrets (hex, ≥32 bytes each) accepted on the internal API; several allow rotation. Required to serve. */
  INTERNAL_API_SECRETS: Csv(z.string().regex(/^[0-9a-f]{64,}$/)).optional(),
  /** host:port for the out-of-band operator endpoint (D25 plane 1); a separate listener from the internal API. */
  OUT_OF_BAND_LISTEN: z.string().regex(/^.*:d{1,5}$/).default('127.0.0.1:8792'),
  /** Required when SIGNER_BACKEND=SOFTWARE_DEV; refused elsewhere. */
  SOFTWARE_SIGNER_KEY_PKCS8: Pkcs8Hex.optional(),
  JUPITER_API_KEY: NonEmpty.optional(),
  JUPITER_REQUESTS_PER_SECOND: z.coerce.number().positive().max(100).default(1),
});

const ExecutionServiceEnvChecked = ExecutionServiceEnv.superRefine((v, ctx) => {
  // D47: a software signer can never be selected where live capability is enabled on mainnet.
  if (v.SIGNER_BACKEND === 'SOFTWARE_DEV' && v.EXECUTOR_GUARDRAILS_JSON.liveCapabilityEnabled && v.EXECUTOR_GUARDRAILS_JSON.cluster === 'mainnet-beta') {
    ctx.addIssue({ code: 'custom', message: 'SOFTWARE_DEV signer cannot be combined with live capability on mainnet-beta (D47)', path: ['SIGNER_BACKEND'] });
  }
  if (v.SIGNER_BACKEND === 'TURNKEY' && !(v.TURNKEY_ORGANIZATION_ID && v.TURNKEY_API_PUBLIC_KEY && v.TURNKEY_API_PRIVATE_KEY && v.TURNKEY_WALLET_ADDRESS)) {
    ctx.addIssue({ code: 'custom', message: 'TURNKEY signer requires organization id, API key pair and wallet address', path: ['SIGNER_BACKEND'] });
  }
});

export function parseExecutionServiceEnv(env: Record<string, string | undefined>) {
  return parseService(
    ExecutionServiceEnvChecked,
    [
      EXCLUSIVE_CREDENTIALS.serviceRole,
      EXCLUSIVE_CREDENTIALS.projectionSigningKey,
      EXCLUSIVE_CREDENTIALS.riskAuthorizationKey,
      EXCLUSIVE_CREDENTIALS.emergencyOperatorPrivateKey,
      EXCLUSIVE_CREDENTIALS.softwareSignerKey,
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'LUNARCRUSH_API_KEY',
      'CRYPTOPANIC_API_KEY',
    ],
    'execution-service',
    env,
  );
}
