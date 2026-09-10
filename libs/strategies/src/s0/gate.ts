import { instantToMs, type AdversarialReviewOutput, type Candidate, type FeatureSnapshot, type Instant, type S0GateReason, type S0SafetyGatePolicy } from '@sol-agent-trader/contracts';

/**
 * S0_SAFE deterministic second-look gate (blueprint D30 for T0_FAST, §12.1). Pure over the
 * candidate, its stored feature snapshot, the policy and the clock. Verdicts are CONFIRM or
 * REJECT only: a deterministic proposer has nothing to revise, so CHALLENGE is never emitted.
 * Missing required inputs fail closed.
 */

export interface S0GateInput {
  candidate: Pick<Candidate, 'id' | 'discoveredAt'>;
  snapshot: FeatureSnapshot;
  policy: S0SafetyGatePolicy;
  now: Instant;
  cutoffVersion: number;
}

export interface S0GateObjection {
  code: S0GateReason;
  detail: string;
}

export interface S0GateResult {
  verdict: 'CONFIRM' | 'REJECT';
  objections: S0GateObjection[];
  output: AdversarialReviewOutput;
}

export function evaluateS0SafetyGate(input: S0GateInput): S0GateResult {
  const { snapshot, policy } = input;
  const f = snapshot.features;
  const objections: S0GateObjection[] = [];
  const nowMs = instantToMs(input.now);

  const candidateAge = nowMs - instantToMs(input.candidate.discoveredAt);
  if (candidateAge > policy.maxCandidateAgeMs) objections.push({ code: 'CANDIDATE_STALE', detail: `candidate age ${candidateAge}ms > ${policy.maxCandidateAgeMs}ms` });
  const featureAge = nowMs - instantToMs(snapshot.asOf);
  if (featureAge > policy.maxFeatureAgeMs) objections.push({ code: 'FEATURES_STALE', detail: `feature age ${featureAge}ms > ${policy.maxFeatureAgeMs}ms` });

  /**
   * ADR-0011's candle bound, applied per asset where the decision is actually made (WP1b, 2026-09-09).
   *
   * `FEATURES_STALE` above measures when the snapshot was *computed*, and the engine recomputes every
   * 60 s whether or not its inputs moved — measured at roughly 200x the rate the candles beneath it
   * changed — so it stays fresh over arbitrarily old data. `ops.provider_health` cannot cover the gap
   * either: it is one row per (provider, dataClass) reading newest-across-the-set, which is easiest to
   * satisfy exactly when the tracked set is small and one asset is active, so narrowing the universe
   * makes it weaker rather than stronger.
   *
   * An absent input age is stale by definition: absence stays the unsafe direction, as everywhere else.
   */
  const inputAge = snapshot.newestInputAt === null ? null : nowMs - instantToMs(snapshot.newestInputAt);
  if (inputAge === null) objections.push({ code: 'INPUTS_STALE', detail: 'no closed input bucket behind these features' });
  else if (inputAge > policy.maxInputAgeMs) objections.push({ code: 'INPUTS_STALE', detail: `input age ${inputAge}ms > ${policy.maxInputAgeMs}ms` });
  const missing = policy.requiredFeatures.filter((name) => typeof f[name] !== 'number');
  if (missing.length) objections.push({ code: 'FEATURE_MISSING', detail: `missing ${missing.join(',')}` });
  if (snapshot.selfInfluenceSuppressed) objections.push({ code: 'SELF_INFLUENCE_SUPPRESSED', detail: 'own fill inside the suppression window' });

  const num = (name: string): number | null => (typeof f[name] === 'number' ? (f[name] as number) : null);
  const sellRoute = num('sell_route_confirmed');
  if (sellRoute !== null && sellRoute !== 1) objections.push({ code: 'SELL_ROUTE_UNCONFIRMED', detail: 'no confirmed sell route at snapshot time' });
  const impact = num('impact_bps_small');
  if (impact !== null && impact > policy.maxExitImpactBps) objections.push({ code: 'EXIT_IMPACT_HIGH', detail: `impact ${impact}bps > ${policy.maxExitImpactBps}bps` });
  const liq = num('liquidity_usd');
  if (liq !== null && liq < policy.minLiquidityUsd) objections.push({ code: 'LIQUIDITY_THIN', detail: `liquidity ${liq} < ${policy.minLiquidityUsd}` });
  const ret1h = num('ret_1h');
  if (ret1h !== null && ret1h > policy.maxReturn1h) objections.push({ code: 'OVEREXTENDED_1H', detail: `ret_1h ${ret1h} > ${policy.maxReturn1h}` });
  const rsi = num('rsi_14');
  if (rsi !== null && rsi > policy.maxRsi14) objections.push({ code: 'OVERBOUGHT', detail: `rsi_14 ${rsi} > ${policy.maxRsi14}` });
  const relVol = num('rel_volume_60');
  if (relVol !== null && relVol > policy.maxRelativeVolume60) objections.push({ code: 'VOLUME_ANOMALY', detail: `rel_volume_60 ${relVol} > ${policy.maxRelativeVolume60}` });
  if (snapshot.regime !== null && policy.blockedRegimes.includes(snapshot.regime)) objections.push({ code: 'REGIME_BLOCKED', detail: `regime ${snapshot.regime}` });
  const blockedSession = snapshot.marketSessions.find((s) => policy.blockedSessions.includes(s));
  if (blockedSession) objections.push({ code: 'SESSION_BLOCKED', detail: `session ${blockedSession}` });

  const verdict = objections.length ? 'REJECT' : 'CONFIRM';
  return {
    verdict,
    objections,
    output: {
      verdict,
      objections: objections.map((o) => ({ code: o.code, detail: o.detail, evidenceIds: [snapshot.id] })),
      counterEvidenceIds: objections.length ? [snapshot.id] : [],
      confidence: 1,
      evidenceCutoffVersion: input.cutoffVersion,
      reasoningSummary: objections.length ? `deterministic gate ${policy.version}: ${objections.map((o) => o.code).join(', ')}` : `deterministic gate ${policy.version}: no counter-signal`,
    },
  };
}
