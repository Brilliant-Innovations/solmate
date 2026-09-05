import { getContractSetDigest } from '@sol-agent-trader/contracts';

export const dynamic = 'force-dynamic';

/**
 * Web control-plane health. Exposes the contract-set digest this deployment was built from so
 * Live Readiness can compare it with worker, risk-authorizer and execution-service (D50, §29).
 * Carries no secrets and no financial state.
 */
export async function GET(): Promise<Response> {
  const digest = await getContractSetDigest();
  return Response.json({
    service: 'web',
    status: 'ok',
    contractSetDigest: digest.digest,
    contractSetFormat: digest.format,
    schemaCount: digest.schemaCount,
  });
}
