import {
  canonicalize,
  sha256Hex,
  TOOL_ARGUMENT_SCHEMAS,
  type Clock,
  type Instant,
  type ToolArguments,
  type ToolInvocation,
  type ToolManifest,
  type ToolName,
  type ToolRefusal,
  type ToolRefusalReason,
  type ToolScope,
  type Uuid,
} from '@sol-agent-trader/contracts';
import { isRegisteredTool, loadManifest, toolEntry } from './manifest.js';
import { checkScope, newRunLedger, type RunLedger } from './scope.js';

/**
 * Tool registry and audited invoker for the Trading Skill (blueprint §11.4, §11.13; INV-16).
 *
 * A handler exists only for a manifest tool, and the handler map must cover the manifest exactly: an
 * extra handler is a construction error, a missing one too. Invocation goes name → manifest → strict
 * argument schema → scope resolution → budget → handler, and every call, refused or not, leaves an
 * audit record with the request hash and cutoff version. Handlers receive the resolved scope and
 * the cutoff instant; they never see the raw model text.
 */

export interface ToolResponse {
  /** Row references returned to the model (evidence ids, snapshot ids); evidence ids become citable. */
  refs: readonly string[];
  /** Evidence ids among the refs, which the run may now cite in a proposal. */
  evidenceIds?: readonly Uuid[];
  payload: Record<string, unknown>;
}

export type ToolHandler<K extends ToolName> = (input: { args: ToolArguments[K]; scope: ToolScope; asOf: Instant }) => Promise<ToolResponse>;
export type ToolHandlers = { [K in ToolName]: ToolHandler<K> };

export interface ToolAuditSink {
  invocation(row: ToolInvocation): Promise<void>;
  refusal(row: ToolRefusal): Promise<void>;
}

export interface RunContext {
  agentRunId: Uuid;
  scope: ToolScope;
}

export interface ToolCall {
  name: unknown;
  arguments: unknown;
}

export type ToolResult =
  | { ok: true; name: ToolName; response: ToolResponse; invocation: ToolInvocation }
  | { ok: false; reason: ToolRefusalReason; detail: string; refusal: ToolRefusal };

export interface ToolRegistryOptions {
  manifest?: unknown;
  handlers: ToolHandlers;
  audit: ToolAuditSink;
  clock: Clock;
  newId: () => Uuid;
}

export class ToolRegistry {
  readonly manifest: ToolManifest;
  private readonly handlers: ToolHandlers;
  private readonly audit: ToolAuditSink;
  private readonly clock: Clock;
  private readonly newId: () => Uuid;
  private readonly ledgers = new Map<Uuid, RunLedger>();

  constructor(opts: ToolRegistryOptions) {
    this.manifest = loadManifest(opts.manifest);
    const names = new Set<string>(this.manifest.tools.map((t) => t.name));
    for (const key of Object.keys(opts.handlers)) {
      if (!names.has(key)) throw new Error(`handler for unregistered tool ${key}`);
    }
    for (const name of names) {
      if (typeof (opts.handlers as Record<string, unknown>)[name] !== 'function') throw new Error(`no handler for manifest tool ${name}`);
    }
    this.handlers = opts.handlers;
    this.audit = opts.audit;
    this.clock = opts.clock;
    this.newId = opts.newId;
  }

  /** Tool descriptions offered to the model: names, versions and argument schema names only. */
  offered(): ReadonlyArray<{ name: ToolName; version: string; classification: string; description: string }> {
    return this.manifest.tools.map((t) => ({ name: t.name, version: t.version, classification: t.classification, description: t.description }));
  }

  ledger(run: RunContext): RunLedger {
    let l = this.ledgers.get(run.agentRunId);
    if (!l) {
      l = newRunLedger(run.scope);
      this.ledgers.set(run.agentRunId, l);
    }
    return l;
  }

  /** Closes a run: further calls are refused as RUN_CLOSED. Returns the evidence ids the run saw. */
  close(run: RunContext): { seenEvidenceIds: Uuid[]; invocations: number; proposals: number } {
    const l = this.ledger(run);
    l.closed = true;
    return { seenEvidenceIds: [...l.seenEvidenceIds], invocations: l.invocations, proposals: l.proposals };
  }

