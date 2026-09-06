import { getContractSetDigest, parseWorkerEnv } from '@sol-agent-trader/contracts';
import { redact } from '@sol-agent-trader/observability';
import { initTelemetry } from '@sol-agent-trader/observability/server';

/**
 * worker entrypoint (skeleton; roles arrive from M4 onward).
 *
 * Multi-role runtime: ingestion, signals, agents, trading orchestration and reconciliation over
 * durable pgmq queues drained in risk-first order (§5.4). Holds no signer credential and no
 * risk-authorization private key: the environment is validated by the fail-closed worker schema
 * before anything else runs (§26.1, GUARDRAILS Part 4). Reports its contract-set digest at
 * startup (D50). `--print-digest` prints the digest and exits without touching the environment,
 * for image and CI verification.
 */
const SERVICE = 'worker' as const;

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

  let env: ReturnType<typeof parseWorkerEnv>;
  try {
    env = parseWorkerEnv(process.env);
  } catch (err) {
    console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'env_invalid', issues: redact(issuesOf(err)) }));
    process.exit(1);
  }

  const telemetry = initTelemetry({
    service: SERVICE,
    deploymentProfile: env.DEPLOYMENT_PROFILE,
    sentryDsn: env.SENTRY_DSN_WORKER,
    instanceId: env.SERVICE_INSTANCE_ID,
  });
  telemetry.logger.info('startup', { contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount, cluster: env.SOLANA_CLUSTER });
  await telemetry.shutdown();
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
