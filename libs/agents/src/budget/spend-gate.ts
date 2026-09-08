import { compareInstants, type Instant, type SpendBudget, type SpendUsage } from '@sol-agent-trader/contracts';

/**
 * Spend circuit breakers (blueprint D43, §11.7 "Automation/spend budgets"; INV-21). Evaluated
 * before a discretionary cycle starts: cycles per strategy-hour, model USD per strategy-day and
 * per platform-day, provider requests per minute. A breach blocks new discretionary cycles and, for
 * an open position, ends its cycle UNRESOLVED(BUDGET) so the position enters PROTECTION_ONLY.
 * Mandatory deterministic exits never consult this gate (libs/risk/mandatory-exit has no dependency
 * on it, and its property tests prove budget state cannot change an exit decision).
 */

export type SpendGateBlock =
  | { code: 'BUDGET_PAUSED'; budgetId: string; scope: SpendBudget['scope'] }
  | { code: 'CYCLES_PER_HOUR'; budgetId: string; scope: SpendBudget['scope']; used: number; limit: number }
  | { code: 'MODEL_USD_PER_DAY'; budgetId: string; scope: SpendBudget['scope']; used: number; limit: number }
  | { code: 'PROVIDER_REQUESTS_PER_MINUTE'; budgetId: string; scope: SpendBudget['scope']; used: number; limit: number };

export type SpendGateResult = { ok: true; checked: number } | { ok: false; block: SpendGateBlock; checked: number };

export interface SpendGateInput {
  budgets: readonly SpendBudget[];
  usage: readonly SpendUsage[];
  strategyId: string;
  /** Providers the cycle will call (model providers); PROVIDER budgets for others are ignored. */
  providers: readonly string[];
  now: Instant;
}

function applies(b: SpendBudget, input: SpendGateInput): boolean {
  if (!b.active) return false;
  switch (b.scope) {
    case 'PLATFORM':
      return true;
    case 'STRATEGY':
      return b.scopeId === input.strategyId;
    case 'PROVIDER':
      return b.scopeId !== null && input.providers.includes(b.scopeId);
  }
}

function currentUsage(b: SpendBudget, input: SpendGateInput): SpendUsage | null {
  const rows = input.usage.filter((u) => u.budgetId === b.id && compareInstants(u.windowStart, input.now) <= 0 && compareInstants(input.now, u.windowEnd) < 0);
  // Deterministic: the most recently updated window wins if several overlap.
  rows.sort((x, y) => compareInstants(y.updatedAt, x.updatedAt));
  return rows[0] ?? null;
}

/** Budgets are checked in a fixed order (platform, strategy, provider) so the first block is stable. */
export function evaluateSpendGate(input: SpendGateInput): SpendGateResult {
  const order: SpendBudget['scope'][] = ['PLATFORM', 'STRATEGY', 'PROVIDER'];
  const budgets = [...input.budgets].filter((b) => applies(b, input)).sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope) || (a.id < b.id ? -1 : 1));
  let checked = 0;
  for (const b of budgets) {
    checked += 1;
    const u = currentUsage(b, input);
    if (!u) continue;
    if (u.state === 'BUDGET_PAUSED') return { ok: false, block: { code: 'BUDGET_PAUSED', budgetId: b.id, scope: b.scope }, checked };
    if (b.limits.cyclesPerHour !== null && u.cycles >= b.limits.cyclesPerHour) return { ok: false, block: { code: 'CYCLES_PER_HOUR', budgetId: b.id, scope: b.scope, used: u.cycles, limit: b.limits.cyclesPerHour }, checked };
    if (b.limits.modelUsdPerDay !== null && u.modelUsd >= b.limits.modelUsdPerDay) return { ok: false, block: { code: 'MODEL_USD_PER_DAY', budgetId: b.id, scope: b.scope, used: u.modelUsd, limit: b.limits.modelUsdPerDay }, checked };
    if (b.limits.providerRequestsPerMinute !== null && u.providerRequests >= b.limits.providerRequestsPerMinute) return { ok: false, block: { code: 'PROVIDER_REQUESTS_PER_MINUTE', budgetId: b.id, scope: b.scope, used: u.providerRequests, limit: b.limits.providerRequestsPerMinute }, checked };
  }
  return { ok: true, checked };
}