  async invoke(run: RunContext, call: ToolCall): Promise<ToolResult> {
    const ledger = this.ledger(run);
    const requestedTool = typeof call.name === 'string' ? call.name.slice(0, 64) : String(call.name).slice(0, 64);
    const requestText = safeCanonical({ name: call.name, arguments: call.arguments });
    const requestHash = await sha256Hex(requestText);
    const refuse = async (reason: ToolRefusalReason, detail: string): Promise<ToolResult> => {
      const refusal: ToolRefusal = { id: this.newId(), agentRunId: run.agentRunId, actionCycleId: run.scope.actionCycleId, requestedTool, reason, detail: detail.slice(0, 1024), requestHash, cutoffVersion: run.scope.cutoffVersion, createdAt: this.clock.now() };
      await this.audit.refusal(refusal);
      return { ok: false, reason, detail: refusal.detail, refusal };
    };

    if (ledger.closed) return refuse('RUN_CLOSED', 'agent run is closed');
    if (!isRegisteredTool(this.manifest, call.name)) return refuse('UNREGISTERED_TOOL', `no tool named ${JSON.stringify(requestedTool)} in manifest ${this.manifest.version}`);
    const name: ToolName = call.name;
    if (ledger.invocations >= this.manifest.maxInvocationsPerRun) return refuse('INVOCATION_LIMIT', `run exceeded ${this.manifest.maxInvocationsPerRun} tool calls`);
    const size = Buffer.byteLength(requestText, 'utf8');
    if (size > this.manifest.maxArgumentBytes) return refuse('ARGUMENTS_TOO_LARGE', `${size} bytes > ${this.manifest.maxArgumentBytes}`);
    const parsed = TOOL_ARGUMENT_SCHEMAS[name].safeParse(call.arguments);
    if (!parsed.success) return refuse('INVALID_ARGUMENTS', parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; '));
    const args = parsed.data as ToolArguments[typeof name];
    const violation = checkScope(name, args, run.scope, ledger);
    if (violation) return refuse(violation.reason, violation.detail);
    const entry = toolEntry(this.manifest, name);
    if (entry.classification === 'PROPOSAL_ONLY' && ledger.proposals >= this.manifest.maxProposalsPerRun) return refuse('PROPOSAL_LIMIT', `run already submitted ${ledger.proposals} proposal(s)`);

    ledger.invocations += 1;
    const started = this.clock.nowMs();
    let response: ToolResponse | null = null;
    let error: string | null = null;
    try {
      response = await (this.handlers[name] as ToolHandler<typeof name>)({ args, scope: run.scope, asOf: run.scope.cutoffAt });
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 1024);
    }
    const latencyMs = Math.max(0, this.clock.nowMs() - started);
    if (response) {
      for (const id of response.evidenceIds ?? []) ledger.seenEvidenceIds.add(id);
      if (entry.classification === 'PROPOSAL_ONLY') ledger.proposals += 1;
    }
    const invocation: ToolInvocation = {
      id: this.newId(),
      agentRunId: run.agentRunId,
      actionCycleId: run.scope.actionCycleId,
      toolName: name,
      toolVersion: entry.version,
      classification: entry.classification,
      requestHash,
      responseRefs: response ? [...response.refs] : [],
      cutoffVersion: run.scope.cutoffVersion,
      latencyMs,
      error,
      createdAt: this.clock.now(),
    };
    await this.audit.invocation(invocation);
    if (!response) {
      const refusal: ToolRefusal = { id: invocation.id, agentRunId: run.agentRunId, actionCycleId: run.scope.actionCycleId, requestedTool, reason: 'HANDLER_FAILED', detail: error ?? 'handler failed', requestHash, cutoffVersion: run.scope.cutoffVersion, createdAt: invocation.createdAt };
      return { ok: false, reason: 'HANDLER_FAILED', detail: refusal.detail, refusal };
    }
    return { ok: true, name, response, invocation };
  }
}

/** Canonical JSON when representable; otherwise a lossy but deterministic fallback, so hashing never throws on model output. */
export function safeCanonical(value: unknown): string {
  try {
    return canonicalize(value);
  } catch {
    try {
      return JSON.stringify(value, (_k, v: unknown) => (v === undefined || typeof v === 'function' || typeof v === 'symbol' ? null : typeof v === 'bigint' ? v.toString() : v)) ?? 'null';
    } catch {
      return String(value);
    }
  }
}

export function createToolRegistry(opts: ToolRegistryOptions): ToolRegistry {
  return new ToolRegistry(opts);
}

/** An in-memory audit sink for tests and dry runs. */
export function memoryAuditSink(): ToolAuditSink & { invocations: ToolInvocation[]; refusals: ToolRefusal[] } {
  const invocations: ToolInvocation[] = [];
  const refusals: ToolRefusal[] = [];
  return {
    invocations,
    refusals,
    async invocation(row) {
      invocations.push(row);
    },
    async refusal(row) {
      refusals.push(row);
    },
  };
}
