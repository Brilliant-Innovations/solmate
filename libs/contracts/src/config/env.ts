import { z } from 'zod';
import { SignerTransactionPolicy } from '../policy/signer-policy.js';
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
  /** LIVE_APPROVAL grant signing key: worker approvals role only; the executor pins the public key (§15.6). */
  approvalSigningKey: 'APPROVAL_SIGNING_KEY_PKCS8',
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
      EXCLUSIVE_CREDENTIALS.approvalSigningKey,
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
  /** Risk-authorizer internal API (§15.5) and its verification keys, for the live-entry and approvals roles (M7). */
  RISK_AUTHORIZER_URL: Url.optional(),
  RISK_AUTHORIZER_PUBLIC_KEYS: Csv(Ed25519PublicKeyHex).optional(),
  /** LIVE_APPROVAL grant signing key (worker-exclusive, §15.6); absent = the approvals role is disabled. */
  APPROVAL_SIGNING_KEY_PKCS8: Pkcs8Hex.optional(),
  APPROVAL_SIGNING_PUBLIC_KEY: Ed25519PublicKeyHex.optional(),
  LIVE_ENTRY_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),
  APPROVALS_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(10_000),
  /** A grant never outlives the intent; this caps it further (§15.6). */
  APPROVAL_MAX_VALIDITY_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(120_000),
  // Market-data providers (M4). Absent key = that provider's roles stay disabled and report FAILED.
  BIRDEYE_API_KEY: NonEmpty.optional(),
  BIRDEYE_TIER: z.enum(['STANDARD', 'LITE', 'STARTER', 'PREMIUM', 'BUSINESS']).default('STANDARD'),
  JUPITER_API_KEY: NonEmpty.optional(),
  /** Requests per second the Jupiter plan allows (free keys are throttled hard by the API gateway; 1 is safe). */
  JUPITER_REQUESTS_PER_SECOND: z.coerce.number().positive().max(100).default(1),
  /** Read-only Solana RPC for chain-truth reads (D45). The worker never signs; this is the only endpoint it may call. */
  SOLANA_RPC_URL: Url.optional(),
  /** Second, independent read-only RPC view for chain-health divergence detection (§14.7). Optional; without it divergence cannot be observed. */
  SOLANA_RPC_SECONDARY_URL: Url.optional(),
  CHAIN_HEALTH_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),
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
  /** Rolling correlation clusters are recomputed on this cadence (windows end on the hour; a repeat inside the hour stores nothing). */
  COHORTS_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  /** Candidate scan cadence (§9.1, §9.7). */
  CANDIDATES_INTERVAL_MS: z.coerce.number().int().min(15_000).max(900_000).default(60_000),
  // Model providers (M6, §11.2). Absent key = the agents role stays disabled and says so; keys are never read from files (D65).
  ANTHROPIC_API_KEY: NonEmpty.optional(),
  OPENAI_API_KEY: NonEmpty.optional(),
  /** `<provider>:<model>`; the proposer and adversary should run on different providers (model-v1). Exact ids are recorded on every agent run. */
  AGENT_PROPOSER_MODEL: z.string().regex(/^(anthropic|openai):.+$/).default('anthropic:claude-sonnet-5'),
  AGENT_ADVERSARY_MODEL: z.string().regex(/^(anthropic|openai):.+$/).default('openai:gpt-5'),
  /** USD per million tokens as `input,output` for each model, e.g. `anthropic:claude-sonnet-5=3,15;openai:gpt-5=1.25,10`; unknown models are recorded at zero cost. */
  AGENT_MODEL_PRICING: z.string().default(''),
  /** Discretionary cycle cadence (§11.7); each tick evaluates automations for S1 candidates and open positions. */
  AGENTS_INTERVAL_MS: z.coerce.number().int().min(15_000).max(900_000).default(60_000),
  AGENTS_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),
  /** Signed RiskStateProjection cadence (§6.14A, D52); the authorizer refuses a projection older than its own max age. */
  STATE_PROJECTOR_INTERVAL_MS: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  /** Where the worker replicates audit-ledger checkpoints outside Postgres (§20.25); the authorizer reads the same file. */
  AUDIT_CHECKPOINT_PATH: NonEmpty.optional(),
  AUDIT_CHECKPOINT_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  /** Live Readiness rows and verdict recomputed this often (§29, ADR-0010). */
  READINESS_INTERVAL_MS: z.coerce.number().int().min(15_000).max(600_000).default(60_000),
  /** Alert derivation, delivery, escalation, dead-man and heartbeat cadence (§20.20). */
  NOTIFICATIONS_INTERVAL_MS: z.coerce.number().int().min(10_000).max(300_000).default(30_000),
  /** Worker-local durable PositionRiskShadow journal (§15.10A); absent = the shadow-sync role is disabled. */
  SHADOW_JOURNAL_PATH: NonEmpty.optional(),
  SHADOW_SYNC_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),
  JOURNAL_IMPORT_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  EMERGENCY_DRY_RUN_INTERVAL_MS: z.coerce.number().int().min(60_000).max(21_600_000).default(900_000),
  /** Out-of-app channel: Telegram Bot API. Both must be set for the channel to count as configured. */
  TELEGRAM_BOT_TOKEN: NonEmpty.optional(),
  TELEGRAM_CHAT_ID: NonEmpty.optional(),
  /** Drain cadence for cleared discretionary position actions (trading-actions queue). */
  TRADING_ACTIONS_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),
  // Intelligence providers (M6, §3.4–3.5). Absent key = that source is skipped; both absent = the intel-ingest role is disabled.
  CRYPTOPANIC_API_KEY: NonEmpty.optional(),
  LUNARCRUSH_API_KEY: NonEmpty.optional(),
  INTEL_INGEST_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
  /** Provider request ceilings per minute (plan-dependent; free tiers are small). */
  CRYPTOPANIC_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(5),
  LUNARCRUSH_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(10),
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
  /** Operator manual close/reduce/emergency requests are polled this often (§14.8); fast by design. */
  MANUAL_ACTIONS_INTERVAL_MS: z.coerce.number().int().min(2_000).max(120_000).default(5_000),
  /** WebAuthn relying party for passkey step-up (ADR-0006): the web app's host, and the exact origins allowed to run ceremonies. Unset disables the operator-security role. */
  WEBAUTHN_RP_ID: z.string().min(1).max(253).optional(),
  WEBAUTHN_ORIGINS: Csv(Url).optional(),
  OPERATOR_SECURITY_INTERVAL_MS: z.coerce.number().int().min(2_000).max(120_000).default(5_000),
  /** S0 decision cadence (§12.1): RAW and SAFE action cycles over new candidates. */
  S0_INTERVAL_MS: z.coerce.number().int().min(15_000).max(900_000).default(60_000),
  /** Git commit of the running build, recorded on strategy versions it registers (§6.21). */
  GIT_SHA: z.string().regex(/^[0-9a-f]{7,40}$/).default('0000000'),
  /** M10 replay role: platform run-rate allocated in the three-layer economic P&L (docs/costs.md), and how often queued runs are picked up. */
  REPLAY_PLATFORM_MONTHLY_USD: z.coerce.number().nonnegative().default(84),
  REPLAY_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  /** JSON map of model id → training-cutoff ISO instant for the §18.5 model-weight look-ahead label; unknown models are labelled UNKNOWN. */
  MODEL_TRAINING_CUTOFFS: z.string().default('{}'),
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
  /** External audit-checkpoint replica (JSON lines) the authorizer verifies the ledger against before accepting a clearance (ADR-0009 P2). */
  AUDIT_CHECKPOINT_PATH: NonEmpty.optional(),
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
      EXCLUSIVE_CREDENTIALS.approvalSigningKey,
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
  /** LIVE_APPROVAL grant verification keys (§15.6); empty = no approval can ever verify, so LIVE_APPROVAL cannot execute. */
  APPROVAL_PUBLIC_KEYS: Csv(Ed25519PublicKeyHex).optional(),
  EMERGENCY_OPERATOR_PUBLIC_KEYS: Csv(Ed25519PublicKeyHex),
  SOLANA_RPC_PRIMARY: Url,
  SOLANA_RPC_SIMULATION: Url,
  /** Second independent RPC view for staged finality and REORG_PENDING detection (§14.7). Optional but expected in every live profile. */
  SOLANA_RPC_SECONDARY: Url.optional(),
  FINALITY_TRACK_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(5_000),
  SIGNER_BACKEND: z.enum(['SOFTWARE_DEV', 'TURNKEY']),
  TURNKEY_ORGANIZATION_ID: NonEmpty.optional(),
  TURNKEY_API_PUBLIC_KEY: NonEmpty.optional(),
  TURNKEY_API_PRIVATE_KEY: NonEmpty.optional(),
  TURNKEY_WALLET_ADDRESS: SolanaAddress.optional(),
  /** Provider API origin; pinned so the executor egress allowlist has one host to permit. */
  TURNKEY_API_BASE_URL: Url.default('https://api.turnkey.com'),
  /**
   * The pinned signer-side policy (D55, ADR-0008). The provider enforces it; this is the copy the
   * executor mirrors locally and whose digest Live Readiness attests, so a policy changed at the
   * provider without a matching Release stops matching what we recorded.
   */
  SIGNER_POLICY_JSON: z
    .string()
    .transform((str, ctx) => {
      try {
        return SignerTransactionPolicy.parse(JSON.parse(str));
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `SIGNER_POLICY_JSON invalid: ${e instanceof Error ? e.message : String(e)}` });
        return z.NEVER;
      }
    })
    .optional(),
  EXECUTOR_JOURNAL_PATH: NonEmpty,
  SENTRY_DSN_EXECUTION_SERVICE: Url.optional(),
  /** host:port for the worker-facing internal API (§15.8). Loopback or private network only. */
  INTERNAL_API_LISTEN: z.string().regex(/^.*:\d{1,5}$/).default('127.0.0.1:8791'),
  /** Shared HMAC secrets (hex, ≥32 bytes each) accepted on the internal API; several allow rotation. Required to serve. */
  INTERNAL_API_SECRETS: Csv(z.string().regex(/^[0-9a-f]{64,}$/)).optional(),
  /** host:port for the out-of-band operator endpoint (D25 plane 1); a separate listener from the internal API. */
  OUT_OF_BAND_LISTEN: z.string().regex(/^.*:\d{1,5}$/).default('127.0.0.1:8792'),
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
  // D55/ADR-0008: the second policy layer is not optional for a live-capable Turnkey deployment.
  // Without a pinned policy there is nothing to mirror, nothing to attest and nothing to digest.
  if (v.SIGNER_BACKEND === 'TURNKEY' && !v.SIGNER_POLICY_JSON) {
    ctx.addIssue({ code: 'custom', message: 'TURNKEY signer requires SIGNER_POLICY_JSON: the pinned signer-side transaction policy (D55, ADR-0008)', path: ['SIGNER_POLICY_JSON'] });
  }
  if (v.SIGNER_POLICY_JSON && v.TURNKEY_WALLET_ADDRESS && v.SIGNER_POLICY_JSON.tradingWallet !== v.TURNKEY_WALLET_ADDRESS) {
    ctx.addIssue({ code: 'custom', message: 'SIGNER_POLICY_JSON pins a different trading wallet than TURNKEY_WALLET_ADDRESS', path: ['SIGNER_POLICY_JSON'] });
  }
  if (v.SIGNER_POLICY_JSON && v.SIGNER_POLICY_JSON.cluster !== v.EXECUTOR_GUARDRAILS_JSON.cluster) {
    ctx.addIssue({ code: 'custom', message: 'SIGNER_POLICY_JSON is pinned to a different cluster than the executor guardrails', path: ['SIGNER_POLICY_JSON'] });
  }
});

export function parseExecutionServiceEnv(env: Record<string, string | undefined>) {
  return parseService(
    ExecutionServiceEnvChecked,
    [
      EXCLUSIVE_CREDENTIALS.approvalSigningKey,
      EXCLUSIVE_CREDENTIALS.serviceRole,
      EXCLUSIVE_CREDENTIALS.projectionSigningKey,
      EXCLUSIVE_CREDENTIALS.riskAuthorizationKey,
      EXCLUSIVE_CREDENTIALS.emergencyOperatorPrivateKey,
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'LUNARCRUSH_API_KEY',
      'CRYPTOPANIC_API_KEY',
    ],
    'execution-service',
    env,
  );
}
