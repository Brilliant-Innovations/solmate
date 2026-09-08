import { randomUUID } from 'node:crypto';
import type { ChainHealthPolicy, ChainHealthSnapshot, ChainView, Clock, FeedHealth, Slot, Uuid } from '@sol-agent-trader/contracts';
import { evaluateChainHealth, type PreviousHead } from '@sol-agent-trader/execution';
import type { Logger } from '@sol-agent-trader/observability';

/**
 * Worker role `chain-health` (blueprint §14.7, §40.3, D49; execution plan M7). Samples every
 * approved RPC view (confirmed head, finalized head, block height), lets the pure evaluator draw
 * the verdict, appends the snapshot and mirrors it into `ops.provider_health` as `SOLANA_CHAIN`
 * so a halt, stalled finality, divergence or an unreadable chain blocks new entries through the
 * same gate stale feeds use (cold-start gates, paper entry, executor mode facts). Read-only; the
 * worker never signs.
 */

export const CHAIN_PROVIDER = 'SOLANA_CHAIN';

export interface ChainViewSampler {
  label: string;
  sample(): Promise<{ slotConfirmed: number; slotFinalized: number; blockHeight: number }>;
}

export interface ChainHealthRepo {
  insert(snapshot: ChainHealthSnapshot): Promise<void>;
  /** Last recorded head movement, so a restart does not reset the stall clock. */
  lastHeadAdvance(): Promise<PreviousHead | null>;
  upsertFeedHealth(health: FeedHealth): Promise<void>;
}

export interface ChainHealthDeps {
  samplers: ChainViewSampler[];
  repo: ChainHealthRepo;
  policy: ChainHealthPolicy;
  clock: Clock;
  logger: Logger;
  newId?: () => Uuid;
}

export interface ChainHealthCycle {
  snapshot: ChainHealthSnapshot;
  previous: PreviousHead;
}

export async function sampleViews(samplers: ChainViewSampler[], clock: Clock): Promise<ChainView[]> {
  return Promise.all(
    samplers.map(async (s): Promise<ChainView> => {
      const started = clock.nowMs();
      try {
        const r = await s.sample();
        return { label: s.label, ok: true, slotConfirmed: r.slotConfirmed as Slot, slotFinalized: r.slotFinalized as Slot, blockHeight: r.blockHeight, latencyMs: clock.nowMs() - started, error: null };
      } catch (err) {
        return { label: s.label, ok: false, slotConfirmed: null, slotFinalized: null, blockHeight: null, latencyMs: clock.nowMs() - started, error: (err instanceof Error ? err.message : String(err)).slice(0, 512) };
      }
    }),
  );
}

export function feedHealthFrom(s: ChainHealthSnapshot): FeedHealth {
  const healthy = s.views.filter((v) => v.ok);
  const latencies = healthy.map((v) => v.latencyMs).filter((l): l is number => l !== null);
  return {
    provider: CHAIN_PROVIDER,
    state: s.state === 'HEALTHY' ? 'HEALTHY' : s.state === 'LAGGING' ? 'DEGRADED' : 'FAILED',
    lastSuccessAt: healthy.length ? s.observedAt : null,
    freshnessAgeMs: healthy.length ? 0 : null,
    latencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    rateLimitState: null,
    effectOnEntries: s.effectOnEntries,
    effectOnExits: 'NONE',
    lastError: s.reasons[0]?.slice(0, 512) ?? null,
    updatedAt: s.observedAt,
  };
}

export async function runChainHealthCycle(deps: ChainHealthDeps, previous: PreviousHead | null): Promise<ChainHealthCycle | { snapshot: ChainHealthSnapshot; previous: PreviousHead | null }> {
  const now = deps.clock.now();
  const prior = previous ?? (await deps.repo.lastHeadAdvance());
  const views = await sampleViews(deps.samplers, deps.clock);
  const { snapshot, lastAdvanceAt } = evaluateChainHealth({ id: (deps.newId ?? (() => randomUUID() as Uuid))(), views, previous: prior, policy: deps.policy, now });
  await deps.repo.insert(snapshot);
  await deps.repo.upsertFeedHealth(feedHealthFrom(snapshot));
  const level = snapshot.effectOnEntries === 'BLOCK' ? 'error' : snapshot.state === 'LAGGING' ? 'warn' : 'info';
  deps.logger[level]('chain_health_cycle', { state: snapshot.state, headSlot: snapshot.headSlot, slotAdvanced: snapshot.slotAdvanced, lagSlots: snapshot.confirmedFinalizedLagSlots, divergenceSlots: snapshot.viewDivergenceSlots, effectOnEntries: snapshot.effectOnEntries, views: views.map((v) => ({ label: v.label, ok: v.ok, slot: v.slotConfirmed, latencyMs: v.latencyMs })), reasons: snapshot.reasons });
  const next: PreviousHead | null = snapshot.headSlot === null ? prior : { headSlot: snapshot.headSlot, observedAt: now, lastAdvanceAt: lastAdvanceAt ?? now };
  return { snapshot, previous: next };
}
