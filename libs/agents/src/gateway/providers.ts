import type { AdversarialReviewInput, ModelCallMetadata, TradingSkillContext, VersionId } from '@sol-agent-trader/contracts';
import { ModelTimeoutError, type ModelCall, type ModelIdentity, type ReasoningModel } from '../runner/model.js';
import { ADVERSARY_PROMPT_VERSION, PROPOSER_PROMPT_VERSION, adversaryMessages, proposalJsonSchema, proposerMessages, reviewJsonSchema } from './prompts.js';
import { fetchModelTransport, type ModelHttpTransport } from './transport.js';

/**
 * Provider adapters for the reasoning model (blueprint §11.2). Each returns the raw structured
 * output plus call metadata; validation is the runner's job. Keys are read from the worker
 * environment only (D65: never from a file a coding agent can read). Cost is computed from a
 * pricing table the worker passes in; an unknown model is recorded at zero cost and flagged so
 * `docs/costs.md` can be corrected when the run-rate is measured.
 */

export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface ProviderModelOptions {
  apiKey: string;
  model: string;
  temperature: number | null;
  maxOutputTokens: number;
  timeoutMs: number;
  pricing: ModelPricing | null;
  transport?: ModelHttpTransport;
  baseUrl?: string;
}

export type ModelProvider = 'anthropic' | 'openai';

export function parseModelSpec(spec: string): { provider: ModelProvider; model: string } {
  const [provider, ...rest] = spec.split(':');
  const model = rest.join(':');
  if ((provider !== 'anthropic' && provider !== 'openai') || model.length === 0) throw new Error(`model spec must be "anthropic:<model>" or "openai:<model>", got ${JSON.stringify(spec)}`);
  return { provider, model };
}

export function costUsd(pricing: ModelPricing | null, tokens: { input: number; output: number }): number {
  if (!pricing) return 0;
  return (tokens.input * pricing.inputUsdPerMTok + tokens.output * pricing.outputUsdPerMTok) / 1_000_000;
}

function isAbort(e: unknown): boolean {
  return (e instanceof Error && (e.name === 'AbortError' || e.message === 'timeout')) || (typeof e === 'object' && e !== null && 'name' in e && (e as { name: unknown }).name === 'AbortError');
}

abstract class BaseProviderModel implements ReasoningModel {
  protected readonly transport: ModelHttpTransport;
  constructor(
    readonly provider: ModelProvider,
    protected readonly opts: ProviderModelOptions,
  ) {
    this.transport = opts.transport ?? fetchModelTransport;
  }

  identity(): ModelIdentity {
    return { provider: this.provider, model: this.opts.model, promptVersion: PROPOSER_PROMPT_VERSION as VersionId };
  }

  proposeTradingAction(input: TradingSkillContext, signal: AbortSignal): Promise<ModelCall> {
    const m = proposerMessages(input);
    return this.call('emit_proposal', 'The proposal as a TradingActionProposal object.', proposalJsonSchema(), m.system, m.user, PROPOSER_PROMPT_VERSION as VersionId, signal);
  }

  adversariallyReviewAction(input: AdversarialReviewInput, signal: AbortSignal): Promise<ModelCall> {
    const m = adversaryMessages(input);
    return this.call('emit_review', 'The verdict as an AdversarialReviewOutput object.', reviewJsonSchema(), m.system, m.user, ADVERSARY_PROMPT_VERSION as VersionId, signal);
  }

  protected abstract call(toolName: string, toolDescription: string, schema: Record<string, unknown>, system: string, user: string, promptVersion: VersionId, signal: AbortSignal): Promise<ModelCall>;

