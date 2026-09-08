import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXCLUSIVE_CREDENTIALS, parseExecutionServiceEnv, parseRiskAuthorizerEnv, parseWebEnv, parseWorkerEnv } from './env.js';
import { checkManifest, DeploymentProfileManifest, type DeploymentProfileManifest as Manifest } from './profiles.js';

const PROFILES_DIR = resolve(import.meta.dirname, '../../../../config/profiles');
const PUB = 'a'.repeat(64);
const PKCS8 = 'b'.repeat(96);
const KEY_ID = 'ed25519:' + 'c'.repeat(32);
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function loadManifests(): Manifest[] {
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => DeploymentProfileManifest.parse(JSON.parse(readFileSync(resolve(PROFILES_DIR, f), 'utf8'))));
}

describe('deployment profile manifests (D65, ADR-0002, P0 acceptance)', () => {
  const manifests = loadManifests();

  it('defines all six profiles and each passes the structural checks', () => {
    expect(manifests.map((m) => m.profile)).toEqual(['P0', 'P1A', 'P1B', 'P2', 'P3', 'P4']);
    for (const m of manifests) expect(checkManifest(m), m.profile).toEqual([]);
  });

  it('proves credential separation in every profile, including the co-resident ones', () => {
    for (const m of manifests) {
      const creds = (s: keyof Manifest['services']) => new Set(m.services[s].credentials);
      expect(creds('web').has(EXCLUSIVE_CREDENTIALS.serviceRole)).toBe(false);
      expect(creds('web').has('SUPABASE_DB_URL')).toBe(false);
      expect(creds('worker').has(EXCLUSIVE_CREDENTIALS.riskAuthorizationKey)).toBe(false);
      expect(creds('worker').has(EXCLUSIVE_CREDENTIALS.signerCredential)).toBe(false);
      expect(creds('risk-authorizer').has(EXCLUSIVE_CREDENTIALS.serviceRole)).toBe(false);
      expect(creds('risk-authorizer').has(EXCLUSIVE_CREDENTIALS.signerCredential)).toBe(false);
      expect(creds('execution-service').has(EXCLUSIVE_CREDENTIALS.riskAuthorizationKey)).toBe(false);
      expect(creds('execution-service').has(EXCLUSIVE_CREDENTIALS.serviceRole)).toBe(false);
      for (const s of ['web', 'worker', 'risk-authorizer', 'execution-service'] as const) {
        expect(creds(s).has(EXCLUSIVE_CREDENTIALS.emergencyOperatorPrivateKey), `${m.profile}/${s}`).toBe(false);
      }
    }
  });

  it('live profiles keep financial credentials off agent-accessible hosts and P4 uses three hosts', () => {
    for (const m of manifests.filter((x) => x.liveCapitalAllowed)) {
      expect(['workstation', 'vercel-sandbox']).not.toContain(m.services['execution-service'].host);
      expect(m.services['execution-service'].credentials).toContain('TURNKEY_API_PRIVATE_KEY');
    }
    const p4 = manifests.find((m) => m.profile === 'P4');
    expect(new Set(['worker', 'risk-authorizer', 'execution-service'].map((s) => p4?.services[s as 'worker'].hostLabel)).size).toBe(3);
    for (const m of manifests.filter((x) => !x.liveCapitalAllowed)) {
      expect(m.services['execution-service'].credentials).not.toContain('TURNKEY_API_PRIVATE_KEY');
    }
  });

  it('the structural checker catches a manifest that hands the signer credential to the worker', () => {
    const p2 = manifests.find((m) => m.profile === 'P2') as Manifest;
    const bad: Manifest = { ...p2, services: { ...p2.services, worker: { ...p2.services.worker, credentials: [...p2.services.worker.credentials, 'TURNKEY_API_PRIVATE_KEY'] } } };
    expect(checkManifest(bad).map((v) => v.rule)).toContain('exclusive-credential');
  });
});

