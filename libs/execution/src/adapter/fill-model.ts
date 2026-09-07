import { amountToBigInt, applyBps, bigIntToAmount, instantToMs, mulDiv, type Amount, type Bps, type ExecutionPath, type ExecutionRejection, type Instant, type PaperFillPolicy, type Quote, type TradeIntent } from '@sol-agent-trader/contracts';

/**
 * The paper fill model (blueprint §17.1–17.4, D48; execution plan M5a). Pure and total: given the
 * intent, the decision-time quote, the executable quote observed after the modelled submission
 * delay and the policy, it returns either a fill or a typed rejection at the stage live execution
 * would have refused. The checks mirror the live pre-submit chain: intent expiry, decision-quote
 * age, route presence, chase tolerance, impact cap; then the on-chain outcome: a modelled output
 * below the executable quote's minimum output is a failed transaction (NOT_LANDED), not a fill.
 *
 * A stale decision price can never pose as a later executable fill: the output is always derived
 * from the executable quote, and the decision quote only supplies the shortfall reference.
 */

export interface FillModelInput {
  intent: TradeIntent;
  decisionQuote: Quote;
  /** Quote taken at the modelled submission moment; null when no route existed then. */
  executableQuote: Quote | null;
  path: ExecutionPath;
  policy: PaperFillPolicy;
  /** Modelled submission moment (decision time + submissionDelayMs). */
  executionAt: Instant;
}

export interface ModelledFees {
  networkBaseUnits: Amount;
  priorityBaseUnits: Amount;
  routerBaseUnits: Amount;
  transferFeeBaseUnits: Amount;
}

export type FillModelOutcome =
  | {
      kind: 'FILL';
      inputAmount: Amount;
      outputAmount: Amount;
      minOutputAmount: Amount;
      adverseAllowanceBps: Bps;
      /** Shortfall of the modelled output against the decision quote's expected output, in bps; negative when price improved. */
      executionShortfallBps: number;
      fees: ModelledFees;
      executableQuote: Quote;
    }
  | { kind: 'REJECT'; stage: 'PRE_SUBMIT'; reason: ExecutionRejection; detail: string }
  | { kind: 'REJECT'; stage: 'NOT_LANDED'; reason: 'SLIPPAGE_EXCEEDED'; detail: string; fees: ModelledFees; executableQuote: Quote };

/** Output per input unit at 1e12 resolution, so sub-bps moves survive integer division. */
const priceScaled = (q: Quote): bigint => (amountToBigInt(q.expectedOutputAmount) * 1_000_000_000_000n) / amountToBigInt(q.inputAmount);

export function modelPaperFill(input: FillModelInput): FillModelOutcome {
  const { intent, decisionQuote: d, executableQuote: x, policy } = input;
  const execMs = instantToMs(input.executionAt);
  if (execMs >= instantToMs(intent.expiresAt)) return { kind: 'REJECT', stage: 'PRE_SUBMIT', reason: 'INTENT_EXPIRED', detail: `execution at ${input.executionAt} not before intent expiry ${intent.expiresAt}` };
  const decisionAge = execMs - instantToMs(d.quotedAt);
  if (decisionAge > intent.constraints.maxQuoteAgeMs) return { kind: 'REJECT', stage: 'PRE_SUBMIT', reason: 'QUOTE_STALE', detail: `decision quote age ${decisionAge}ms > ${intent.constraints.maxQuoteAgeMs}ms` };
  if (!x) return { kind: 'REJECT', stage: 'PRE_SUBMIT', reason: 'NO_ROUTE', detail: 'no executable route at the modelled submission moment' };
  if (amountToBigInt(d.inputAmount) === 0n || amountToBigInt(x.inputAmount) === 0n) return { kind: 'REJECT', stage: 'PRE_SUBMIT', reason: 'NO_ROUTE', detail: 'zero input amount' };
  // The order is built for the intent's amount; a quote for any other amount is a provider anomaly, never a fill (INV-02).
  if (amountToBigInt(x.inputAmount) !== amountToBigInt(intent.maxInputAmount)) return { kind: 'REJECT', stage: 'PRE_SUBMIT', reason: 'QUOTE_AMOUNT_MISMATCH', detail: `executable quote for ${x.inputAmount}, intent ${intent.maxInputAmount}` };
  if (x.priceImpactBps === null || x.priceImpactBps > intent.constraints.maxPriceImpactBps) return { kind: 'REJECT', stage: 'PRE_SUBMIT', reason: 'IMPACT_ABOVE_MAX', detail: `impact ${x.priceImpactBps ?? 'unknown'}bps > ${intent.constraints.maxPriceImpactBps}bps` };
  // Chase: executable output per input unit worse than the decision's by more than the tolerance.
  const dPrice = priceScaled(d);
  const xPrice = priceScaled(x);
  if (dPrice > 0n) {
    const worseBps = Number(((dPrice - xPrice) * 10_000n) / dPrice);
    if (worseBps > intent.constraints.chaseToleranceBps) return { kind: 'REJECT', stage: 'PRE_SUBMIT', reason: 'CHASE_EXCEEDED', detail: `executable price ${worseBps}bps worse than decision > ${intent.constraints.chaseToleranceBps}bps` };
  }

  const adverse = policy.adverseAllowanceBpsByPath[input.path] ?? (0 as Bps);
  const modelled = applyBps(x.expectedOutputAmount, 10_000 - adverse, 'FLOOR');
  const fees: ModelledFees = {
    networkBaseUnits: policy.fees.networkLamports,
    priorityBaseUnits: policy.fees.priorityLamports,
    routerBaseUnits: applyBps(x.inputAmount, policy.fees.routerBps, 'CEIL'),
    transferFeeBaseUnits: applyBps(modelled, policy.fees.transferFeeBps, 'CEIL'),
  };
  if (amountToBigInt(modelled) < amountToBigInt(x.minOutputAmount)) {
    return { kind: 'REJECT', stage: 'NOT_LANDED', reason: 'SLIPPAGE_EXCEEDED', detail: `modelled output ${modelled} < minimum ${x.minOutputAmount}`, fees, executableQuote: x };
  }
  const netOutput = bigIntToAmount(amountToBigInt(modelled) - amountToBigInt(fees.transferFeeBaseUnits));
  const expected = amountToBigInt(d.expectedOutputAmount);
  const shortfallBps = expected > 0n ? Number(((expected - amountToBigInt(netOutput)) * 10_000n) / expected) : 0;
  return { kind: 'FILL', inputAmount: x.inputAmount, outputAmount: netOutput, minOutputAmount: x.minOutputAmount, adverseAllowanceBps: adverse, executionShortfallBps: shortfallBps, fees, executableQuote: x };
}

/** Modelled per-token entry price in settlement units per whole token, for position analytics only (money stays in base units). */
export function impliedPrice(inputAmount: Amount, inputDecimals: number, outputAmount: Amount, outputDecimals: number): number | null {
  const out = amountToBigInt(outputAmount);
  if (out === 0n) return null;
  // price = (input / 10^inDec) / (output / 10^outDec)
  const scaled = mulDiv(inputAmount, 10n ** BigInt(outputDecimals) * 1_000_000_000n, out * 10n ** BigInt(inputDecimals), 'HALF_UP');
  return Number(amountToBigInt(scaled)) / 1e9;
}
