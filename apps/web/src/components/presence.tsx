'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createSupabaseBrowserClient } from '../lib/supabase/browser';

/**
 * Operator presence (blueprint D2, §20.21; readiness row OPERATOR_PRESENCE_HEARTBEAT).
 *
 * Presence must mean "a person is watching this session", not "a tab is open somewhere". A widget
 * that stamped a heartbeat for as long as the page existed would assert attendance for a laptop
 * shut in a bag, which is worse than no widget at all: losing presence is supposed to pause new
 * entries, so a false claim keeps a session ACTIVE with nobody there.
 *
 * So three things must all hold before it stamps, and the panel says which one is missing:
 *   - the tab is visible (`document.visibilityState`);
 *   - there has been real interaction — pointer, key, scroll, focus — inside `IDLE_AFTER_MS`;
 *   - the session is a TOTP-verified operator session, which the database enforces anyway.
 *
 * Stop interacting and it lapses on its own. That is the intended behaviour, not a bug: the session
 * role drops ACTIVE → WATCH after the presence timeout and new entries pause.
 */

const STAMP_EVERY_MS = 45_000;
/** No interaction for this long and the operator is not watching, whatever the tab says. */
const IDLE_AFTER_MS = 5 * 60_000;

type Outcome = { stamped: true; at: string } | { stamped: false; reason: string } | { stamped: false; reason: 'ERROR'; detail: string } | null;

const REASON_TEXT: Record<string, string> = {
  NOT_AN_OPERATOR: 'this account is not an operator',
  STEP_UP_REQUIRED: 'needs a TOTP-verified (aal2) session',
  NO_OPEN_SESSION: 'no open runtime session to attend',
  SESSION_NOT_ATTENDED: 'this session is declared unattended',
  IDLE: 'no interaction for five minutes',
  HIDDEN: 'this tab is not visible',
  ERROR: 'the presence call failed',
};

export function PresenceHeartbeat() {
  const [outcome, setOutcome] = useState<Outcome>(null);
  const lastInteraction = useRef<number>(Date.now());
  const [holding, setHolding] = useState(false);

  const stamp = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      setHolding(false);
      setOutcome({ stamped: false, reason: 'HIDDEN' });
      return;
    }
    if (Date.now() - lastInteraction.current > IDLE_AFTER_MS) {
      setHolding(false);
      setOutcome({ stamped: false, reason: 'IDLE' });
      return;
    }
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.schema('ops').rpc('record_operator_presence' as never);
    if (error) {
      setHolding(false);
      setOutcome({ stamped: false, reason: 'ERROR', detail: error.message });
      return;
    }
    const r = (data ?? {}) as { stamped?: boolean; at?: string; reason?: string };
    if (r.stamped) {
      setHolding(true);
      setOutcome({ stamped: true, at: r.at ?? new Date().toISOString() });
    } else {
      setHolding(false);
      setOutcome({ stamped: false, reason: r.reason ?? 'ERROR' });
    }
  }, []);

  useEffect(() => {
    const note = () => {
      lastInteraction.current = Date.now();
    };
    const events: (keyof DocumentEventMap)[] = ['pointerdown', 'keydown', 'scroll', 'focus', 'visibilitychange'];
    for (const e of events) document.addEventListener(e, note, { passive: true });
    void stamp();
    const timer = setInterval(() => void stamp(), STAMP_EVERY_MS);
    return () => {
      clearInterval(timer);
      for (const e of events) document.removeEventListener(e, note);
    };
  }, [stamp]);

  const tone = holding ? 'ok' : outcome === null ? 'unknown' : 'failed';
  const label = holding ? 'HOLDING PRESENCE' : outcome === null ? 'PRESENCE …' : 'NOT HOLDING';
  const why = outcome && !outcome.stamped ? (REASON_TEXT[outcome.reason] ?? outcome.reason) : null;
  return (
    <span className="chip" data-tone={tone} title={holding ? `last stamped ${outcome && outcome.stamped ? outcome.at : ''}; lapses after five minutes without interaction` : (why ?? undefined)}>
      {label}
      {why ? <span className="muted"> · {why}</span> : null}
    </span>
  );
}
