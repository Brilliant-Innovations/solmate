import { z } from 'zod';
import { DeploymentProfile } from '../enums.js';

/**
 * Deployment profile manifest (blueprint D65, §5.2, ADR-0002). Manifests live in
 * /config/profiles/<profile>.json. They declare where each logical service runs and which
 * credential names it receives, so credential separation is a checked artifact rather than a
 * convention. Terraform for P3/P4 is written in M11 from these declarations.
 */

export const ServiceName = z.enum(['web', 'worker', 'risk-authorizer', 'execution-service']);
export type ServiceName = z.infer<typeof ServiceName>;

export const HostKind = z.enum([
  'vercel',
  'workstation',
  'workstation-isolated-vm',
  'vercel-sandbox',
  'fixed-price-vm',
  'dedicated-host',
]);
export type HostKind = z.infer<typeof HostKind>;

export const ServicePlacement = z.strictObject({
  host: HostKind,
  /** Logical host label; two services on the same label share a physical host. */
  hostLabel: z.string().min(1).max(64),
  /** Environment variable names this service receives. Values never appear in manifests. */
  credentials: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  /** Deny-by-default egress destinations, by label (resolved in deployment config). */
  egress: z.array(z.string().min(1)),
  durableJournal: z.enum(['none', 'local-disk', 'attached-volume']),
});

export const DeploymentProfileManifest = z.strictObject({
  profile: DeploymentProfile,
  description: z.string().min(1),
  runtimeSubstrate: z.enum(['workstation', 'vercel-sandbox', 'fixed-price-vm', 'three-host']),
  physicalIsolation: z.boolean(),
  liveCapitalAllowed: z.boolean(),
  attendedRequired: z.boolean(),
  services: z.strictObject({
    web: ServicePlacement,
    worker: ServicePlacement,
    'risk-authorizer': ServicePlacement,
    'execution-service': ServicePlacement,
  }),
  requiredChecks: z.array(z.string().min(1)),
  notes: z.array(z.string()),
});
export type DeploymentProfileManifest = z.infer<typeof DeploymentProfileManifest>;

/** Credential names that exactly one service may hold, and which one (GUARDRAILS Part 4). */
export const CREDENTIAL_OWNERSHIP: Readonly<Record<string, ServiceName>> = {
  SUPABASE_SERVICE_ROLE_KEY: 'worker',
  PROJECTION_SIGNING_KEY_PKCS8: 'worker',
  RISK_AUTHORIZATION_KEY_PKCS8: 'risk-authorizer',
  TURNKEY_API_PRIVATE_KEY: 'execution-service',
  TURNKEY_API_PUBLIC_KEY: 'execution-service',
  EXECUTOR_GUARDRAILS_JSON: 'execution-service',
};

/** Credential names no application service may ever hold. */
export const NEVER_IN_ANY_SERVICE: readonly string[] = ['EMERGENCY_OPERATOR_KEY_PKCS8', 'BREAK_GLASS_CREDENTIAL', 'TRADING_WALLET_SEED'];

export type ManifestViolation = { profile: string; rule: string; detail: string };

/** Structural checks every manifest must pass; returns violations (empty = valid). */
export function checkManifest(m: DeploymentProfileManifest): ManifestViolation[] {
  const v: ManifestViolation[] = [];
  const services = Object.entries(m.services) as [ServiceName, z.infer<typeof ServicePlacement>][];
  for (const [name, placement] of services) {
    for (const cred of placement.credentials) {
      if (NEVER_IN_ANY_SERVICE.includes(cred)) v.push({ profile: m.profile, rule: 'never-in-service', detail: `${name} lists ${cred}` });
      const owner = CREDENTIAL_OWNERSHIP[cred];
      if (owner && owner !== name) v.push({ profile: m.profile, rule: 'exclusive-credential', detail: `${name} lists ${cred}, owned by ${owner}` });
    }
  }
  const web = m.services.web;
  if (web.credentials.some((c) => c.includes('DB_URL') || c.includes('SERVICE_ROLE') || c.includes('PKCS8') || c.startsWith('TURNKEY'))) {
    v.push({ profile: m.profile, rule: 'web-has-no-backend-credentials', detail: web.credentials.join(',') });
  }
  if (web.host !== 'vercel') v.push({ profile: m.profile, rule: 'web-on-vercel', detail: web.host });
  if (m.liveCapitalAllowed) {
    for (const name of ['risk-authorizer', 'execution-service'] as const) {
      const host = m.services[name].host;
      if (host === 'workstation' || host === 'vercel-sandbox') {
        v.push({ profile: m.profile, rule: 'live-credentials-isolated', detail: `${name} on ${host} while live capital is allowed (D65)` });
      }
      if (m.services[name].durableJournal === 'none') v.push({ profile: m.profile, rule: 'live-needs-durable-journal', detail: name });
    }
    if (!m.services['execution-service'].credentials.includes('EXECUTOR_GUARDRAILS_JSON')) {
      v.push({ profile: m.profile, rule: 'executor-guardrails-present', detail: 'missing EXECUTOR_GUARDRAILS_JSON' });
    }
  }
  if (m.physicalIsolation) {
    const labels = new Set(['worker', 'risk-authorizer', 'execution-service'].map((s) => m.services[s as ServiceName].hostLabel));
    if (labels.size !== 3) v.push({ profile: m.profile, rule: 'three-distinct-hosts', detail: [...labels].join(',') });
  }
  return v;
}
