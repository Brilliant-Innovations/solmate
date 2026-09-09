-- Operator presence from the browser (blueprint D2, §20.21; readiness row OPERATOR_PRESENCE_HEARTBEAT).
--
-- Until now the only way to hold presence on an attended session was `tools/session-presence.mjs`,
-- a process the operator had to remember to start and which asserts attendance for as long as it
-- runs whether or not anyone is watching. This function lets the app hold it instead, so presence
-- is tied to a real, authenticated, *visible* browser session.
--
-- Why a narrow security-definer function rather than a direct write: `ops.control_requests` is the
-- only table the browser may write (§24.8, M2). A 60-second heartbeat is not a control request —
-- flooding that table would bury real ones — so presence gets a function that can do exactly one
-- thing and nothing else. It takes no arguments, so a caller cannot choose which session to stamp
-- or what time to claim.
--
-- aal2 is required. Presence keeps a session ACTIVE, and losing it pauses new entries (D61), so it
-- is a keep-authority-alive signal rather than a risk-reducing one. Requiring a TOTP-verified
-- session is free per request (it reads the `aal` claim) and fails closed in the right direction: an
-- aal1 session simply does not hold presence, so entries stay paused. It is not a step-up ceremony —
-- asking for a passkey every minute would guarantee the control went unused.

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
  -- §5.7: every presence claim comes from a TOTP-verified session, like every other control.
  if not ops.has_aal2() then
    return jsonb_build_object('stamped', false, 'reason', 'STEP_UP_REQUIRED');
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
  'Stamps last_presence_heartbeat_at on the newest open attended session for a TOTP-verified operator. Takes no arguments: the caller cannot choose the session or the time. Holds no trading authority (D2, §20.21).';
