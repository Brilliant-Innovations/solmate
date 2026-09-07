-- Chain/custody reconciliation and the owned-address registry (blueprint D9, D26, §6.17, §13.6;
-- execution plan M4). Reports and observed movements are append-only history; the per-account
-- cursor is the only mutable row. A MISMATCH report pauses every running runtime session for the
-- account (or unscoped sessions) in the same transaction, with a CRITICAL notification and an
-- audit row, so an unknown movement can never be recorded without the pause it mandates.

-- Owned-address registry gains the fields the contract carries (D26).
alter table intelligence.owned_addresses
  add column cluster enums.solana_cluster not null default 'mainnet-beta',
  add column account_id uuid references trading.accounts (id),
  add constraint owned_addresses_purpose_check
    check (purpose in ('TRADING_WALLET', 'ASSOCIATED_TOKEN_ACCOUNT', 'JUPITER_TRIGGER_VAULT', 'COLD_RECOVERY', 'FUNDING_SOURCE', 'OTHER'));
create index owned_addresses_account_idx on intelligence.owned_addresses (account_id);

create table trading.custody_reconciliations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (id),
  evaluated_at timestamptz not null,
  policy_version core.version_id not null,
  chain_slot bigint check (chain_slot >= 0),
  status text not null check (status in ('CLEAN', 'MISMATCH', 'UNAVAILABLE')),
  reasons core.reason_code[] not null default '{}',
  balances jsonb not null,
  unexpected_token_accounts jsonb not null default '[]'::jsonb,
  unparsed_signatures text[] not null default '{}',
  movement_source text not null check (movement_source in ('HELIUS', 'NONE')),
  cursor jsonb not null,
  pause_triggered boolean not null,
  created_at timestamptz not null default now(),
  constraint mismatch_iff_pause check (pause_triggered = (status = 'MISMATCH'))
);
create index custody_reconciliations_latest_idx on trading.custody_reconciliations (account_id, evaluated_at desc);
create trigger custody_reconciliations_immutable before update or delete on trading.custody_reconciliations
  for each row execute function core.forbid_update();

create table trading.custody_movements (
  account_id uuid not null references trading.accounts (id),
  signature core.tx_signature not null,
  movement_index integer not null check (movement_index >= 0),
  reconciliation_id uuid not null references trading.custody_reconciliations (id),
  slot bigint not null check (slot >= 0),
  block_time timestamptz,
  kind text not null check (kind in ('SOL', 'TOKEN')),
  mint core.solana_address,
  from_owner core.solana_address,
  to_owner core.solana_address,
  from_token_account core.solana_address,
  to_token_account core.solana_address,
  amount core.amount not null,
  decimals smallint not null check (decimals between 0 and 18),
  summary_type text,
  failed boolean not null default false,
  classification text not null check (classification in ('EXPECTED', 'UNKNOWN')),
  reason text,
  lifecycle_id uuid,
  created_at timestamptz not null default now(),
  primary key (account_id, signature, movement_index),
  constraint token_has_mint check ((kind = 'TOKEN') = (mint is not null))
);
create index custody_movements_unknown_idx on trading.custody_movements (account_id, created_at desc) where classification = 'UNKNOWN';
create trigger custody_movements_immutable before update or delete on trading.custody_movements
  for each row execute function core.forbid_update();

create table trading.reconciliation_cursors (
  account_id uuid primary key references trading.accounts (id),
  last_signature core.tx_signature,
  last_slot bigint check (last_slot >= 0),
  sol_lamports core.amount,
  last_reconciliation_id uuid references trading.custody_reconciliations (id),
  updated_at timestamptz not null default now()
);
create trigger reconciliation_cursors_touch before update on trading.reconciliation_cursors
  for each row execute function core.touch_updated_at();

