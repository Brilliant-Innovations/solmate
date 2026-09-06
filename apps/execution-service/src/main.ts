import { getContractSetDigest } from '@sol-agent-trader/contracts';
import { initTelemetry } from '@sol-agent-trader/observability/server';

/**
 * execution-service entrypoint (skeleton; M3 fills it in).
 *
 * The only application process allowed to originate a normal autonomous signing request
 * (D10). Verifies risk-authorization envelopes against its pinned key, enforces deployment
 * absolute caps and the local exposure ledger, validates transactions by structure, independent
 * simulation and semantic balance deltas, persists before submit (§15). Reports its contract-set
 * digest at startup (D50).
 */
const SERVICE = 'execution-service' as const;

async function main(): Promise<void> {
  const telemetry = initTelemetry({
    service: SERVICE,
    deploymentProfile: process.env['DEPLOYMENT_PROFILE'] ?? 'P0',
    sentryDsn: process.env['SENTRY_DSN_EXECUTION_SERVICE'],
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
