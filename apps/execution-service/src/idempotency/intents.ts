import { registerIntent, advanceIntent, emptyIntentRegistry, type IntentLifecycleState, type IntentRegistry } from '@sol-agent-trader/execution';
import type { ExecutorJournalEntry, IdempotencyKey, Uuid } from '@sol-agent-trader/contracts';

/**
 * Executor idempotency (blueprint D12, §6.13; INV-04). The pure registry in libs/execution
 * decides; this rebuilds it from the durable journal so a redelivery after a crash still finds
 * the key claimed, whatever Postgres says. Claims are journaled as ATTEMPT_PREPARED with the
 * idempotency key before any work on the intent begins.
 */
export class IdempotencyRegistry {
  private registry: IntentRegistry = emptyIntentRegistry();

  static fromJournal(entries: readonly ExecutorJournalEntry[]): IdempotencyRegistry {
    const r = new IdempotencyRegistry();
    for (const e of entries) {
      const key = e.payload['idempotencyKey'];
      const intentId = e.payload['intentId'];
      if (typeof key !== 'string' || typeof intentId !== 'string') continue;
      if (e.kind === 'ATTEMPT_PREPARED') r.claim(intentId as Uuid, key as IdempotencyKey);
      else if (e.kind === 'ATTEMPT_SUBMITTED') {
        if (r.state(key as IdempotencyKey) === 'CREATED') r.advance(key as IdempotencyKey, 'AUTHORIZED');
        r.advance(key as IdempotencyKey, 'EXECUTING');
      }
      else if (e.kind === 'ATTEMPT_RESULT') {
        const state = e.payload['lifecycle'];
        if (state === 'COMPLETED' || state === 'FAILED' || state === 'EXPIRED' || state === 'CANCELLED') r.advance(key as IdempotencyKey, state);
      }
    }
    return r;
  }

  /** Returns CREATED for a fresh key, or the existing entry for a redelivery (never a second entry). */
  claim(intentId: Uuid, key: IdempotencyKey): { outcome: 'CREATED' | 'DUPLICATE'; state: IntentLifecycleState; intentId: Uuid } {
    const r = registerIntent(this.registry, intentId, key);
    this.registry = r.registry;
    return r.outcome === 'CREATED' ? { outcome: 'CREATED', state: r.entry.state, intentId: r.entry.intentId } : { outcome: 'DUPLICATE', state: r.existing.state, intentId: r.existing.intentId };
  }

  advance(key: IdempotencyKey, to: IntentLifecycleState): boolean {
    const r = advanceIntent(this.registry, key, to);
    if (!r.ok) return false;
    this.registry = r.registry;
    return true;
  }

  state(key: IdempotencyKey): IntentLifecycleState | null {
    return this.registry.get(key)?.state ?? null;
  }
}
