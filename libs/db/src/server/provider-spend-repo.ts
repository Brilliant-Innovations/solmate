import type { Sql } from './sql.js';

/** Persisted metered-provider spend per calendar month (§21.1, D43); the worker's ledger resumes from it. */
export interface ProviderSpend {
  provider: string;
  month: string;
  usedCu: number;
  byEndpoint: Record<string, number>;
}

export async function loadProviderSpend(sql: Sql, provider: string, month: string): Promise<ProviderSpend | null> {
  const [r] = await sql<{ used_cu: string | number | bigint; by_endpoint: Record<string, number> }[]>`
    select used_cu, by_endpoint from ops.provider_spend where provider = ${provider} and month = ${month}`;
  return r ? { provider, month, usedCu: Number(r.used_cu), byEndpoint: r.by_endpoint } : null;
}

/** Atomic increment; returns the month's running total after the charge. */
export async function chargeProviderSpend(sql: Sql, provider: string, month: string, endpoint: string, cu: number): Promise<number> {
  const [r] = await sql<{ used: string | number | bigint }[]>`select ops.charge_provider_spend(${provider}, ${month}, ${endpoint}, ${Math.round(cu)}) as used`;
  return Number(r?.used ?? 0);
}
