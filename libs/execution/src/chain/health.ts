import { instantToMs, type ChainHealthPolicy, type ChainHealthSnapshot, type ChainView, type Instant, type Slot, type Uuid } from '@sol-agent-trader/contracts';

/**
 * Chain-health verdict from independent RPC views (blueprint §14.7, §40.3). Pure: the worker
 * samples, this decides. Entries are blocked for STALLED (halt or stalled finality), DIVERGENT
 * (views materially disagree) and UNAVAILABLE (no view answered); LAGGING only surfaces.
 */

export interface PreviousHead {
  headSlot: Slot;
  observedAt: Instant;
  /** When the head last moved; the stall clock starts here, not at the previous sample. */
  lastAdvanceAt: Instant;
}

export function evaluateChainHealth(input: { id: Uuid; views: ChainView[]; previous: PreviousHead | null; policy: ChainHealthPolicy; now: Instant }): { snapshot: ChainHealthSnapshot; lastAdvanceAt: Instant | null } {
  const { policy, now } = input;
  const healthy = input.views.filter((v) => v.ok && v.slotConfirmed !== null);
  const reasons: string[] = [];
  const base = { id: input.id, observedAt: now, policyVersion: policy.version, views: input.views } as const;
  if (healthy.length === 0) {
    reasons.push('no RPC view answered');
    for (const v of input.views) if (v.error) reasons.push(`${v.label}: ${v.error}`.slice(0, 160));
    return { snapshot: { ...base, state: 'UNAVAILABLE', headSlot: null, slotAdvanced: null, confirmedFinalizedLagSlots: null, viewDivergenceSlots: null, effectOnEntries: 'BLOCK', reasons }, lastAdvanceAt: input.previous?.lastAdvanceAt ?? null };
  }
  const confirmedSlots = healthy.map((v) => v.slotConfirmed as number);
  const headSlot = Math.max(...confirmedSlots) as Slot;
  const divergence = healthy.length > 1 ? headSlot - Math.min(...confirmedSlots) : null;
  const finalized = healthy.map((v) => v.slotFinalized).filter((s): s is Slot => s !== null);
  const lag = finalized.length ? headSlot - Math.max(...finalized) : null;

  let slotAdvanced: boolean | null = null;
  let lastAdvanceAt: Instant = now;
  if (input.previous) {
    slotAdvanced = headSlot > input.previous.headSlot;
    lastAdvanceAt = slotAdvanced ? now : input.previous.lastAdvanceAt;
  }
  const stalledMs = instantToMs(now) - instantToMs(lastAdvanceAt);

  let state: ChainHealthSnapshot['state'] = 'HEALTHY';
  if (input.views.some((v) => !v.ok)) for (const v of input.views) if (!v.ok) reasons.push(`${v.label} unavailable${v.error ? `: ${v.error}` : ''}`.slice(0, 160));
  if (divergence !== null && divergence > policy.maxViewDivergenceSlots) {
    state = 'DIVERGENT';
    reasons.push(`views disagree by ${divergence} slots (> ${policy.maxViewDivergenceSlots})`);
  }
  if (slotAdvanced === false && stalledMs >= policy.maxSlotStallMs) {
    state = 'STALLED';
    reasons.push(`no confirmed slot advance for ${Math.round(stalledMs / 1000)}s (>= ${policy.maxSlotStallMs / 1000}s)`);
  }
  if (lag !== null && lag > policy.lagBlockSlots) {
    state = 'STALLED';
    reasons.push(`finality lag ${lag} slots (> ${policy.lagBlockSlots})`);
  } else if (lag !== null && lag > policy.lagWarnSlots && state === 'HEALTHY') {
    state = 'LAGGING';
    reasons.push(`finality lag ${lag} slots (> ${policy.lagWarnSlots})`);
  }
  const effectOnEntries = state === 'HEALTHY' || state === 'LAGGING' ? 'NONE' : 'BLOCK';
  return { snapshot: { ...base, state, headSlot, slotAdvanced, confirmedFinalizedLagSlots: lag, viewDivergenceSlots: divergence, effectOnEntries, reasons }, lastAdvanceAt };
}

/** Whether the chain-health policy lets a submission expect later reconciliation (§14.7: degraded-chain risk reduction is a separate, configured policy). */
export function chainAcceptsSubmissions(state: ChainHealthSnapshot['state']): boolean {
  return state === 'HEALTHY' || state === 'LAGGING';
}
