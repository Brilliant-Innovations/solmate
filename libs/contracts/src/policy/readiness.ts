import { z } from 'zod';
import { DeploymentProfile } from '../enums.js';
import { JsonRecord } from '../entities/common.js';
import { Amount, Instant, Milliseconds, Sha256Hex, SolanaAddress, SolanaCluster, Uuid, VersionId } from '../primitives.js';

/**
 * Live Readiness (blueprint §29; ADR-0004 row set; ADR-0010 §5 deployment-bound evidence). A
 * verdict is computed from rows, each recorded against the exact deployment it was evaluated on:
 * commit, image, contract-set digest, policy digests, wallet, cluster, profile and Release. A change
 * to any bound value invalidates the row. Rows come from four sources: COMPUTED by the worker from
 * stored facts every cycle, CI_EVIDENCE from test runs, DRILL from operator-run drills in the target
 * environment, PROBE from the provider probes. Readiness is operational evidence, not a checkbox.
 */

export const ReadinessRowId = z.enum([
  'RISK_AUTHORIZER_ISOLATION_TAMPER',
  'SIGNER_DENY_EXPORT_PINNED',
  'PERSIST_BEFORE_SUBMIT_DRILL',
  'APPROVAL_BINDING_REPLAY',
  'TINY_LIVE_RELEASE_BOUND',
  'TINY_ATTESTED_CAPITAL',
  'RECONCILIATION_CLEAN',
  'CRITICAL_ALERT_DELIVERY',
  'OUT_OF_BAND_CONTROLS',
  'BREAK_GLASS_SWEEP_DRILL',
  'SIGNER_CONTRACT_PROBE_C',
  'SIGNER_OUTAGE_DRILL',
  'DB_DOWN_EMERGENCY_CLOSE',
  'WALLET_RESERVES',
  'OPERATOR_PRESENCE_HEARTBEAT',
  'CAPITAL_ATTESTATION',
  'CREDENTIAL_ISOLATION',
  'ARTIFACT_EGRESS_DIGEST',
  'OPERATOR_SURFACE_E2E',
  'TRIGGER_LIFECYCLE',
  'PROBE_A_SIGNER_POLICY',
  'NO_OPEN_CRITICAL_FINDING',
  'INVARIANT_COVERAGE',
  'SINGLE_SLEEVE_PER_MINT',
  'CHAIN_HEALTH',
  'CHAIN_FINALITY_DRILLS',
]);
export type ReadinessRowId = z.infer<typeof ReadinessRowId>;

export const ReadinessRowKind = z.enum(['COMPUTED', 'CI_EVIDENCE', 'DRILL', 'PROBE']);
export type ReadinessRowKind = z.infer<typeof ReadinessRowKind>;

export const ReadinessRowVerdict = z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE', 'UNKNOWN']);
export type ReadinessRowVerdict = z.infer<typeof ReadinessRowVerdict>;

export const ReadinessStrategyClass = z.enum(['DETERMINISTIC', 'LLM']);
export type ReadinessStrategyClass = z.infer<typeof ReadinessStrategyClass>;

/** Everything a row is bound to; any difference between a row's binding and the current one invalidates the row (ADR-0010 §5). */
export const ReadinessBinding = z.strictObject({
  gitSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  imageDigest: z.string().max(128).nullable(),
  contractSetDigest: Sha256Hex,
  policyDigests: z.record(z.string().min(1).max(64), z.string().min(1).max(128)),
  tradingWallet: SolanaAddress.nullable(),
  cluster: SolanaCluster,
  profile: DeploymentProfile,
  releaseId: Uuid.nullable(),
  releaseDigest: Sha256Hex.nullable(),
});
export type ReadinessBinding = z.infer<typeof ReadinessBinding>;

export const ReadinessRow = z.strictObject({
  id: Uuid,
  rowId: ReadinessRowId,
  kind: ReadinessRowKind,
  verdict: ReadinessRowVerdict,
  strategyClass: ReadinessStrategyClass,
  binding: ReadinessBinding,
  detail: JsonRecord,
  /** Where the evidence lives: a CI run, a drill record, a probe result file. */
  evidenceRef: z.string().max(512).nullable(),
  recordedBy: z.string().min(1).max(128),
  evaluatedAt: Instant,
  expiresAt: Instant.nullable(),
});
export type ReadinessRow = z.infer<typeof ReadinessRow>;

export const ReadinessCapability = z.enum(['LIVE_SIGNING', 'LIVE_AUTO', 'LLM_STRATEGY', 'MULTI_STRATEGY', 'PROVIDER_PROTECTION', 'OFFLINE_CARRY', 'EMERGENCY_DIRECT_POOL']);
export type ReadinessCapability = z.infer<typeof ReadinessCapability>;

