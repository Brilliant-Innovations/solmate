import { addMs, type Instant, type ReplayCostModel } from '@sol-agent-trader/contracts';

/**
 * Replay cost-model helpers (blueprint §18.4). The fill arithmetic itself lives in the execution
 * library's paper fill model, which the engine calls with `model.fill`; this module supplies the
 * pieces that only replay has: the modelled moments and a seeded execution-failure draw. Every
 * draw is deterministic in the run seed and the draw index, so a re-run with the same seed makes
 * the same fills fail (§18.5 "random seeds if applicable").
 */

/** mulberry32: small, fast, deterministic; enough for a Bernoulli failure draw, not for security. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ExecutionFailureSampler {
  private readonly next: () => number;
  private draws = 0;

  constructor(
    seed: number,
    private readonly failureRate: number,
  ) {
    this.next = seededRandom(seed);
  }

  /** True when this attempt is modelled as not landed. The draw index is recorded so the decision row can cite it. */
  sample(): { failed: boolean; draw: number; index: number } {
    const draw = this.next();
    const index = this.draws++;
    return { failed: draw < this.failureRate, draw, index };
  }
}

/** Candidate decision moment → the moment the executable quote is taken (decision latency, then the paper submission delay). */
export function modelledExecutionAt(decisionAt: Instant, model: ReplayCostModel): Instant {
  return addMs(decisionAt, model.decisionLatencyMs + model.fill.submissionDelayMs);
}

/** Plan M10 addition: the baseline decided at the AI strategy's latency, so speed alone cannot explain a gap. */
export function latencyMatchedDecisionAt(candidateAt: Instant, aiDecisionLatencyMs: number): Instant {
  return addMs(candidateAt, Math.max(0, aiDecisionLatencyMs));
}