-- Backend-only: append the report and its movements, advance the cursor, and pause on mismatch.
create or replace function trading.record_reconciliation(p_report jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid := (p_report ->> 'id')::uuid;
  v_account uuid := (p_report ->> 'accountId')::uuid;
  v_status text := p_report ->> 'status';
  v_pause boolean := (p_report ->> 'pauseTriggered')::boolean;
  v_at timestamptz := (p_report ->> 'evaluatedAt')::timestamptz;
  v_reasons core.reason_code[] := coalesce((select array_agg(x::core.reason_code) from jsonb_array_elements_text(p_report -> 'reasons') x), '{}'::core.reason_code[]);
  v_since text := to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  m jsonb;
  v_session uuid;
begin
  insert into trading.custody_reconciliations (id, account_id, evaluated_at, policy_version, chain_slot, status, reasons, balances, unexpected_token_accounts,
    unparsed_signatures, movement_source, cursor, pause_triggered)
  values (v_id, v_account, v_at, (p_report ->> 'policyVersion')::core.version_id, (p_report ->> 'chainSlot')::bigint, v_status, v_reasons,
    p_report -> 'balances', coalesce(p_report -> 'unexpectedTokenAccounts', '[]'::jsonb),
    coalesce((select array_agg(x::text) from jsonb_array_elements_text(p_report -> 'unparsedSignatures') x), '{}'::text[]),
    p_report ->> 'movementSource', p_report -> 'cursor', v_pause);

  for m in select * from jsonb_array_elements(coalesce(p_report -> 'movements', '[]'::jsonb)) loop
    insert into trading.custody_movements (account_id, signature, movement_index, reconciliation_id, slot, block_time, kind, mint, from_owner, to_owner,
      from_token_account, to_token_account, amount, decimals, summary_type, failed, classification, reason, lifecycle_id)
    values (v_account, (m ->> 'signature')::core.tx_signature, (m ->> 'index')::integer, v_id, (m ->> 'slot')::bigint, (m ->> 'blockTime')::timestamptz,
      m ->> 'kind', (m ->> 'mint')::core.solana_address, (m ->> 'fromOwner')::core.solana_address, (m ->> 'toOwner')::core.solana_address,
      (m ->> 'fromTokenAccount')::core.solana_address, (m ->> 'toTokenAccount')::core.solana_address, (m ->> 'amount')::core.amount,
      (m ->> 'decimals')::smallint, m ->> 'summaryType', coalesce((m ->> 'failed')::boolean, false), m ->> 'classification', m ->> 'reason',
      (m ->> 'lifecycleId')::uuid)
    on conflict (account_id, signature, movement_index) do nothing;
  end loop;

  if v_status <> 'UNAVAILABLE' then
    insert into trading.reconciliation_cursors (account_id, last_signature, last_slot, sol_lamports, last_reconciliation_id)
    values (v_account, (p_report -> 'cursor' ->> 'lastSignature')::core.tx_signature, (p_report -> 'cursor' ->> 'lastSlot')::bigint,
      (p_report -> 'cursor' ->> 'solLamports')::core.amount, v_id)
    on conflict (account_id) do update
      set last_signature = excluded.last_signature, last_slot = excluded.last_slot, sol_lamports = excluded.sol_lamports,
          last_reconciliation_id = excluded.last_reconciliation_id;
  end if;

  if v_pause then
    insert into ops.notifications (severity, alert_class, summary, affected, automated_response)
    values ('CRITICAL', 'CUSTODY_RECONCILIATION_MISMATCH',
      format('Custody reconciliation mismatch for account %s: %s', v_account, array_to_string(v_reasons, ', ')),
      jsonb_build_object('assetId', null, 'strategyVersionId', null, 'positionId', null, 'system', 'reconciliation:' || v_account::text, 'reconciliationId', v_id),
      'PAUSE_NEW_ENTRIES');
    for v_session in
      select id from ops.runtime_sessions
      where (account_id = v_account or account_id is null) and activity_state <> 'OFF' and not coalesce((paused ->> 'active')::boolean, false)
    loop
      update ops.runtime_sessions
        set paused = jsonb_build_object('active', true, 'reason', 'CUSTODY_RECONCILIATION_MISMATCH', 'since', v_since, 'by', 'WORKER')
        where id = v_session;
      insert into audit.events (actor, actor_ref, action_class, entity, before_summary, after_summary, live_impacting)
      values ('WORKER', 'reconciliation', 'RUNTIME_PAUSE', jsonb_build_object('type', 'runtime_session', 'id', v_session),
        jsonb_build_object('paused', false), jsonb_build_object('paused', true, 'reason', 'CUSTODY_RECONCILIATION_MISMATCH', 'reconciliationId', v_id), true);
    end loop;
  end if;
  return v_id;
end
$$;
revoke all on function trading.record_reconciliation(jsonb) from public, anon, authenticated;
grant execute on function trading.record_reconciliation(jsonb) to service_role;

alter table trading.custody_reconciliations enable row level security;
alter table trading.custody_reconciliations force row level security;
grant select on trading.custody_reconciliations to authenticated;
create policy operators_read on trading.custody_reconciliations for select to authenticated using (ops.has_role('viewer'));

alter table trading.custody_movements enable row level security;
alter table trading.custody_movements force row level security;
grant select on trading.custody_movements to authenticated;
create policy operators_read on trading.custody_movements for select to authenticated using (ops.has_role('viewer'));

alter table trading.reconciliation_cursors enable row level security;
alter table trading.reconciliation_cursors force row level security;
grant select on trading.reconciliation_cursors to authenticated;
create policy operators_read on trading.reconciliation_cursors for select to authenticated using (ops.has_role('viewer'));

alter table intelligence.owned_addresses enable row level security;
alter table intelligence.owned_addresses force row level security;
grant select on intelligence.owned_addresses to authenticated;
create policy owned_addresses_operators_read on intelligence.owned_addresses for select to authenticated using (ops.has_role('viewer'));
