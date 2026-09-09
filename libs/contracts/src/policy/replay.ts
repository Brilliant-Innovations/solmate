import { z } from 'zod';
import { ExecutionPath } from '../enums.js';
import { CalibrationTarget, ModelWeightLookAhead } from '../entities/replay.js';
import { Fraction, Instant, Milliseconds, VersionId } from '../primitives.js';
import { DEFAULT_PAPER_FILL_POLICY, PaperFillPolicy } from './paper.js';

/**
 * Replay cost model (blueprint §18.4). Fees, slippage, price impact and the path-specific
 * MEV/adverse-execution allowance come from the same `PaperFillPolicy` the paper adapter uses,
 * so paper and replay charge every strategy identically (§32 research validity: "fees and
 * slippage charged consistently"). Replay adds what live data cannot reconstruct: a configurable
 * decision latency, the candle availability lag and an execution-failure rate sampled from the
 * run's seed.
 */
export const ReplayCostModel = z.strictObject({
  version: VersionId,
  fill: PaperFillPolicy,
  /** Added between the candidate's decision moment and the executable quote (§18.4 "configurable decision latency"). */
  decisionLatencyMs: Milliseconds,
  /** A candle bucket is readable only this long after it closes (§18.3). */
  candleAvailabilityLagMs: Milliseconds,
  /** Share of would-be fills modelled as not landed when history cannot reconstruct the failure (§18.4). */
  executionFailureRate: Fraction,
  executionPath: ExecutionPath,
});
export type ReplayCostModel = z.infer<typeof ReplayCostModel>;

export const DEFAULT_REPLAY_COST_MODEL: ReplayCostModel = {
  version: 'replay-cost-v1' as VersionId,
  fill: DEFAULT_PAPER_FILL_POLICY,
  decisionLatencyMs: 1_500,
  candleAvailabilityLagMs: 5_000,
  executionFailureRate: 0.02,
  executionPath: 'JUPITER_ORDER',
};

export const DEFAULT_CALIBRATION_TARGET: CalibrationTarget = { kind: 'NET_PNL_POSITIVE_AT_CLOSE', horizonMs: 24 * 60 * 60 * 1000 };

/** Confidence bins from §11.14; anything below 0.5 is reported as its own bin rather than dropped. */
export const CONFIDENCE_BINS: readonly { label: string; min: number; max: number }[] = [
  { label: '<0.50', min: 0, max: 0.5 },
  { label: '0.50–0.59', min: 0.5, max: 0.6 },
  { label: '0.60–0.69', min: 0.6, max: 0.7 },
  { label: '0.70–0.79', min: 0.7, max: 0.8 },
  { label: '0.80–0.89', min: 0.8, max: 0.9 },
  { label: '0.90+', min: 0.9, max: 1.000001 },
];

export function confidenceBin(confidence: number): string {
  const bin = CONFIDENCE_BINS.find((b) => confidence >= b.min && confidence < b.max);
  return bin?.label ?? 'invalid';
}

/**
 * Plan M10 addition: a model whose training cutoff lies after the window start has weights that
 * may encode the window; label the run rather than trusting it. Unknown cutoffs are labelled
 * UNKNOWN, never assumed clean.
 */
export function modelWeightLookAhead(trainingCutoff: Instant | null, window: { from: Instant }): ModelWeightLookAhead {
  if (trainingCutoff === null) return 'UNKNOWN';
  return trainingCutoff > window.from ? 'POST_WINDOW' : 'WITHIN_WINDOW';
}
