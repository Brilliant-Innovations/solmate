import type { IdempotencyKey, Uuid } from '@sol-agent-trader/contracts';

/**
 * Intent lifecycle and idempotency registry (blueprint D12, §6.13, INV-04).
 *
 * An intent's idempotency key is stable across worker redeliveries. At most one *active* intent
 * may exist per key; a duplicate delivery returns the existing intent instead of creating another.
 * A new intent under the same key is allowed only after the previous one reached a terminal state.
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
  | { outcome: 'DUPLICATE_ACTIVE'; registry: IntentRegistry; existing: IntentEntry };

/** Register a new intent. A redelivery with an active key returns the existing entry unchanged. */
export function registerIntent(registry: IntentRegistry, intentId: Uuid, idempotencyKey: IdempotencyKey): RegisterResult {
  const existing = registry.get(idempotencyKey);
  if (existing && !isIntentTerminal(existing.state)) return { outcome: 'DUPLICATE_ACTIVE', registry, existing };
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