describe('per-service environment schemas fail closed (§26.1, GUARDRAILS Part 4)', () => {
  const common = { DEPLOYMENT_PROFILE: 'P0', SOLANA_CLUSTER: 'devnet' };

  it('web boots with anon credentials only and refuses a service-role key or a DB URL', () => {
    const ok = { ...common, NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'anon' };
    expect(parseWebEnv(ok).DEPLOYMENT_PROFILE).toBe('P0');
    expect(() => parseWebEnv({ ...ok, SUPABASE_SERVICE_ROLE_KEY: 'svc' })).toThrow(/must never hold SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => parseWebEnv({ ...ok, SUPABASE_DB_URL: 'postgres://x' })).toThrow(/must never hold SUPABASE_DB_URL/);
  });

  it('worker refuses the risk-authorization key and signer credential', () => {
    const ok = { ...common, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_DB_URL: 'postgres://x', PROJECTION_SIGNING_KEY_PKCS8: PKCS8, PROJECTION_SIGNING_PUBLIC_KEY: PUB, EMERGENCY_OPERATOR_PUBLIC_KEYS: PUB };
    expect(parseWorkerEnv(ok).EMERGENCY_OPERATOR_PUBLIC_KEYS).toEqual([PUB]);
    expect(() => parseWorkerEnv({ ...ok, RISK_AUTHORIZATION_KEY_PKCS8: PKCS8 })).toThrow(/must never hold RISK_AUTHORIZATION_KEY_PKCS8/);
    expect(() => parseWorkerEnv({ ...ok, TURNKEY_API_PRIVATE_KEY: 'k' })).toThrow(/must never hold TURNKEY_API_PRIVATE_KEY/);
  });

  it('risk-authorizer refuses service role, signer and every LLM/provider key', () => {
    const ok = { ...common, SUPABASE_DB_URL: 'postgres://x', RISK_AUTHORIZATION_KEY_PKCS8: PKCS8, RISK_AUTHORIZATION_PUBLIC_KEY: PUB, PROJECTION_VERIFICATION_PUBLIC_KEYS: PUB, RELEASE_ATTESTATION_TRUST_FINGERPRINTS: 'd'.repeat(64), SOLANA_RPC_ALLOWLIST: 'https://rpc.example' };
    expect(parseRiskAuthorizerEnv(ok).SOLANA_RPC_ALLOWLIST).toEqual(['https://rpc.example']);
    for (const bad of ['SUPABASE_SERVICE_ROLE_KEY', 'TURNKEY_API_PRIVATE_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BIRDEYE_API_KEY']) {
      expect(() => parseRiskAuthorizerEnv({ ...ok, [bad]: 'x' }), bad).toThrow(new RegExp(`must never hold ${bad}`));
    }
  });

  it('execution-service parses guardrails and refuses a software signer with live capability on mainnet (D47)', () => {
    const guardrails = {
      liveCapabilityEnabled: false, cluster: 'devnet', tradingWalletAddress: WALLET, allowedSettlementMints: [USDC], allowedFundingMints: [USDC],
      maxPerEntryNotionalBaseUnits: '1000000', maxAggregateNonSettlementExposureBaseUnits: '5000000', maxSignerOutageUnprotectedExposureBaseUnits: '1000000',
      maxEmergencyCloseTxBaseUnits: null, hardMaxSlippageBps: 300, hardMaxProtectiveSlippageBps: 500,
      acceptedRiskAuthorizerKeyIds: [KEY_ID], acceptedEmergencyOperatorKeyIds: [KEY_ID], expectedSignerPolicyDigest: null, expectedSignerWorkloadFingerprint: null,
    };
    const ok = { ...common, SUPABASE_DB_URL: 'postgres://x', EXECUTOR_GUARDRAILS_JSON: JSON.stringify(guardrails), RISK_AUTHORIZER_PUBLIC_KEYS: PUB, EMERGENCY_OPERATOR_PUBLIC_KEYS: PUB, SOLANA_RPC_PRIMARY: 'https://a', SOLANA_RPC_SIMULATION: 'https://b', SIGNER_BACKEND: 'SOFTWARE_DEV', EXECUTOR_JOURNAL_PATH: '/var/lib/executor' };
    expect(parseExecutionServiceEnv(ok).EXECUTOR_GUARDRAILS_JSON.hardMaxSlippageBps).toBe(300);
    const live = JSON.stringify({ ...guardrails, liveCapabilityEnabled: true, cluster: 'mainnet-beta' });
    expect(() => parseExecutionServiceEnv({ ...ok, EXECUTOR_GUARDRAILS_JSON: live })).toThrow(/SOFTWARE_DEV signer cannot be combined/);
    // the development signer key is the executor's alone: accepted here, refused by every other service
    const withSigner = parseExecutionServiceEnv({ ...ok, SOFTWARE_SIGNER_KEY_PKCS8: PKCS8, INTERNAL_API_LISTEN: '127.0.0.1:8791', OUT_OF_BAND_LISTEN: '0.0.0.0:8792' });
    expect(withSigner.SOFTWARE_SIGNER_KEY_PKCS8).toBe(PKCS8);
    expect(withSigner.INTERNAL_API_LISTEN).toBe('127.0.0.1:8791');
    expect(parseExecutionServiceEnv(ok).OUT_OF_BAND_LISTEN).toBe('127.0.0.1:8792');
    expect(() => parseExecutionServiceEnv({ ...ok, INTERNAL_API_LISTEN: 'no-port' })).toThrow();
    expect(() => parseExecutionServiceEnv({ ...ok, EXECUTOR_GUARDRAILS_JSON: live, SIGNER_BACKEND: 'TURNKEY' })).toThrow(/TURNKEY signer requires/);
    expect(() => parseExecutionServiceEnv({ ...ok, RISK_AUTHORIZATION_KEY_PKCS8: PKCS8 })).toThrow(/must never hold RISK_AUTHORIZATION_KEY_PKCS8/);
    expect(() => parseExecutionServiceEnv({ ...ok, EXECUTOR_GUARDRAILS_JSON: '{"nope":true}' })).toThrow(/EXECUTOR_GUARDRAILS_JSON invalid/);
  });
});