export const ReadinessRowSpec = z.strictObject({
  rowId: ReadinessRowId,
  kind: ReadinessRowKind,
  required: z.boolean(),
  /** The row applies only when this capability is enabled; otherwise it is NOT_APPLICABLE with the reason recorded. */
  requiresCapability: ReadinessCapability.nullable(),
  description: z.string().min(1).max(240),
});
export type ReadinessRowSpec = z.infer<typeof ReadinessRowSpec>;

export const ReadinessVerdictName = z.enum(['READY_FOR_ATTENDED_TINY_LIVE', 'READY_FOR_UNATTENDED_LIVE_PILOT', 'READY_FOR_HARDENED_LIVE_AUTO']);
export type ReadinessVerdictName = z.infer<typeof ReadinessVerdictName>;

export const ReadinessRowOutcome = z.strictObject({
  rowId: ReadinessRowId,
  kind: ReadinessRowKind,
  required: z.boolean(),
  verdict: ReadinessRowVerdict,
  /** MISSING, STALE_BINDING, EXPIRED, FAILED, NOT_APPLICABLE(reason) or null when the row passes. */
  reason: z.string().max(240).nullable(),
  evaluatedAt: Instant.nullable(),
  rowRef: Uuid.nullable(),
});
export type ReadinessRowOutcome = z.infer<typeof ReadinessRowOutcome>;

export const ReadinessVerdict = z.strictObject({
  id: Uuid,
  name: ReadinessVerdictName,
  profile: DeploymentProfile,
  strategyClass: ReadinessStrategyClass,
  releaseId: Uuid.nullable(),
  verdict: z.enum(['READY', 'NOT_READY']),
  rows: z.array(ReadinessRowOutcome),
  missing: z.array(ReadinessRowId),
  stale: z.array(ReadinessRowId),
  failed: z.array(ReadinessRowId),
  notApplicable: z.array(ReadinessRowId),
  enabledCapabilities: z.array(ReadinessCapability),
  binding: ReadinessBinding,
  policyVersion: VersionId,
  computedAt: Instant,
});
export type ReadinessVerdict = z.infer<typeof ReadinessVerdict>;

export const ReadinessPolicy = z.strictObject({
  version: VersionId,
  /** A COMPUTED row older than this is stale even when its binding matches. */
  computedRowMaxAgeMs: Milliseconds,
  ciEvidenceMaxAgeMs: Milliseconds,
  drillMaxAgeMs: Milliseconds,
  /** A stored verdict older than this is not consulted by arming; the worker recomputes. */
  verdictMaxAgeMs: Milliseconds,
});
export type ReadinessPolicy = z.infer<typeof ReadinessPolicy>;

export const DEFAULT_READINESS_POLICY: ReadinessPolicy = {
  version: 'readiness-v1' as VersionId,
  computedRowMaxAgeMs: 10 * 60_000,
  ciEvidenceMaxAgeMs: 30 * 86_400_000,
  drillMaxAgeMs: 30 * 86_400_000,
  verdictMaxAgeMs: 10 * 60_000,
};

/** D35 wallet reserve thresholds; monitoring and alerts only, never automatic funding. */
export const WalletReservePolicy = z.strictObject({
  version: VersionId,
  minGasLamports: Amount,
  minSettlementBaseUnits: Amount,
});
export type WalletReservePolicy = z.infer<typeof WalletReservePolicy>;

export const DEFAULT_WALLET_RESERVE_POLICY: WalletReservePolicy = {
  version: 'wallet-reserve-v1' as VersionId,
  minGasLamports: '50000000' as Amount,
  minSettlementBaseUnits: '10000000' as Amount,
};

const spec = (rowId: ReadinessRowId, kind: ReadinessRowKind, description: string, opts: { required?: boolean; requiresCapability?: ReadinessCapability | null } = {}): ReadinessRowSpec => ({ rowId, kind, required: opts.required ?? true, requiresCapability: opts.requiresCapability ?? null, description });

/**
 * Drill rows the worker can execute itself and record (M11 "every P10 drill automated where possible"):
 * CRITICAL_ALERT_DELIVERY raises, delivers, escalates and resolves a drill alert; the two executor drills run the
 * DB-down close plan against the local shadow and chain custody without submitting, and audit the journal for
 * SIGNED before SUBMITTED. SIGNER_OUTAGE_DRILL and the break-glass drill need the isolated environment and stay manual.
 */
export const AUTOMATED_DRILL_ROWS = ['CRITICAL_ALERT_DELIVERY', 'DB_DOWN_EMERGENCY_CLOSE', 'PERSIST_BEFORE_SUBMIT_DRILL'] as const;
export type AutomatedDrillRow = (typeof AUTOMATED_DRILL_ROWS)[number];

