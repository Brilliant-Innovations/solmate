import { getContractSetDigest } from '@sol-agent-trader/contracts';
import { initTelemetry } from '@sol-agent-trader/observability/server';

/**
 * worker entrypoint (skeleton; roles arrive from M4 onward).
 *
 * Multi-role runtime: ingestion, signals, agents, trading orchestration and reconciliation over
 * durable pgmq queues drained in risk-first order (§5.4). Holds no signer credential and no
 * risk-authorization private key. Reports its contract-set digest at startup (D50).
 */
const SERVICE = 'worker' as const;

async function main(): Promise<void> {
  const telemetry = initTelemetry({
    service: SERVICE,
    deploymentProfile: process.env['DEPLOYMENT_PROFILE'] ?? 'P0',
    sentryDsn: process.env['SENTRY_DSN_WORKER'],
    instanceId: process.env['SERVICE_INSTANCE_ID'],
  });
  const digest = await getContractSetDigest();
  telemetry.logger.info('startup', { contractSetDigest: digest.digest, contractSetFormat: digest.format, schemaCount: digest.schemaCount });
  await telemetry.shutdown();
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