  protected async post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    let res;
    try {
      res = await this.transport({ method: 'POST', url, headers, body: JSON.stringify(body), timeoutMs: this.opts.timeoutMs, signal });
    } catch (e) {
      if (isAbort(e) || signal.aborted) throw new ModelTimeoutError(`${this.provider} call aborted`);
      throw e;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`${this.provider} ${res.status}: ${res.body.slice(0, 300)}`);
    return JSON.parse(res.body) as Record<string, unknown>;
  }

  protected metadata(promptVersion: VersionId, tokens: { input: number; output: number }): ModelCallMetadata {
    return { provider: this.provider, model: this.opts.model, promptVersion, temperature: this.opts.temperature, tokens, costUsd: costUsd(this.opts.pricing, tokens) };
  }
}

/** Anthropic Messages API with a forced tool call carrying the output schema. */
export class AnthropicReasoningModel extends BaseProviderModel {
  constructor(opts: ProviderModelOptions) {
    super('anthropic', opts);
  }

  protected async call(toolName: string, toolDescription: string, schema: Record<string, unknown>, system: string, user: string, promptVersion: VersionId, signal: AbortSignal): Promise<ModelCall> {
    const body = {
      model: this.opts.model,
      max_tokens: this.opts.maxOutputTokens,
      ...(this.opts.temperature === null ? {} : { temperature: this.opts.temperature }),
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{ name: toolName, description: toolDescription, input_schema: schema }],
      tool_choice: { type: 'tool', name: toolName },
    };
    const json = await this.post(`${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' }, body, signal);
    const content = Array.isArray(json['content']) ? (json['content'] as Array<Record<string, unknown>>) : [];
    const tool = content.find((c) => c['type'] === 'tool_use' && c['name'] === toolName);
    const usage = (json['usage'] as Record<string, unknown> | undefined) ?? {};
    const tokens = { input: Number(usage['input_tokens'] ?? 0), output: Number(usage['output_tokens'] ?? 0) };
    return { output: tool ? tool['input'] : { error: 'no tool_use block', stopReason: json['stop_reason'] ?? null }, metadata: this.metadata(promptVersion, tokens) };
  }
}

/** OpenAI Chat Completions with a strict JSON-schema response format. */
export class OpenAIReasoningModel extends BaseProviderModel {
  constructor(opts: ProviderModelOptions) {
    super('openai', opts);
  }

  protected async call(toolName: string, _toolDescription: string, schema: Record<string, unknown>, system: string, user: string, promptVersion: VersionId, signal: AbortSignal): Promise<ModelCall> {
    const body = {
      model: this.opts.model,
      max_completion_tokens: this.opts.maxOutputTokens,
      ...(this.opts.temperature === null ? {} : { temperature: this.opts.temperature }),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: toolName, schema, strict: false } },
    };
    const json = await this.post(`${this.opts.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`, { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` }, body, signal);
    const choices = Array.isArray(json['choices']) ? (json['choices'] as Array<Record<string, unknown>>) : [];
    const message = (choices[0]?.['message'] as Record<string, unknown> | undefined) ?? {};
    const usage = (json['usage'] as Record<string, unknown> | undefined) ?? {};
    const tokens = { input: Number(usage['prompt_tokens'] ?? 0), output: Number(usage['completion_tokens'] ?? 0) };
    let output: unknown;
    try {
      output = typeof message['content'] === 'string' ? JSON.parse(message['content']) : { error: 'no content', refusal: message['refusal'] ?? null };
    } catch {
      output = { error: 'content is not JSON' };
    }
    return { output, metadata: this.metadata(promptVersion, tokens) };
  }
}

export interface ProviderKeys {
  anthropic: string | null;
  openai: string | null;
}

/** A model for a spec, or null with the reason when its provider key is absent. */
export function createReasoningModel(spec: string, keys: ProviderKeys, opts: Omit<ProviderModelOptions, 'apiKey' | 'model'>): { model: ReasoningModel } | { model: null; reason: string } {
  const { provider, model } = parseModelSpec(spec);
  const apiKey = keys[provider];
  if (!apiKey) return { model: null, reason: `${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} not set for ${spec}` };
  return { model: provider === 'anthropic' ? new AnthropicReasoningModel({ ...opts, apiKey, model }) : new OpenAIReasoningModel({ ...opts, apiKey, model }) };
}
