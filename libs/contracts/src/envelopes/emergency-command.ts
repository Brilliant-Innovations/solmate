import { z } from 'zod';
import { EmergencyCommandType } from '../enums.js';
import { Amount, Instant, MintAddress, Nonce, SolanaCluster, Uuid } from '../primitives.js';
import { signedEnvelopeOf } from '../signing/signed-envelope.js';

// D25 / §15.10 out-of-band emergency commands ---------------------------------------------------

export const EmergencyIssuer = z.enum(['OPERATOR_OUT_OF_BAND', 'POSITION_MONITOR', 'DEAD_MAN', 'WATCHDOG']);
export type EmergencyIssuer = z.infer<typeof EmergencyIssuer>;

/**
 * The only verbs the out-of-band plane accepts. There is no recipient field anywhere: emergency
 * closes can only convert a chain-confirmed held asset into a deployment settlement mint (D22).
 */
export const EmergencyCommand = z
  .strictObject({
    commandId: Uuid,
    type: EmergencyCommandType,
    /** Deployment cluster the command is bound to; the executor rejects a mismatch. */
    cluster: SolanaCluster,
    /** Required for EMERGENCY_CLOSE_ASSET (enforced below); must be a held risk asset. Null otherwise. */
    mint: MintAddress.nullable(),
    /** Optional cap; the executor further caps to the chain-confirmed available amount. */
    maxAmount: Amount.nullable(),
    issuer: EmergencyIssuer,
    reason: z.string().min(1).max(1024),
    issuedAt: Instant,
    expiresAt: Instant,
    nonce: Nonce,
  })
  .refine((c) => (c.type === 'EMERGENCY_CLOSE_ASSET') === (c.mint !== null), {
    message: 'mint is required for EMERGENCY_CLOSE_ASSET and forbidden otherwise',
    path: ['mint'],
  });
export type EmergencyCommand = z.infer<typeof EmergencyCommand>;

export const SignedEmergencyCommand = signedEnvelopeOf(EmergencyCommand);
export type SignedEmergencyCommand = z.infer<typeof SignedEmergencyCommand>;