export const DrillExecutionPayload = z.object({ rowId: z.enum(AUTOMATED_DRILL_ROWS), source: z.string().max(64).optional() });
export type DrillExecutionPayload = z.infer<typeof DrillExecutionPayload>;

/** ADR-0004 row set for the deterministic `S0_SAFE` tiny-live variant, plus the §29 rows M7 made computable. */
export const TINY_LIVE_ROW_SET: readonly ReadinessRowSpec[] = [
  spec('RISK_AUTHORIZER_ISOLATION_TAMPER', 'CI_EVIDENCE', 'risk-authorizer isolation and DB-tamper tests (envelope and projection) green'),
  spec('SIGNER_DENY_EXPORT_PINNED', 'PROBE', 'deny-export active and verified for both Turnkey principals; signer policy id/digest pinned (Probe A)'),
  spec('PERSIST_BEFORE_SUBMIT_DRILL', 'DRILL', 'persist-before-submit drill green in the target environment'),
  spec('APPROVAL_BINDING_REPLAY', 'CI_EVIDENCE', 'approval hash binding and replay tests green'),
  spec('TINY_LIVE_RELEASE_BOUND', 'COMPUTED', 'tiny-live variant bound to a LIVE_APPROVAL Release with a valid step-up attestation'),
  spec('TINY_ATTESTED_CAPITAL', 'COMPUTED', 'wallet holds only tiny attested capital; recognized custody value at or below the D56 ceiling'),
  spec('RECONCILIATION_CLEAN', 'COMPUTED', 'reconciliation clean; no unknown wallet transactions'),
  spec('CRITICAL_ALERT_DELIVERY', 'DRILL', 'CRITICAL out-of-app delivery, escalation and dead-man pause tested'),
  spec('OUT_OF_BAND_CONTROLS', 'DRILL', 'out-of-band traderctl pause and close tested'),
  spec('BREAK_GLASS_SWEEP_DRILL', 'DRILL', 'break-glass revoke and SWEEP_TO_COLD_RECOVERY exercised on the probe wallet and re-run on the trading wallet'),
  spec('SIGNER_CONTRACT_PROBE_C', 'PROBE', 'Probe C (signer contract) re-run on the trading wallet'),
  spec('SIGNER_OUTAGE_DRILL', 'DRILL', 'signer-outage drill green'),
  spec('DB_DOWN_EMERGENCY_CLOSE', 'DRILL', 'DB-down emergency close tested in the target environment'),
  spec('WALLET_RESERVES', 'COMPUTED', 'wallet SOL/USDC reserve thresholds healthy (D35)'),
  spec('OPERATOR_PRESENCE_HEARTBEAT', 'COMPUTED', 'operator-presence heartbeat active and its loss pauses new entries'),
  spec('CAPITAL_ATTESTATION', 'COMPUTED', 'capital attestation recorded for the account and Release'),
  spec('CREDENTIAL_ISOLATION', 'DRILL', 'executor and risk-authorizer credentials in the isolated environment, not in any agent-readable workspace'),
  spec('ARTIFACT_EGRESS_DIGEST', 'CI_EVIDENCE', 'forbidden-package artifact scan, runtime egress test and contract-digest match green'),
  spec('OPERATOR_SURFACE_E2E', 'CI_EVIDENCE', 'minimum live operator surface E2E green: approve, reject, arm, pause, mobile close, readiness FAIL blocks arming'),
  spec('TRIGGER_LIFECYCLE', 'PROBE', 'Trigger lifecycle test green (only with provider protection; otherwise Profile 2 is MONITORED_EXIT-only)', { requiresCapability: 'PROVIDER_PROTECTION' }),
  spec('PROBE_A_SIGNER_POLICY', 'PROBE', 'Probe A: deny-export/policy administration, Profile 2 shape acceptance, malicious-shape rejection (ADR-0008)'),
  spec('NO_OPEN_CRITICAL_FINDING', 'DRILL', 'no unresolved critical/high security or financial-invariant finding from the adversarial reviews'),
  spec('INVARIANT_COVERAGE', 'CI_EVIDENCE', 'every applicable §24.6 invariant mapped with green tests for the enabled capability set (ADR-0010)'),
  spec('SINGLE_SLEEVE_PER_MINT', 'COMPUTED', 'no mint held under more than one strategy sleeve (ADR-0007)'),
  spec('CHAIN_HEALTH', 'COMPUTED', 'chain health permits entries: no halt, stalled finality, divergence or unreadable chain'),
  spec('CHAIN_FINALITY_DRILLS', 'CI_EVIDENCE', 'chain confirmation/finality/reorg/RPC-divergence drills green'),
];
