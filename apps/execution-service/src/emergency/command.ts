import { EmergencyCommand, instantToMs, verifySignedEnvelope, type Instant, type KeyId, type Nonce, type SignedEmergencyCommand, type SolanaCluster, type VerificationKey } from '@sol-agent-trader/contracts';

/**
 * Out-of-band emergency command verification (D25 plane 1, §15.10). The command is accepted only
 * from a key id pinned in the deployment guardrails, for this cluster, inside its validity window
 * and with a nonce this executor has not acted on. There is no recipient, amount-increase or buy
 * verb to verify: the schema has none.
 */

export interface EmergencyCommandInput {
  envelope: SignedEmergencyCommand;
  keys: readonly VerificationKey[];
  acceptedKeyIds: readonly KeyId[];
  cluster: SolanaCluster;
  usedNonces: ReadonlySet<Nonce>;
  now: Instant;
  maxSkewMs: number;
}

export type EmergencyCommandRejection = 'OPERATOR_KEY_NOT_ACCEPTED' | 'COMMAND_SIGNATURE_INVALID' | 'COMMAND_MALFORMED' | 'CLUSTER_MISMATCH' | 'COMMAND_EXPIRED' | 'COMMAND_NOT_YET_VALID' | 'NONCE_REPLAYED';

export type EmergencyCommandVerdict = { ok: true; command: EmergencyCommand } | { ok: false; reasons: EmergencyCommandRejection[]; detail: string[] };

export async function verifyEmergencyCommand(input: EmergencyCommandInput): Promise<EmergencyCommandVerdict> {
  const accepted = input.keys.filter((k) => input.acceptedKeyIds.includes(k.keyId));
  if (!accepted.some((k) => k.keyId === input.envelope.keyId)) return { ok: false, reasons: ['OPERATOR_KEY_NOT_ACCEPTED'], detail: [`key ${input.envelope.keyId} is not an accepted emergency operator key`] };
  const sig = await verifySignedEnvelope(input.envelope, accepted);
  if (!sig.ok) return { ok: false, reasons: ['COMMAND_SIGNATURE_INVALID'], detail: [sig.reason] };
  const parsed = EmergencyCommand.safeParse(input.envelope.payload);
  if (!parsed.success) return { ok: false, reasons: ['COMMAND_MALFORMED'], detail: [parsed.error.message.slice(0, 200)] };
  const c = parsed.data;
  const reasons: EmergencyCommandRejection[] = [];
  const detail: string[] = [];
  const nowMs = instantToMs(input.now);
  if (c.cluster !== input.cluster) {
    reasons.push('CLUSTER_MISMATCH');
    detail.push(`${c.cluster} != ${input.cluster}`);
  }
  if (nowMs >= instantToMs(c.expiresAt)) reasons.push('COMMAND_EXPIRED');
  if (instantToMs(c.issuedAt) - nowMs > input.maxSkewMs) reasons.push('COMMAND_NOT_YET_VALID');
  if (input.usedNonces.has(c.nonce)) reasons.push('NONCE_REPLAYED');
  return reasons.length ? { ok: false, reasons, detail } : { ok: true, command: c };
}
