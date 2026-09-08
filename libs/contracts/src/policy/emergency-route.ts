import { z } from 'zod';
import { DirectPoolProgram } from '../entities/core.js';
import { Milliseconds, VersionId } from '../primitives.js';

/**
 * Emergency-route readiness policy (blueprint §14.6, D33; plan M8b). The provider-independent
 * exit path for a held or LIVE_AUTO-eligible asset is proven by a periodic unsigned build +
 * simulation dry-run against the persisted direct-pool snapshot. A stale or failed dry-run blocks
 * new autonomous entry for that asset; it never blocks an exit.
 */
export const EmergencyRoutePolicy = z.strictObject({
  version: VersionId,
  /** How often the dry-run role re-proves each target. */
  dryRunIntervalMs: Milliseconds,
  /** A dry-run older than this no longer counts as readiness. */
  maxDryRunAgeMs: Milliseconds,
  /** Compute budget attached to the built emergency transaction. */
  computeUnitLimit: z.number().int().min(50_000).max(1_400_000),
  computeUnitPriceMicroLamports: z.number().int().min(0).max(10_000_000),
  /** Slippage the dry-run tolerates between local quote and simulated output before it is a FAIL. */
  dryRunSlippageBps: z.number().int().min(1).max(5_000),
  maxTargetsPerCycle: z.number().int().min(1).max(500),
  /** Families with a local adapter; a snapshot on any other program is UNSUPPORTED and never READY. */
  supportedPrograms: z.array(DirectPoolProgram).min(1),
});
export type EmergencyRoutePolicy = z.infer<typeof EmergencyRoutePolicy>;

export const DEFAULT_EMERGENCY_ROUTE_POLICY: EmergencyRoutePolicy = {
  version: 'emergency-route-v1' as VersionId,
  dryRunIntervalMs: 3_600_000,
  maxDryRunAgeMs: 6 * 3_600_000,
  computeUnitLimit: 400_000,
  computeUnitPriceMicroLamports: 50_000,
  dryRunSlippageBps: 300,
  maxTargetsPerCycle: 40,
  supportedPrograms: ['RAYDIUM_CPMM', 'RAYDIUM_AMM_V4', 'METEORA_DLMM', 'RAYDIUM_CLMM', 'ORCA_WHIRLPOOL'],
};

export const EmergencyRouteReadiness = z.enum(['READY', 'STALE', 'FAILED', 'UNSUPPORTED', 'MISSING']);
export type EmergencyRouteReadiness = z.infer<typeof EmergencyRouteReadiness>;

/** Outcome classes of one unsigned dry-run. OK_UNFUNDED: the program accepted the shape and only the wallet's token balance was missing. PAYER_UNFUNDED: the payer holds no SOL at all, so nothing could be proven. SOURCE_ACCOUNT_MISSING: the payer holds none of the input token, so the swap itself was not exercised. */
export const EmergencyDryRunClass = z.enum(['OK', 'OK_UNFUNDED', 'PAYER_UNFUNDED', 'SOURCE_ACCOUNT_MISSING', 'POOL_REJECTED', 'SLIPPAGE_EXCEEDED', 'UNSUPPORTED_PROGRAM', 'DECODE_FAILED', 'RPC_ERROR']);
export type EmergencyDryRunClass = z.infer<typeof EmergencyDryRunClass>;
