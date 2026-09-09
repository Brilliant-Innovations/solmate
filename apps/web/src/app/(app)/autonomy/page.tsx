import { ago } from '../../../lib/paper';
import { loadAutonomy, TOOL_SOURCES } from '../../../lib/autonomy';

export const dynamic = 'force-dynamic';

/**
 * Autonomy workspace: Trading Skill Console (§20.12: overview, tools, guidelines, workflows,
 * versions / test harness), Automations Console (§20.13) and Action Adversary Console (§20.14).
 * Everything shown is pinned contract data or a ledger fact under RLS. The live agent cannot edit
 * its skill, guidelines or automations, and neither can this page: a new version is code plus a
 * new Release (§31 "no self-modifying live strategies").
 */
export default async function Autonomy() {
  const now = Date.now();
  const v = await loadAutonomy(now);
  const cell = { padding: '0.2rem 0.8rem 0.2rem 0', whiteSpace: 'nowrap' as const, verticalAlign: 'top' as const };
  const mins = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms / 1000} s`);
  const current = v.skills[0] ?? null;
  const currentGuide = v.guidelines.find((g) => g.version_id === (current?.guideline_version ?? v.bindings.guidelineVersion)) ?? v.guidelines[0] ?? null;
  const priorGuide = currentGuide ? (v.guidelines.find((g) => g.version_id !== currentGuide.version_id) ?? null) : null;
  const added = currentGuide && priorGuide ? currentGuide.rules.filter((r) => !priorGuide.rules.includes(r)) : [];
  const removed = currentGuide && priorGuide ? priorGuide.rules.filter((r) => !currentGuide.rules.includes(r)) : [];
  const total = v.adversary.reviews || 1;
  const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(24rem, 1fr))', gap: '1rem', alignItems: 'start' };
  const transitions: [string, string, string][] = [
    ['TRIGGERED', 'CONTEXT_BUILT', 'context builder assembles the scoped, point-in-time evidence (cutoff v1)'],
    ['CONTEXT_BUILT', 'PROPOSED', 'proposer submits one typed TradingActionProposal via submitActionProposal'],
    ['PROPOSED', 'CLEARED', 'adversary CONFIRM (cleared at the proposal\'s cutoff version)'],
    ['PROPOSED', 'REJECTED', 'adversary REJECT'],
    ['PROPOSED', 'REVISION_REQUESTED', 'adversary CHALLENGE (one revision round allowed)'],
    ['REVISION_REQUESTED', 'PROPOSED', 'proposer revision; evidence refresh mints cutoff v2 shared by proposer and adversary (D40)'],
    ['PROPOSED (round 2)', 'UNRESOLVED (REVISION_EXHAUSTED)', 'a second CHALLENGE ends the cycle; open positions go PROTECTION_ONLY'],
    ['CONTEXT_BUILT / PROPOSED', 'CONTEXT_BUILT', 'EVIDENCE_REFRESHED invalidates a pending proposal and mints a new cutoff'],
    ['any non-terminal', 'UNRESOLVED', 'ADVERSARY_UNAVAILABLE · TIMEOUT · BUDGET · MALFORMED_OUTPUT'],
    ['any non-terminal', 'EXPIRED', 'decision budget or candidate age exhausted (D32); no late decision'],
  ];
  return (
    <>
      <h1 style={{ marginTop: 0 }}>Autonomy</h1>
      <p className="muted">Skill · Guidelines · Automations · Adversary. Versions are immutable and bound into Releases; the agent cannot change any of them, and a change here would be code review plus a new Release, not a click.</p>

      <section className="panel">
        <h2>Trading Skill · overview</h2>
        {v.skills.length === 0 ? (
          <p className="muted">No skill version registered yet; the worker registers <span className="mono">{v.bindings.toolManifestVersion}</span> / <span className="mono">{v.bindings.guidelineVersion}</span> on start.</p>
        ) : (
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <tr><td style={cell} className="muted">skill version / status</td><td style={cell}>{current!.version_id} <span className="chip" data-tone={current!.status === 'PAPER' ? 'paper' : current!.status === 'ELIGIBLE_LIVE' ? 'ok' : current!.status === 'RETIRED' ? 'off' : 'unknown'}><span className="v">{current!.status}</span></span> · commit {current!.git_sha.slice(0, 8)} · effective {ago(current!.effective_from, now)}</td></tr>
            <tr><td style={cell} className="muted">bound strategies</td><td style={{ ...cell, whiteSpace: 'normal' }}>{v.boundStrategies.filter((s) => s.skill_version_id === current!.version_id).map((s) => `${s.version_id} (${s.status})`).join(', ') || 'none (deterministic strategies carry no skill)'}</td></tr>
            <tr><td style={cell} className="muted">supported action types</td><td style={cell}>{current!.supported_action_types.join(', ')} <span className="muted">· ADD absent by design (spot-only v1, no averaging up without policy)</span></td></tr>
            <tr><td style={cell} className="muted">bindings</td><td style={{ ...cell, whiteSpace: 'normal' }}>tools {current!.tool_manifest_version} · guidelines {current!.guideline_version} · workflow {current!.workflow_graph_version} · context {current!.context_builder_version} · proposer model policy {current!.proposer_model_policy_version} · adversary required {current!.adversary_policy_required ? 'YES' : 'no'}</td></tr>
            <tr><td style={cell} className="muted">model policy</td><td style={{ ...cell, whiteSpace: 'normal' }}>{v.modelPolicy.version}: proposer T={v.modelPolicy.proposerTemperature}, adversary T={v.modelPolicy.adversaryTemperature}, distinct providers {v.modelPolicy.requireDistinctProviders ? 'required' : 'not required'}, max output {v.modelPolicy.maxOutputTokens} tokens, call timeout {mins(v.modelPolicy.callTimeoutMs)} · cycle policy {v.cyclePolicy.version}: refresh on revision {v.cyclePolicy.refreshEvidenceOnRevision ? 'yes' : 'no'}, min confidence {v.cyclePolicy.minConfidence}, min remaining budget {v.cyclePolicy.minRemainingBudgetMs} ms</td></tr>
            <tr><td style={cell} className="muted">live usage (24h)</td><td style={cell}>{v.usage.cycles24h} cycle(s) · {v.usage.runs24h} model run(s), {v.usage.failedRuns24h} failed · {v.usage.refusals24h} refused tool call(s) · ${v.usage.costUsd24h.toFixed(2)}{v.usage.runs24h === 0 ? <span className="muted"> · agents role disabled without provider keys</span> : null}</td></tr>
          </tbody></table>
        )}
      </section>

      <section className="panel">
        <h2>Tools · manifest {v.manifest.version}</h2>
        <p className="muted" style={{ marginTop: 0 }}>Per run: ≤ {v.manifest.maxInvocationsPerRun} invocations, ≤ {v.manifest.maxProposalsPerRun} proposal, ≤ {v.manifest.maxArgumentBytes} argument bytes, ≤ {v.manifest.maxEvidencePerCall} evidence items per call. Every id is resolved server-side against the cycle scope; anything else is refused and audited (INV-16).</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr>{['tool', 'class', 'request fields', 'response', 'data source', 'point in time', 'live permission', '7d calls / errors / avg latency', 'last'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
            <tbody>
              {v.manifest.tools.map((t) => {
                const st = v.toolStats.find((s) => s.name === t.name);
                const src = TOOL_SOURCES[t.name];
                return (
                  <tr key={t.name} style={{ borderTop: '1px solid var(--rule)' }}>
                    <td style={cell}>{t.name}@{t.version}</td>
                    <td style={cell}><span className="chip" data-tone={t.classification === 'READ_ONLY' ? 'ok' : 'degraded'}><span className="v">{t.classification}</span></span></td>
                    <td style={cell}>{(v.argumentFields[t.name] ?? []).join(', ') || '(none)'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', maxWidth: '18rem' }} className="muted">{t.description}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', maxWidth: '14rem' }}>{src?.source ?? '—'}</td>
                    <td style={{ ...cell, whiteSpace: 'normal', maxWidth: '14rem' }}>{src?.pointInTime ?? '—'}</td>
                    <td style={cell}>{t.classification === 'READ_ONLY' ? 'read in every mode' : 'proposal only; no amount, destination or execution field'}</td>
                    <td style={cell}>{st ? `${st.invocations} / ${st.errors} / ${st.avgLatencyMs === null ? '—' : `${st.avgLatencyMs} ms`}` : '—'}</td>
                    <td style={cell}>{st?.last ? ago(st.last, now) : 'never'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mono" style={{ margin: '0.5rem 0 0' }}>
          <span className="muted">Absent by design: </span>
          {v.forbidden.map((f) => <span key={f} className="chip" data-tone="failed" style={{ marginRight: '0.3rem' }}><span className="v">no {f}</span></span>)}
        </p>
      </section>

      <div style={grid}>
        <section className="panel">
          <h2>Guidelines · {currentGuide?.version_id ?? v.bindings.guidelineVersion}</h2>
          {!currentGuide ? (
            <p className="muted">Guideline text not registered in the ledger yet (the worker registers it on start).</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {currentGuide.rules.map((r, i) => <li key={i} style={{ marginBottom: '0.25rem', color: added.includes(r) ? 'var(--ok)' : undefined }}>{r}</li>)}
            </ol>
          )}
          <p className="muted" style={{ margin: '0.5rem 0 0' }}>
            {priorGuide ? `Diff vs ${priorGuide.version_id}: ${added.length} added, ${removed.length} removed${removed.length ? ` (${removed.map((r) => r.slice(0, 40)).join('; ')})` : ''}.` : 'No prior guideline version to diff against.'} Draft editor: not enabled in v1; a new guideline set is a code change with the §11.5 minimum pinned by the prompt fixture test, bound by a new skill version and Release.
          </p>
        </section>

        <section className="panel">
          <h2>Workflows · {current?.workflow_graph_version ?? v.bindings.workflowGraphVersion}</h2>
          <table className="mono" style={{ borderCollapse: 'collapse' }}>
            <thead><tr>{['from', 'to', 'when'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
            <tbody>
              {transitions.map(([from, to, why]) => <tr key={from + to}><td style={cell}>{from}</td><td style={cell}>{to}</td><td style={{ ...cell, whiteSpace: 'normal' }} className="muted">{why}</td></tr>)}
            </tbody>
          </table>
          <p className="muted" style={{ margin: '0.5rem 0 0' }}>Candidate assessment allows ENTER / IGNORE; position management allows HOLD / REDUCE / EXIT / ADJUST_PROTECTION, and every one of them, HOLD included, receives adversarial review. Mandatory risk reduction runs on the deterministic path with a non-blocking review record (D31).</p>
        </section>

        <section className="panel">
          <h2>Versions / test harness</h2>
          {v.skills.length === 0 ? <p className="muted">No version.</p> : (
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['version', 'status', 'commit', 'effective', 'cycles', 'promote / retire'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {v.skills.map((s) => (
                  <tr key={s.version_id}>
                    <td style={cell}>{s.version_id}</td>
                    <td style={cell}>{s.status}</td>
                    <td style={cell}>{s.git_sha.slice(0, 8)}</td>
                    <td style={cell}>{ago(s.effective_from, now)}{s.effective_to ? ` → ${ago(s.effective_to, now)}` : ''}</td>
                    <td style={cell}>{v.boundStrategies.filter((x) => x.skill_version_id === s.version_id).length} bound strateg{v.boundStrategies.filter((x) => x.skill_version_id === s.version_id).length === 1 ? 'y' : 'ies'}</td>
                    <td style={cell}><a href="/releases">via Release promotion</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Adversarial fixture suite (invariant map)</h3>
          <ul className="mono" style={{ margin: 0, paddingLeft: '1rem' }}>
            <li>INV-14 no discretionary autonomous live intent without a cleared adversarial cycle — action-cycle, runner and risk-authorizer specs</li>
            <li>INV-15 no mandatory risk reduction blocked by an adversary — mandatory-exit spec</li>
            <li>INV-16 no tool invocation reaches an unregistered tool — tool-manifest property spec</li>
            <li>INV-17 no LIVE_AUTO strategy with a mutable or unversioned skill, guideline or automation set — release verify spec</li>
          </ul>
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>Paper/replay validation results: paper cycles per bound strategy on <a href="/releases">Releases</a>; replay results arrive with M10.</p>
        </section>
      </div>

      <section className="panel">
        <h2>Automations · {v.automationSet.version}</h2>
        <p className="muted" style={{ marginTop: 0 }}>What wakes the agent: every enabled rule below, in priority order. Heartbeat by speed tier: {Object.entries(v.automationSet.heartbeatMsByTier).map(([t, ms]) => `${t} ${mins(ms)}`).join(' · ')} · price excursion {(v.automationSet.priceExcursionFraction * 100).toFixed(0)}% · PROTECTION_ONLY retry {mins(v.automationSet.protectionOnlyRetryBaseMs)} → {mins(v.automationSet.protectionOnlyRetryMaxMs)}, alert after {v.automationSet.protectionOnlyAlertAfter} failures.</p>
        {v.automations.length === 0 ? (
          <p className="muted">No automation installed in the ledger (the agents role installs the set for each LLM strategy when it starts). Default rules: {v.automationSet.rules.map((r) => `${r.name} (${r.triggerType}, p${r.priority}, ${mins(r.minIntervalMs)}/${mins(r.cooldownMs)})`).join(' · ')}.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mono" style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{['automation', 'trigger', 'filter', 'strategy + skill', 'modes', 'cadence / cooldown', 'priority', 'last fired', 'next eligible', 'last result', 'enabled'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }} className="muted">{h}</th>)}</tr></thead>
              <tbody>
                {v.automations.map((a) => (
                  <tr key={a.id} style={{ borderTop: '1px solid var(--rule)' }}>
                    <td style={cell}>{a.name.split(':')[0]} <span className="muted">{a.version_id}</span></td>
                    <td style={cell}>{a.trigger_family} / {a.trigger_type}</td>
                    <td style={cell} className="muted">{Object.keys(a.filter).length ? JSON.stringify(a.filter) : '—'}</td>
                    <td style={cell}>{a.strategy_version_id}<div className="muted">{a.skill_version_id}</div></td>
                    <td style={cell}>{a.enabled_modes.join(', ')}</td>
                    <td style={cell}>{mins(a.min_interval_ms)} / {mins(a.cooldown_ms)} · deadline {mins(a.context_deadline_ms)}</td>
                    <td style={cell}>{a.priority}</td>
                    <td style={cell}>{a.last_fired_at ? ago(a.last_fired_at, now) : 'never'}</td>
                    <td style={cell}>{a.next_eligible_at ? (Date.parse(a.next_eligible_at) < now ? 'now' : `in ${Math.round((Date.parse(a.next_eligible_at) - now) / 1000)}s`) : 'now'}</td>
                    <td style={cell}>{a.lastRun ? `${a.lastRun.disposition} ${ago(a.lastRun.created_at, now)}` : '—'}</td>
                    <td style={cell}><span className="chip" data-tone={a.enabled ? 'ok' : 'off'}><span className="v">{a.enabled ? 'ENABLED' : 'DISABLED'}</span></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ margin: '0.5rem 0 0' }}>
          When will it reassess an open position if nothing else happens? {v.nextReassessments.length === 0 ? 'No open position.' : v.nextReassessments.map((p) => `${p.symbol}: ${p.next_reassessment_at ? (Date.parse(p.next_reassessment_at) < now ? 'due now' : `in ${Math.round((Date.parse(p.next_reassessment_at) - now) / 1000)}s`) : 'no reassessment scheduled'}`).join(' · ')} The live agent cannot edit these automations.
        </p>
      </section>

      <section className="panel">
        <h2>Action adversary · last 7 days</h2>
        <div style={grid}>
          <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
            <tr><td style={cell} className="muted">policy / model</td><td style={{ ...cell, whiteSpace: 'normal' }}>adversary required on every discretionary action (D30) · {v.adversary.adversaryModels.length ? v.adversary.adversaryModels.map((m) => `${m.provider}/${m.model} (${m.runs} runs, ${m.failures} failed)`).join(', ') : 'no AI adversary run recorded; deterministic gate only'} · S0_SAFE gate is the deterministic adversary</td></tr>
            <tr><td style={cell} className="muted">reviews</td><td style={cell}>{v.adversary.reviews} ({v.adversary.aiReviews} AI, {v.adversary.deterministicReviews} deterministic)</td></tr>
            <tr><td style={cell} className="muted">agreement / challenge / reject</td><td style={cell}>{pct(v.adversary.verdicts['CONFIRM'] ?? 0)} / {pct(v.adversary.verdicts['CHALLENGE'] ?? 0)} / {pct(v.adversary.verdicts['REJECT'] ?? 0)}{v.adversary.reviews === 0 ? <span className="muted"> (no reviews)</span> : null}</td></tr>
            <tr><td style={cell} className="muted">mandatory coverage</td><td style={cell}>{v.adversary.positionCycles} position cycle(s); {v.adversary.positionCyclesWithoutReview === 0 ? <span className="chip" data-tone="ok"><span className="v">EVERY DECIDED CYCLE REVIEWED</span></span> : <span className="chip" data-tone="failed"><span className="v">{v.adversary.positionCyclesWithoutReview} DECIDED WITHOUT REVIEW</span></span>}</td></tr>
            <tr><td style={cell} className="muted">revision success</td><td style={cell}>{v.adversary.revisionCycles === 0 ? 'no revision yet' : `${v.adversary.revisionCleared} of ${v.adversary.revisionCycles} revised cycles cleared`}</td></tr>
            <tr><td style={cell} className="muted">latency added by review</td><td style={cell}>{v.adversary.avgAiLatencyMs === null ? 'no AI review' : `${v.adversary.avgAiLatencyMs} ms average (AI)`} · deterministic gate ≈ 0 ms</td></tr>
            <tr><td style={cell} className="muted">failures / timeouts</td><td style={cell}>{Object.keys(v.adversary.unresolved).length ? Object.entries(v.adversary.unresolved).map(([k, n]) => `${k} ${n}`).join(' · ') : 'none'}</td></tr>
          </tbody></table>
          <div>
            <h3 style={{ margin: '0 0 0.3rem' }}>Outcomes after CONFIRM vs challenged</h3>
            <table className="mono" style={{ borderCollapse: 'collapse' }}><tbody>
              <tr><td style={cell} className="muted">confirmed first pass</td><td style={cell}>{v.adversary.outcomes.confirmedLots} closed lot(s) · realized {v.adversary.outcomes.confirmedRealized === null ? '—' : `$${v.adversary.outcomes.confirmedRealized.toFixed(2)}`}</td></tr>
              <tr><td style={cell} className="muted">challenged / revised</td><td style={cell}>{v.adversary.outcomes.challengedLots} closed lot(s) · realized {v.adversary.outcomes.challengedRealized === null ? '—' : `$${v.adversary.outcomes.challengedRealized.toFixed(2)}`}</td></tr>
            </tbody></table>
            <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Common objection codes</h3>
            {v.adversary.objectionCodes.length === 0 ? <p className="muted" style={{ margin: 0 }}>No objection recorded.</p> : (
              <p className="mono" style={{ margin: 0 }}>{v.adversary.objectionCodes.map((o) => `${o.code} ×${o.count}`).join(' · ')}</p>
            )}
            <h3 style={{ margin: '0.6rem 0 0.3rem' }}>Bypass proof</h3>
            <p className="muted" style={{ margin: 0 }}>INV-14 (no discretionary live intent without a cleared adversarial cycle) and INV-15 (no mandatory risk reduction blocked by an adversary) are mapped and green in CI; the risk-authorizer independently refuses an intent whose cycle was not CLEARED. A live setting may switch which approved adversary version is used only through a new Release; it cannot disable D30.</p>
          </div>
        </div>
      </section>
    </>
  );
}
