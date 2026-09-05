import { getContractSetDigest } from '@sol-agent-trader/contracts';

/**
 * risk-authorizer entrypoint (skeleton; M3 fills it in).
 *
 * Isolated policy process: no LLM runtime, no provider-text ingestion, no wallet or signing
 * capability. Owns the risk-authorization private key and emits signed RiskAuthorizedIntent
 * envelopes only (blueprint D21, §15.5). Reports its contract-set digest at startup so readiness
 * can prove every live-capable deployable was built from the same contracts (D50).
 */
const SERVICE = 'risk-authorizer' as const;

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
