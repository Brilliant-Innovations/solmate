-- Operator presence no longer requires a TOTP-verified session (revises 20260909004200).
--
-- The aal2 gate in the original function was never a blueprint requirement. Line 690 asks Profile 2
-- for an "operator-presence heartbeat" and line 696 fixes its semantics — loss pauses new entries
-- after the grace interval and "never disables exits/protection" — but nothing there asks presence
-- to be step-up attested. That was added here, and the reasoning given for it does not hold up:
--
--   The comment on the original function argued that because presence keeps a session ACTIVE, it is
--   a keep-authority-alive signal and so should come from a TOTP-verified session. But `aal` is a
--   property of the Supabase session, not of the request: a stolen session token belonging to a
--   session that already completed TOTP carries `aal2` too. The check therefore does nothing against
--   session theft, which is the threat it reads as defending against. What it actually blocked was an
--   operator who has TOTP enrolled but signed in with a password only — a much weaker case, and the
--   one that locked the operator out of holding presence on their own deployment.
--
-- Step-up stays where it earns its cost: arming live, and every risk-increasing control (§5.7, D41).
-- Those still call ops.has_aal2() and are unchanged. Presence cannot arm anything, cannot increase
-- exposure and cannot clear a pause; the most it does is keep an already-armed attended session from
-- degrading to WATCH. Requiring a second factor to sustain that bought redundancy against a threat
-- it does not actually stop, at the price of making the control unusable.
--
-- What still gates presence, and does the real work: the caller must be an operator, the session must
-- be open and declared attended, and the browser widget only stamps while the tab is visible and the
-- operator has interacted inside the idle window. Presence has to mean "a person is watching", not
-- "a tab is open" — that part is load-bearing and is untouched here.

create or replace function ops.record_operator_presence()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session ops.runtime_sessions;
  v_now timestamptz := now();
begin
  if not ops.has_role('operator') then
    return jsonb_build_object('stamped', false, 'reason', 'NOT_AN_OPERATOR');
  end if;

  select * into v_session
  from ops.runtime_sessions
  where activity_state <> 'OFF'
  order by actual_start_at desc nulls last, created_at desc
  limit 1;

  if v_session.id is null then
    return jsonb_build_object('stamped', false, 'reason', 'NO_OPEN_SESSION');
  end if;
  -- An unattended session is unattended by declaration; presence does not promote it.
  if not v_session.attended then
    return jsonb_build_object('stamped', false, 'reason', 'SESSION_NOT_ATTENDED', 'sessionId', v_session.id);
  end if;

  update ops.runtime_sessions
  set last_presence_heartbeat_at = v_now
  where id = v_session.id;

  return jsonb_build_object('stamped', true, 'sessionId', v_session.id, 'at', v_now, 'operator', auth.uid());
end $$;

revoke all on function ops.record_operator_presence() from public;
revoke all on function ops.record_operator_presence() from anon;
grant execute on function ops.record_operator_presence() to authenticated;

comment on function ops.record_operator_presence() is
  'Stamps last_presence_heartbeat_at on the newest open attended session for a signed-in operator. Takes no arguments: the caller cannot choose the session or the time. Holds no trading authority and needs no step-up, because it cannot arm, increase exposure or clear a pause (D2, §20.21).';
