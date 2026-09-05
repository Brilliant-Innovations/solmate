import { getContractSetDigest } from '@sol-agent-trader/contracts';

/**
 * worker entrypoint (skeleton; roles arrive from M4 onward).
 *
 * Multi-role runtime: ingestion, signals, agents, trading orchestration and reconciliation over
 * durable pgmq queues drained in risk-first order (§5.4). Holds no signer credential and no
 * risk-authorization private key. Reports its contract-set digest at startup (D50).
 */
const SERVICE = 'worker' as const;

async function main(): Promise<void> {
  const digest = await getContractSetDigest();
  console.log(
    JSON.stringify({
      level: 'info',
      service: SERVICE,
      event: 'startup',
      contractSetDigest: digest.digest,
      contractSetFormat: digest.format,
      schemaCount: digest.schemaCount,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'fatal', service: SERVICE, event: 'startup_failed', error: String(err) }));
  process.exit(1);
});
