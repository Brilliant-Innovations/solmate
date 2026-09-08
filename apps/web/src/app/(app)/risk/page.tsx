import type { ReactNode } from 'react';
import { ago, baseToUsd, usd } from '../../../lib/paper';
import { loadRiskPolicy } from '../../../lib/risk';

export const dynamic = 'force-dynamic';

/**
 * Risk & Policy (§20.17): global portfolio limits, strategy sleeve caps, cohort and correlation
 * limits, trade limits, slippage/impact/chase limits, daily and rolling drawdown, executor absolute
 * caps, protection policy, emergency-exit policy, live arm state and version history. HARD rows
 * are enforced by the risk-authorizer and executor; SOFT rows shape paper fills and research.
 * Nothing here is editable: a change is a new policy version bound into a new Release (D38, §31).
 */
export default async function RiskPolicy() {
  const now = Date.now();
  const v = await loadRiskPolicy();
  const r = v.risk;
  const cell = { padding: '0.2rem 0.8rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const pct = (f: number) => `${(f * 100).toFixed(f * 100 < 1 ? 2 : 1)}%`;
  const mins = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms / 1000} s`);
  const Hard = () => <span className="chip" data-tone="failed" style={{ marginRight: '0.4rem' }}><span className="v">HARD</span></span>;
  const Soft = () => <span className="chip" data-tone="unknown" style={{ marginRight: '0.4rem' }}><span className="v">SOFT</span></span>;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(24rem, 1fr))', gap: '1rem', alignItems: 'start' };
  const armed = v.releases.releases.filter((x) => x.status === 'ARMED');
  const Row = ({ k, val, hard = true }: { k: string; val: ReactNode; hard?: boolean }) => (
    <tr><td style={cell} className="muted">{hard ? <Hard /> : <Soft />}{k}</td><td style={{ ...cell, whiteSpace: 'normal' }}>{val}</td></tr>
  );
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Risk &amp; Policy</h1>
      <p className="muted">Policy version <span className="mono">{r.version}</span> · safety <span className="mono">{v.safety.version}</span> · emergency route <span className="mono">{v.emergency.version}</span> · paper fill <span className="mono">{v.paperFill.version}</span> · cohorts <span className="mono">{v.cohorts.version}</span> · clusters <span className="mono">{v.clusters.version}</span>. HARD rows are enforced deterministically by the risk-authorizer and executor; SOFT rows shape paper fills and research. Changing a live policy creates a new version and requires re-arming (§31).</p>

      <div style={grid}>
        <section className="panel">
          <h2>Global portfolio limits</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <Row k="max total exposure" val={pct(r.maxTotalExposureFraction)} />
            <Row k="max open positions" val={r.maxOpenPositions} />
            <Row k="max in-flight exposure-increasing" val={r.maxInFlightExposureIncreasing} />
            <Row k="settlement reserve" val={`${usd(baseToUsd(r.minSettlementReserveBaseUnits))} · gas ${Number(r.minGasReserveLamports) / 1e9} SOL`} />
            <Row k="max clock drift" val={mins(r.maxClockDriftMs)} />
            <Row k="max execution anomalies" val={`${r.maxExecutionAnomalies} before pause`} />
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Strategy sleeve caps</h2>
          {v.sleeves.length === 0 ? (
            <p className="muted">No sleeve on any account.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['sleeve', 'cap', 'committed', 'risk budget', 'risk used', 'state'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {v.sleeves.map((s, i) => (
                  <tr key={i}>
                    <td style={cell}>{s.strategy_version_id} <span className="muted">{s.version_id}</span></td>
                    <td style={cell}>{usd(baseToUsd(s.capital_cap_base_units))}</td>
                    <td style={cell}>{usd(baseToUsd(s.committed_base_units))}</td>
                    <td style={cell}>{usd(baseToUsd(s.risk_budget_base_units))}</td>
                    <td style={cell}>{usd(baseToUsd(s.risk_used_base_units))}</td>
                    <td style={cell}><span className="chip" data-tone={s.active ? 'ok' : 'unknown'}><span className="v">{s.active ? 'ACTIVE' : 'INACTIVE'}</span></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}><Hard />One physical wallet, explicit strategy sleeves and lots (§31); sleeve capacity is signed into the RiskStateProjection, never read from a plain row.</p>
        </section>

        <section className="panel">
          <h2>Risk cohort / correlation limits</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <Row k="max per token" val={pct(r.maxExposurePerTokenFraction)} />
            <Row k="max per cohort" val={pct(r.maxCohortExposureFraction)} />
            <Row k="max per correlation cluster" val={pct(r.maxClusterExposureFraction)} />
            <Row k="cohort capacity required" val={r.requireCohortCapacity ? 'YES' : 'NO (an unclassified asset may enter under the per-token cap)'} />
            <Row k="cluster method" val={`${v.clusters.windowMs / 3_600_000} h window · ${v.clusters.sampleMinutes} min samples (min ${v.clusters.minSamples}) · link ≥ ${v.clusters.linkThreshold} · cluster ≥ ${v.clusters.minClusterSize}`} hard={false} />
          </tbody></table>
          <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Cohorts (deterministic, versioned; never LLM-controlled)</h3>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {(v.cohortRows.length ? v.cohortRows : v.cohorts.cohorts.map((c) => ({ name: c.name, version_id: v.cohorts.version, active: true, members: v.cohorts.memberships.filter((m) => m.cohort === c.name).length }))).map((c) => (
                <tr key={`${c.name}${c.version_id}`}><td style={cell}>{c.name}</td><td style={cell} className="muted">{c.version_id}</td><td style={cell}>{c.members} member(s)</td><td style={cell}>{c.active ? 'active' : 'inactive'}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>{v.clusterVersions.length ? `Latest cluster calculation ${ago(v.clusterVersions[0]!.calculated_at, now)} (${v.clusterVersions[0]!.version_id}).` : 'No correlation cluster calculated yet.'} LLM cohort suggestions can only ever be PENDING until an admin approves them.</p>
        </section>

        <section className="panel">
          <h2>Trade limits</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <Row k="risk per trade" val={pct(r.riskPerTradeFraction)} />
            <Row k="max position value" val={usd(baseToUsd(r.maxPositionValueBaseUnits))} />
            <Row k="liquidity cap" val={`${pct(r.liquidityCapFraction)} of pool liquidity`} />
            <Row k="min reward : risk" val={`${r.minRewardToRiskRatio} : 1`} />
            <Row k="sizing" val="deterministic from stop distance and risk budget; model confidence never changes size (§31)" />
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Slippage / impact / chase</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <Row k="max slippage" val={`${r.maxSlippageBps} bp`} />
            <Row k="max price impact" val={`${r.maxImpactBps} bp`} />
            <Row k="chase tolerance" val={`${r.chaseToleranceBps} bp (per strategy: ${v.strategies.map((s) => `${s.version_id} ${s.chase_tolerance_bps}`).join(', ') || 'none'})`} />
            <Row k="max quote age" val={mins(r.maxQuoteAgeMs)} />
            <Row k="paper adverse allowance by path" val={Object.entries(v.paperFill.adverseAllowanceBpsByPath).map(([k, b]) => `${k} ${b} bp`).join(' · ')} hard={false} />
            <Row k="paper latency model" val={`submit ${v.paperFill.submissionDelayMs} ms · confirm ${v.paperFill.confirmationDelayMs} ms · finalize ${v.paperFill.finalizationDelayMs} ms (${v.paperFill.finalizationSlots} slots)`} hard={false} />
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Drawdown and circuit breaker</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <Row k="daily drawdown" val={pct(r.maxDailyDrawdownFraction)} />
            <Row k="rolling drawdown" val={pct(r.maxRollingDrawdownFraction)} />
            <Row k="consecutive losses" val={r.maxConsecutiveLosses} />
            <Row k="cooldown after breaker" val={mins(r.cooldownAfterBreakerMs)} />
            <Row k="latest evaluation" val={v.latestEvaluation ? `${v.latestEvaluation.allowed ? 'ALLOW' : 'DENY'} ${ago(v.latestEvaluation.created_at, now)} · daily drawdown ${pct(v.latestEvaluation.daily_drawdown_fraction)} · breaker ${v.latestEvaluation.circuit_breaker_tripped ? 'TRIPPED' : 'armed'}${v.latestEvaluation.reason_codes.length ? ` · ${v.latestEvaluation.reason_codes.join(', ')}` : ''}` : 'none yet'} />
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Executor absolute caps</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <Row k="signer-side policy" val="Turnkey policy pins programs, recipients and mints; arbitrary bytes are never signed (ADR-0008); Profile 2+ only" />
            <Row k="semantic delta check" val="every transaction is simulated and its wallet/custody deltas must match the approved action before signing" />
            <Row k="capital ceiling" val={v.releases.capital[0] ? `$${v.releases.capital[0].ceiling_usd.toLocaleString()} attested ${ago(v.releases.capital[0].attested_at, now)}` : 'no capital attestation (nothing armed)'} />
            <Row k="numeric caps" val="held in the execution-service environment inside the isolated environment; not readable from this workspace by design (D65)" />
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Protection policy</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <Row k="stop model" val={`${r.stop.model} · ${r.stop.atrMultiple}× ATR · max ${pct(r.stop.maxStopFraction)}; deterministic and tighten-only while unreviewed (D39)`} />
            <Row k="take profit" val={`${r.takeProfit.policy} · target ${r.takeProfit.targetRMultiple}R · trail after ${r.takeProfit.trailAfterRMultiple}R by ${pct(r.takeProfit.trailFraction)} · max hold ${mins(r.takeProfit.maxHoldMs)}`} />
            <Row k="held-asset safety" val={`sell impact ≤ ${v.safety.maxSellImpactBps} bp · liquidity drop ${pct(v.safety.liquidityDropFraction)} / collapse ${pct(v.safety.liquidityCollapseFraction)} · concentration shock Δ${pct(v.safety.concentrationShockDelta)} · transfer-fee raise ${v.safety.transferFeeRaiseBps} bp · security age ≤ ${mins(v.safety.maxSecurityAgeMs)} · chain read ≤ ${mins(v.safety.maxChainReadAgeMs)}`} />
            <Row k="unresolved review" val="open position enters PROTECTION_ONLY with deterministic protection; mandatory risk reduction is never blocked by a model (§31)" />
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Emergency-exit policy</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <Row k="dry-run cadence" val={`every ${mins(v.emergency.dryRunIntervalMs)} · stale after ${mins(v.emergency.maxDryRunAgeMs)} · ${v.emergency.maxTargetsPerCycle} targets per cycle`} />
            <Row k="dry-run slippage" val={`${v.emergency.dryRunSlippageBps} bp · compute ${v.emergency.computeUnitLimit} CU @ ${v.emergency.computeUnitPriceMicroLamports} µlamports`} />
            <Row k="supported programs" val={v.emergency.supportedPrograms.join(', ')} />
            <Row k="LIVE_AUTO gate" val="entry per asset needs a fresh OK dry-run; the executor falls back to the direct pool only before any signature exists on the primary path" />
          </tbody></table>
        </section>

        <section className="panel">
          <h2>Live arm state</h2>
          {armed.length === 0 ? (
            <p className="muted">Nothing armed. {v.releases.releases.length} Release(s) recorded; live capability stays disabled by default (§31).</p>
          ) : (
            <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
              {armed.map((x) => <li key={x.id}>{x.binding.strategyVersionId ?? '?'} · risk {x.binding.riskPolicyVersion ?? '?'} · digest {x.digest.slice(0, 12)}… · promoted {x.promoted_at ? ago(x.promoted_at, now) : '—'}</li>)}
            </ul>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Latest signed risk-state projection: {v.latestProjection ? `#${v.latestProjection.sequence} ${ago(v.latestProjection.as_of, now)} at slot ${v.latestProjection.chain_slot} (key ${v.latestProjection.key_id})` : 'none'}. <a href="/releases">Releases</a> · <a href="/readiness">Live Readiness</a></p>
        </section>

        <section className="panel">
          <h2>Version history</h2>
          {v.strategies.length === 0 ? (
            <p className="muted">No strategy version registered.</p>
          ) : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['strategy version', 'status', 'risk policy', 'quote age', 'live expiry', 'authorities', 'active'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {v.strategies.map((s) => (
                  <tr key={s.version_id}>
                    <td style={cell}>{s.version_id}</td>
                    <td style={cell}>{s.status}</td>
                    <td style={cell}>{s.risk_policy_version}</td>
                    <td style={cell}>{mins(s.max_quote_age_ms)}</td>
                    <td style={cell}>{mins(s.live_intent_expiry_ms)}</td>
                    <td style={cell}>{s.eligible_capital_authorities.join(', ')}</td>
                    <td style={cell}>{ago(s.active_from, now)}{s.active_to ? ` → ${ago(s.active_to, now)}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Strategy versions are immutable; a policy change is a new version and a new Release. Diffs between Releases are on the Releases screen.</p>
        </section>
      </div>
    </>
  );
}
