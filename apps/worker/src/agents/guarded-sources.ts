import type { Instant } from '@sol-agent-trader/contracts';
import { guardSources, type GuardContext } from '@sol-agent-trader/replay';
import type { ContextSources } from '@sol-agent-trader/skills';

/**
 * Look-ahead enforcement across the proposer, the adversary and every skill tool (blueprint
 * §18.3, P9; INV-13). Every `ContextSources` method carries the moment it reads as of; this map
 * names where, and `guardSources` refuses any call whose moment lies after the clock (replay) or
 * after now (live) before the repository is touched. A method missing from the map is refused
 * outright, so adding a source without deciding its point-in-time argument cannot pass silently.
 */
export const CONTEXT_SOURCE_AS_OF: Record<keyof ContextSources, number> = {
  candidate: 1,
  position: 1,
  featureSnapshotAt: 1,
  marketSnapshotAt: 1,
  eligibilityAt: 1,
  safetyAt: 1,
  eventsVisibleAt: 1,
  onchainAt: 1,
  portfolioAt: 1,
  executionPreview: 2,
  cohortPeers: 1,
};

export function guardedContextSources(sources: ContextSources, ctx: GuardContext): ContextSources {
  return guardSources(sources as unknown as Record<string, (...args: never[]) => unknown>, ctx, (method, args) => {
    const index = CONTEXT_SOURCE_AS_OF[method as keyof ContextSources];
    if (index === undefined) return null;
    const asOf = args[index];
    return typeof asOf === 'string' && !Number.isNaN(Date.parse(asOf)) ? (asOf as Instant) : null;
  }) as unknown as ContextSources;
}
