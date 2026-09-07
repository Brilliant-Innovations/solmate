import type { Bps, Instant, SelfInfluencePolicy, SolanaAddress, TxSignature, Uuid } from '@sol-agent-trader/contracts';
import { addMs } from '@sol-agent-trader/contracts';

/**
 * Self-influence guard (blueprint D26, §8.6; INV-11). Three deterministic rules:
 *  1. flows with an owned endpoint are not external evidence (`excludeSelfFlows`);
 *  2. our own transaction can never be the on-chain event that qualifies a candidate;
 *  3. after our fill, confirmation for that asset is suppressed for a window proportional to our
 *     estimated impact, so a later strategy cannot read our own footprint as fresh momentum.
 * No model input reaches any of these; the policy is versioned.
 */

export interface OwnFill {
  assetId: Uuid;
  signature: TxSignature;
  filledAt: Instant;
  estimatedImpactBps: Bps;
}

export interface SuppressionWindow {
  assetId: Uuid;
  signature: TxSignature;
  from: Instant;
  until: Instant;
}

export function suppressionWindowMs(policy: SelfInfluencePolicy, impactBps: number): number {
  const excess = Math.max(0, impactBps - policy.impactFloorBps);
  return Math.min(policy.maxWindowMs, policy.baseWindowMs + excess * policy.perImpactBpsMs);
}

export function suppressionWindow(policy: SelfInfluencePolicy, fill: OwnFill): SuppressionWindow {
  return { assetId: fill.assetId, signature: fill.signature, from: fill.filledAt, until: addMs(fill.filledAt, suppressionWindowMs(policy, fill.estimatedImpactBps)) };
}

export function activeSuppression(windows: readonly SuppressionWindow[], assetId: Uuid, now: Instant): SuppressionWindow | null {
  const t = Date.parse(now);
  return windows.find((w) => w.assetId === assetId && Date.parse(w.from) <= t && t < Date.parse(w.until)) ?? null;
}

export function excludeSelfFlows<T extends { fromOwner: string | null; toOwner: string | null }>(flows: readonly T[], isOwned: (address: string) => boolean): T[] {
  return flows.filter((f) => !(f.fromOwner !== null && isOwned(f.fromOwner)) && !(f.toOwner !== null && isOwned(f.toOwner)));
}

export interface CandidateEvidence {
  assetId: Uuid;
  /** On-chain transactions the trigger cites as its qualifying events. */
  evidenceSignatures: readonly TxSignature[];
  /** Wallets whose behaviour the trigger cites (smart money, whales). */
  evidenceWallets: readonly SolanaAddress[];
  /** True when the trigger relies on aggregate provider metrics we cannot subtract our trade from. */
  usesAggregateMetrics: boolean;
}

export interface SelfInfluenceContext {
  isOwned: (address: string) => boolean;
  ownSignatures: ReadonlySet<string>;
  windows: readonly SuppressionWindow[];
  now: Instant;
}

export type SelfInfluenceVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'SELF_TRANSACTION_AS_EVIDENCE' | 'OWNED_WALLET_AS_EVIDENCE' | 'SELF_TRADE_SUPPRESSION_WINDOW'; detail: string };

/** Deterministic candidate gate: any self-evidence or an open suppression window rejects. */
export function selfInfluenceCheck(evidence: CandidateEvidence, ctx: SelfInfluenceContext): SelfInfluenceVerdict {
  const selfTx = evidence.evidenceSignatures.find((s) => ctx.ownSignatures.has(s));
  if (selfTx) return { allowed: false, reason: 'SELF_TRANSACTION_AS_EVIDENCE', detail: selfTx };
  const ownedWallet = evidence.evidenceWallets.find((w) => ctx.isOwned(w));
  if (ownedWallet) return { allowed: false, reason: 'OWNED_WALLET_AS_EVIDENCE', detail: ownedWallet };
  if (evidence.usesAggregateMetrics) {
    const w = activeSuppression(ctx.windows, evidence.assetId, ctx.now);
    if (w) return { allowed: false, reason: 'SELF_TRADE_SUPPRESSION_WINDOW', detail: `until ${w.until} (fill ${w.signature})` };
  }
  return { allowed: true };
}
