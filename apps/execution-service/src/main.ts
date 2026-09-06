import { getContractSetDigest, parseExecutionServiceEnv } from '@sol-agent-trader/contracts';
import { redact } from '@sol-agent-trader/observability';
import { initTelemetry } from '@sol-agent-trader/observability/server';

/**
 * execution-service entrypoint (skeleton; M3 fills it in).
 *
 * The only application process allowed to originate a normal autonomous signing request
 * (D10). Verifies risk-authorization envelopes against its pinned key, enforces deployment
 * absolute caps and the local exposure ledger, validates transactions by structure, independent
 * simulation and semantic balance deltas, persists before submit (§15). The environment is
 * validated by the fail-closed schema before anything else runs: the risk-authorization private
 * key is fatal here, and a software signer with live capability on mainnet is refused (D47).
 * Reports its contract-set digest at startup (D50). `--print-digest` prints the digest and exits
 * without touching the environment.
 */
const SERVICE = 'execution-service' as const;

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

  let env: ReturnType<typeof parseExecutionServiceEnv>;
  try {
    env = parseExecutionServiceEnv(process.env);
  } catch (err) {
    console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'env_invalid', issues: redact(issuesOf(err)) }));
    process.exit(1);
  }

  const telemetry = initTelemetry({
    service: SERVICE,
    deploymentProfile: env.DEPLOYMENT_PROFILE,
    sentryDsn: env.SENTRY_DSN_EXECUTION_SERVICE,
    instanceId: env.SERVICE_INSTANCE_ID,
  });
  telemetry.logger.info('startup', { contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount, cluster: env.SOLANA_CLUSTER });
  await telemetry.shutdown();
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
