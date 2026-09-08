import type { MarketRegime, MarketRegimePolicy, Uuid } from '@sol-agent-trader/contracts';

/**
 * Cross-asset features (blueprint §8.4, §8.5, D62): the deterministic regime label and relative
 * strength against the universe and the asset's cohort. Pure over the minute's warm feature
 * vectors; no provider, no LLM, no state. Absence stays null: an asset without a 1h return has
 * no relative strength, a minute with too few warm assets has no regime.
 */

export interface UniverseAsset {
  assetId: Uuid;
  ret1h: number | null;
  relVolume60: number | null;
  /** ACTIVE taxonomy cohorts (§6.3); empty when unknown. */
  cohorts: readonly string[];
}

export interface RegimeFacts {
  assets: number;
  breadth: number | null;
  medianReturn1h: number | null;
  medianAbsReturn1h: number | null;
  medianRelVolume60: number | null;
  solReturn1h: number | null;
  leadingCohort: { name: string; medianReturn1h: number; members: number } | null;
}

export interface RegimeResult {
  regime: MarketRegime | null;
  facts: RegimeFacts;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function classifyRegime(input: { sol: { ret1h: number | null } | null; assets: readonly UniverseAsset[]; policy: MarketRegimePolicy }): RegimeResult {
  const { policy } = input;
  const warm = input.assets.filter((a): a is UniverseAsset & { ret1h: number } => typeof a.ret1h === 'number' && Number.isFinite(a.ret1h));
  const returns = warm.map((a) => a.ret1h);
  const medianReturn1h = median(returns);
  const medianAbsReturn1h = median(returns.map((r) => Math.abs(r)));
  const medianRelVolume60 = median(warm.map((a) => a.relVolume60).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  const breadth = warm.length ? warm.filter((a) => a.ret1h > 0).length / warm.length : null;
  const solReturn1h = input.sol && typeof input.sol.ret1h === 'number' && Number.isFinite(input.sol.ret1h) ? input.sol.ret1h : null;
  // Leading cohort by median 1h return among cohorts with enough warm members; ties break on name.
  const byCohort = new Map<string, number[]>();
  for (const a of warm) for (const c of a.cohorts) byCohort.set(c, [...(byCohort.get(c) ?? []), a.ret1h]);
  let leadingCohort: RegimeFacts['leadingCohort'] = null;
  for (const [name, rs] of [...byCohort.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (rs.length < policy.rotationMinCohortMembers) continue;
    const m = median(rs)!;
    if (!leadingCohort || m > leadingCohort.medianReturn1h) leadingCohort = { name, medianReturn1h: m, members: rs.length };
  }
  const facts: RegimeFacts = { assets: warm.length, breadth, medianReturn1h, medianAbsReturn1h, medianRelVolume60, solReturn1h, leadingCohort };
  if (warm.length < policy.minAssets || medianReturn1h === null || medianAbsReturn1h === null || breadth === null) return { regime: null, facts };

  let regime: MarketRegime | null = null;
  if (medianAbsReturn1h >= policy.shockMedianAbsReturn1h || (solReturn1h !== null && Math.abs(solReturn1h) >= policy.shockSolAbsReturn1h)) regime = 'VOLATILITY_SHOCK';
  else if (breadth <= policy.selloffBreadth && medianReturn1h <= policy.selloffMedianReturn1h) regime = 'BROAD_SELLOFF';
  else if (solReturn1h !== null && solReturn1h >= policy.solLedReturn1h && solReturn1h - medianReturn1h >= policy.solLeadMargin) regime = 'SOL_LED_RALLY';
  else if (leadingCohort && leadingCohort.medianReturn1h - medianReturn1h >= policy.rotationCohortLead && breadth >= policy.rotationBreadthMin && breadth <= policy.rotationBreadthMax) regime = 'NARRATIVE_ROTATION';
  else if (breadth >= policy.riskOnBreadth && medianReturn1h >= policy.riskOnMedianReturn1h) regime = 'RISK_ON_TREND';
  else if (medianRelVolume60 !== null && medianRelVolume60 <= policy.chopMedianRelVolume && medianAbsReturn1h <= policy.chopMedianAbsReturn1h) regime = 'LOW_LIQUIDITY_CHOP';
  return { regime, facts };
}

/** Relative strength (§8.4): the asset's 1h return minus the universe median and minus its cohort's median (cohort of at least two warm members). */
export function relativeStrength(assets: readonly UniverseAsset[]): Map<Uuid, { rsUniverse1h: number | null; rsCohort1h: number | null }> {
  const warm = assets.filter((a): a is UniverseAsset & { ret1h: number } => typeof a.ret1h === 'number' && Number.isFinite(a.ret1h));
  const universe = median(warm.map((a) => a.ret1h));
  const byCohort = new Map<string, number[]>();
  for (const a of warm) for (const c of a.cohorts) byCohort.set(c, [...(byCohort.get(c) ?? []), a.ret1h]);
  const out = new Map<Uuid, { rsUniverse1h: number | null; rsCohort1h: number | null }>();
  for (const a of assets) {
    if (typeof a.ret1h !== 'number' || !Number.isFinite(a.ret1h)) {
      out.set(a.assetId, { rsUniverse1h: null, rsCohort1h: null });
      continue;
    }
    let cohortMedian: number | null = null;
    for (const c of a.cohorts) {
      const rs = byCohort.get(c) ?? [];
      if (rs.length < 2) continue;
      const m = median(rs)!;
      if (cohortMedian === null || m > cohortMedian) cohortMedian = m; // judged against its strongest cohort
    }
    out.set(a.assetId, { rsUniverse1h: universe === null ? null : a.ret1h - universe, rsCohort1h: cohortMedian === null ? null : a.ret1h - cohortMedian });
  }
  return out;
}
