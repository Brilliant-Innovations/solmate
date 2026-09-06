import { getContractSetDigest, parseRiskAuthorizerEnv } from '@sol-agent-trader/contracts';
import { redact } from '@sol-agent-trader/observability';
import { initTelemetry } from '@sol-agent-trader/observability/server';

/**
 * risk-authorizer entrypoint (skeleton; M3 fills it in).
 *
 * Isolated policy process: no LLM runtime, no provider-text ingestion, no wallet or signing
 * capability. Owns the risk-authorization private key and emits signed RiskAuthorizedIntent
 * envelopes only (blueprint D21, §15.5). The environment is validated by the fail-closed schema
 * before anything else runs: a service-role key, signer credential or LLM/provider key in this
 * process's environment is fatal (§26.1, GUARDRAILS Part 4). Reports its contract-set digest at
 * startup (D50). `--print-digest` prints the digest and exits without touching the environment.
 */
const SERVICE = 'risk-authorizer' as const;

function issuesOf(err: unknown): unknown {
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues.map((i: { path?: unknown[]; message?: string }) => ({ path: (i.path ?? []).join('.'), message: i.message })) : String(err);
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
    console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'env_invalid', issues: redact(issuesOf(err)) }));
    process.exit(1);
  }

  const telemetry = initTelemetry({
    service: SERVICE,
    deploymentProfile: env.DEPLOYMENT_PROFILE,
    sentryDsn: env.SENTRY_DSN_RISK_AUTHORIZER,
    instanceId: env.SERVICE_INSTANCE_ID,
  });
  telemetry.logger.info('startup', { contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount, cluster: env.SOLANA_CLUSTER });
  await telemetry.shutdown();
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
