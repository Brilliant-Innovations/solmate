-- Held-asset safety evaluations (blueprint §7.5, D34; execution plan M4).
-- Append-only history per position; trading.positions.safety_state is the mutable pointer and is
-- moved in the same transaction by trading.record_position_safety().

create table trading.position_safety_evaluations (
  id uuid primary key default gen_random_uuid(),
  position_id uuid not null references trading.positions (id),
  asset_id uuid not null references core.assets (id),
  evaluated_at timestamptz not null,
  policy_version core.version_id not null,
  state enums.position_safety_state not null,
  previous_state enums.position_safety_state,
  reasons core.reason_code[] not null default '{}',
  triggers text[] not null check (array_length(triggers, 1) >= 1),
  exit_compatibility jsonb not null,
  position_quantity core.amount not null,
  chain_slot bigint not null check (chain_slot >= 0),
  liquidity_usd double precision check (liquidity_usd >= 0),
  observed jsonb not null,
  baseline jsonb not null,
  created_at timestamptz not null default now()
);
create index position_safety_latest_idx on trading.position_safety_evaluations (position_id, evaluated_at desc);
create trigger position_safety_immutable before update or delete on trading.position_safety_evaluations
  for each row execute function core.forbid_update();

-- Backend-only: append the evaluation and move the position's safety pointer atomically.
create or replace function trading.record_position_safety(p_evaluation jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid := (p_evaluation ->> 'id')::uuid;
  v_position uuid := (p_evaluation ->> 'positionId')::uuid;
  v_state enums.position_safety_state := (p_evaluation ->> 'state')::enums.position_safety_state;
begin
  insert into trading.position_safety_evaluations (id, position_id, asset_id, evaluated_at, policy_version, state, previous_state, reasons, triggers,
    exit_compatibility, position_quantity, chain_slot, liquidity_usd, observed, baseline)
  values (
    v_id, v_position, (p_evaluation ->> 'assetId')::uuid, (p_evaluation ->> 'evaluatedAt')::timestamptz, (p_evaluation ->> 'policyVersion')::core.version_id,
    v_state, nullif(p_evaluation ->> 'previousState', '')::enums.position_safety_state,
    coalesce((select array_agg(x::core.reason_code) from jsonb_array_elements_text(p_evaluation -> 'reasons') x), '{}'::core.reason_code[]),
    (select array_agg(x::text) from jsonb_array_elements_text(p_evaluation -> 'triggers') x),
    p_evaluation -> 'exitCompatibility', (p_evaluation ->> 'positionQuantity')::core.amount, (p_evaluation ->> 'chainSlot')::bigint,
    (p_evaluation ->> 'liquidityUsd')::double precision, p_evaluation -> 'observed', p_evaluation -> 'baseline');
  update trading.positions set safety_state = v_state where id = v_position and status <> 'CLOSED';
  if not found then
    raise exception 'position % is closed or unknown', v_position using errcode = 'P0001';
  end if;
  return v_id;
end
$$;
revoke all on function trading.record_position_safety(jsonb) from public, anon, authenticated;
grant execute on function trading.record_position_safety(jsonb) to service_role;

alter table trading.position_safety_evaluations enable row level security;
alter table trading.position_safety_evaluations force row level security;
grant select on trading.position_safety_evaluations to authenticated;
create policy operators_read on trading.position_safety_evaluations for select to authenticated using (ops.has_role('viewer'));
