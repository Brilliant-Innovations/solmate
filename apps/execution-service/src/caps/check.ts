import { addAmounts, compareAmounts, type Amount, type ExecutorGuardrails, type ProtectionMode, type RiskAuthorizedIntent } from '@sol-agent-trader/contracts';
import type { ExecutorExposureLedger } from './exposure-ledger.js';

/**
 * Deployment absolute caps (blueprint §13.7, §26.2; INV-08, INV-09). Loaded from the executor's
 * environment, never from the database, and applied after authority verification with the
 * local exposure ledger as the exposure measure. A mark-to-market view may only make the check
 * stricter: on disagreement the larger exposure is used and the entry fails closed.
 */
export interface CapCheckInput {
  guardrails: ExecutorGuardrails;
  ledger: ExecutorExposureLedger;
  intent: RiskAuthorizedIntent;
  protectionMode: ProtectionMode;
  /** Optional current mark of open exposure from a secondary price; escalates only upward. */
  markToMarketExposure: Amount | null;
}

export type CapRejection = 'CLUSTER_MISMATCH' | 'SETTLEMENT_MINT_NOT_ALLOWED' | 'SLIPPAGE_ABOVE_HARD_MAX' | 'PER_ENTRY_CAP' | 'AGGREGATE_EXPOSURE_CAP' | 'SIGNER_OUTAGE_CAP' | 'LIVE_CAPABILITY_DISABLED';

export type CapVerdict = { ok: true; projectedAggregate: Amount } | { ok: false; reasons: CapRejection[]; detail: string[] };

export function checkCaps(input: CapCheckInput): CapVerdict {
  const { guardrails: g, intent, ledger } = input;
  const reasons: CapRejection[] = [];
  const detail: string[] = [];
  const live = intent.capitalAuthority === 'LIVE_APPROVAL' || intent.capitalAuthority === 'LIVE_AUTO';
  if (live && !g.liveCapabilityEnabled) reasons.push('LIVE_CAPABILITY_DISABLED');
  if (intent.cluster !== g.cluster) reasons.push('CLUSTER_MISMATCH');
  const settlement = intent.exposureEffect === 'INCREASE' ? intent.inputMint : intent.outputMint;
  if (!g.allowedSettlementMints.includes(settlement)) reasons.push('SETTLEMENT_MINT_NOT_ALLOWED');
  if (intent.maxSlippageBps > g.hardMaxSlippageBps) reasons.push('SLIPPAGE_ABOVE_HARD_MAX');

  const current = ledger.aggregateNonSettlementExposure();
  const mark = input.markToMarketExposure;
  const base = mark !== null && compareAmounts(mark, current) > 0 ? mark : current;
  const projected = intent.exposureEffect === 'INCREASE' ? addAmounts(base, intent.maxInputAmount) : base;
  if (intent.exposureEffect === 'INCREASE') {
    if (compareAmounts(intent.maxInputAmount, g.maxPerEntryNotionalBaseUnits as Amount) > 0) {
      reasons.push('PER_ENTRY_CAP');
      detail.push(`${intent.maxInputAmount} > ${g.maxPerEntryNotionalBaseUnits}`);
    }
    if (compareAmounts(projected, g.maxAggregateNonSettlementExposureBaseUnits as Amount) > 0) {
      reasons.push('AGGREGATE_EXPOSURE_CAP');
      detail.push(`${projected} > ${g.maxAggregateNonSettlementExposureBaseUnits}${mark !== null && compareAmounts(mark, current) > 0 ? ' (mark-to-market escalated)' : ''}`);
    }
    // D33/D51 signer-outage cap, enforced here from the local ledger; the policy statement lives in libs/risk (signer-outage-cap.ts),
    // which this process may not import (GUARDRAILS Part 4), so the rule is restated: a LIVE_AUTO MONITORED_EXIT entry may not push
    // signer-dependent exposure above the deployment cap.
    if (intent.capitalAuthority === 'LIVE_AUTO' && input.protectionMode === 'MONITORED_EXIT') {
      const projectedMonitored = addAmounts(ledger.signerDependentExposure(), intent.maxInputAmount);
      if (compareAmounts(projectedMonitored, g.maxSignerOutageUnprotectedExposureBaseUnits as Amount) > 0) {
        reasons.push('SIGNER_OUTAGE_CAP');
        detail.push(`monitored exposure would be ${projectedMonitored} > ${g.maxSignerOutageUnprotectedExposureBaseUnits}`);
      }
    }
  }
  return reasons.length ? { ok: false, reasons, detail } : { ok: true, projectedAggregate: projected };
}
