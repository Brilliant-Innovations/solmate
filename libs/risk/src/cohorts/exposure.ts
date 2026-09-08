import { amountToBigInt, type Amount, type CorrelationClusterSet, type Uuid } from '@sol-agent-trader/contracts';
import { clusterFor } from './clusters.js';

/**
 * Cohort and cluster exposure for the deterministic risk core (blueprint §13.1 "maximum exposure
 * to one active taxonomy cohort", §6.3; ADR-0007 unknown-is-most-restrictive). Exposure is cost
 * basis of open positions grouped by the asset's ACTIVE taxonomy cohorts and by its correlation
 * cluster, expressed as a fraction of equity. An asset in several cohorts is judged against the
 * most used one; an asset in none has unknown cohort capacity.
 */

export interface ActiveMembership {
  assetId: Uuid;
  cohortId: Uuid;
  cohortName: string;
}

export interface OpenExposure {
  assetId: Uuid;
  costBasis: Amount;
}

export interface GroupUsage {
  id: string;
  usedFraction: number;
}

function fraction(part: bigint, equity: bigint): number {
  if (equity <= 0n) return part > 0n ? 1 : 0;
  return Number((part * 1_000_000n) / equity) / 1_000_000;
}

/** Exposure fraction per cohort over the whole book. */
export function cohortUsage(positions: readonly OpenExposure[], memberships: readonly ActiveMembership[], equity: Amount): Map<string, GroupUsage> {
  // One membership per (asset, cohort): a duplicated row must not count exposure twice.
  const seen = new Set<string>();
  const byAsset = new Map<Uuid, ActiveMembership[]>();
  for (const m of memberships) {
    const key = m.assetId + "|" + m.cohortName;
    if (seen.has(key)) continue;
    seen.add(key);
    byAsset.set(m.assetId, [...(byAsset.get(m.assetId) ?? []), m]);
  }
  const totals = new Map<string, bigint>();
  for (const p of positions) {
    for (const m of byAsset.get(p.assetId) ?? []) totals.set(m.cohortName, (totals.get(m.cohortName) ?? 0n) + amountToBigInt(p.costBasis));
  }
  const eq = amountToBigInt(equity);
  const out = new Map<string, GroupUsage>();
  for (const [id, part] of totals) out.set(id, { id, usedFraction: fraction(part, eq) });
  for (const m of memberships) if (!out.has(m.cohortName)) out.set(m.cohortName, { id: m.cohortName, usedFraction: 0 });
  return out;
}

/** The cohort the risk core judges a candidate asset against: its most-used active cohort, or null when it has none. */
export function cohortForAsset(assetId: Uuid, positions: readonly OpenExposure[], memberships: readonly ActiveMembership[], equity: Amount): GroupUsage | null {
  const mine = memberships.filter((m) => m.assetId === assetId);
  if (mine.length === 0) return null;
  const usage = cohortUsage(positions, memberships, equity);
  let best: GroupUsage | null = null;
  for (const m of mine) {
    const u = usage.get(m.cohortName) ?? { id: m.cohortName, usedFraction: 0 };
    if (!best || u.usedFraction > best.usedFraction || (u.usedFraction === best.usedFraction && u.id < best.id)) best = u;
  }
  return best;
}

/** Exposure fraction of the candidate asset's correlation cluster, or null when it is not clustered. */
export function clusterForAsset(assetId: Uuid, positions: readonly OpenExposure[], set: CorrelationClusterSet | null, equity: Amount): GroupUsage | null {
  const id = clusterFor(set, assetId);
  if (id === null || !set) return null;
  const members = new Set(set.clusters.find((c) => c.clusterId === id)?.assetIds ?? []);
  let part = 0n;
  for (const p of positions) if (members.has(p.assetId)) part += amountToBigInt(p.costBasis);
  return { id, usedFraction: fraction(part, amountToBigInt(equity)) };
}
