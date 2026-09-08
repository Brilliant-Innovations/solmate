import type { Amount, Bps, ExposureEffect, Instant, MintAddress } from '@sol-agent-trader/contracts';

/**
 * The fields the executor acts on, whatever carried them: a risk-authorizer envelope
 * (`RiskAuthorizedIntent` satisfies this structurally) or a D22 emergency close plan built from
 * chain custody truth. Nothing outside these bounds influences what is ordered, validated,
 * simulated or signed.
 */
export interface ExecutionBounds {
  inputMint: MintAddress;
  outputMint: MintAddress;
  maxInputAmount: Amount;
  maxSlippageBps: Bps;
  maxPriceImpactBps: Bps;
  /** null: no decision quote exists (emergency close), so no chase check applies. */
  chaseToleranceBps: Bps | null;
  maxQuoteAgeMs: number;
  expiresAt: Instant;
  exposureEffect: ExposureEffect;
}
