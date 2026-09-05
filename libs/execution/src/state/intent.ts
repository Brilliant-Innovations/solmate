import type { IdempotencyKey, Uuid } from '@sol-agent-trader/contracts';

/**
 * Intent lifecycle and idempotency registry (blueprint D12, §6.13, INV-04).
 *
 * An intent's idempotency key is stable across worker redeliveries and is claimed **permanently**
 * once used: a redelivery returns the existing intent whatever its state, including COMPLETED,
 * so the canonical queue failure (execute, die before ack, redeliver) can never create a second
 * entry (review #0 F3). A retry after a conclusively failed attempt is a new attempt of the same
 * intent, never a new intent under the same key.
 */

export type IntentLifecycleState = 'CREATED' | 'AUTHORIZED' | 'APPROVED' | 'EXECUTING' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED' | 'FAILED';

const TERMINAL: ReadonlySet<IntentLifecycleState> = new Set(['COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED']);

export interface IntentEntry {
  intentId: Uuid;
  idempotencyKey: IdempotencyKey;
  state: IntentLifecycleState;
}

export type IntentRegistry = ReadonlyMap<IdempotencyKey, IntentEntry>;

export function emptyIntentRegistry(): IntentRegistry {
  return new Map();
}

export function isIntentTerminal(state: IntentLifecycleState): boolean {
  return TERMINAL.has(state);
}

export type RegisterResult =
  | { outcome: 'CREATED'; registry: IntentRegistry; entry: IntentEntry }
  | { outcome: 'DUPLICATE'; registry: IntentRegistry; existing: IntentEntry };

/** Register a new intent. Any redelivery of a known key returns the existing entry unchanged. */
export function registerIntent(registry: IntentRegistry, intentId: Uuid, idempotencyKey: IdempotencyKey): RegisterResult {
  const existing = registry.get(idempotencyKey);
  if (existing) return { outcome: 'DUPLICATE', registry, existing };
  const entry: IntentEntry = { intentId, idempotencyKey, state: 'CREATED' };
  const next = new Map(registry);
  next.set(idempotencyKey, entry);
  return { outcome: 'CREATED', registry: next, entry };
}

const ALLOWED: Record<IntentLifecycleState, readonly IntentLifecycleState[]> = {
  CREATED: ['AUTHORIZED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  AUTHORIZED: ['APPROVED', 'EXECUTING', 'EXPIRED', 'CANCELLED', 'FAILED'],
  APPROVED: ['EXECUTING', 'EXPIRED', 'CANCELLED', 'FAILED'],
  EXECUTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
};

export type IntentTransitionResult =
  | { ok: true; registry: IntentRegistry; entry: IntentEntry }
  | { ok: false; code: 'UNKNOWN_KEY' | 'INVALID_TRANSITION'; from?: IntentLifecycleState; to: IntentLifecycleState };

export function advanceIntent(registry: IntentRegistry, idempotencyKey: IdempotencyKey, to: IntentLifecycleState): IntentTransitionResult {
  const existing = registry.get(idempotencyKey);
  if (!existing) return { ok: false, code: 'UNKNOWN_KEY', to };
  if (!ALLOWED[existing.state].includes(to)) return { ok: false, code: 'INVALID_TRANSITION', from: existing.state, to };
  const entry = { ...existing, state: to };
  const next = new Map(registry);
  next.set(idempotencyKey, entry);
  return { ok: true, registry: next, entry };
}

export function activeIntents(registry: IntentRegistry): IntentEntry[] {
  return [...registry.values()].filter((e) => !isIntentTerminal(e.state));
}
