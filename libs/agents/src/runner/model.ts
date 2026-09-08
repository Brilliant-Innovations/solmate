import type { AdversarialReviewInput, ModelCallMetadata, TradingSkillContext } from '@sol-agent-trader/contracts';

/**
 * Provider-pluggable reasoning model (blueprint §11.2). The gateway returns the model's raw
 * structured output plus call metadata; validation against the typed contracts happens in the
 * runner so a malformed or hallucinated output is handled in one place. An adapter must honour
 * `signal` (abort on the cycle deadline) and throw `ModelTimeoutError` when it stops for time.
 */
export interface ModelCall {
  output: unknown;
  metadata: ModelCallMetadata;
}

export interface ModelIdentity {
  provider: string;
  model: string;
  promptVersion: ModelCallMetadata['promptVersion'];
}

export interface ReasoningModel {
  identity(): ModelIdentity;
  proposeTradingAction(input: TradingSkillContext, signal: AbortSignal): Promise<ModelCall>;
  adversariallyReviewAction(input: AdversarialReviewInput, signal: AbortSignal): Promise<ModelCall>;
}

export class ModelTimeoutError extends Error {
  constructor(message = 'model call timed out') {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}
