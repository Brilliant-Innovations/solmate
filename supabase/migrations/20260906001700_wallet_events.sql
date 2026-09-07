-- Tracked-wallet events (blueprint §3.2, §6.7, §9.3; D8, D26; execution plan M4). Append-only,
-- idempotent on (wallet, signature, movement, kind) so a webhook retry or an overlapping poll can
-- never double-count evidence. block_time is the chain's clock; first_seen_at is ours and the only
-- one replay may use.

create table intelligence.wallet_events (
  id uuid primary key default gen_random_uuid(),
  wallet core.solana_address not null references intelligence.wallets (address),
  signature core.tx_signature not null,
  movement_index integer not null check (movement_index >= 0),
  slot bigint not null check (slot >= 0),
  block_time timestamptz,
  kind text not null check (kind in ('BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT', 'SOL_IN', 'SOL_OUT')),
  mint core.solana_address,
  amount core.amount not null,
  decimals smallint not null check (decimals between 0 and 18),
  quote_mint core.solana_address,
  quote_amount core.amount,
  counterparty core.solana_address,
  source text not null check (source in ('HELIUS_POLL', 'HELIUS_WEBHOOK')),
  first_seen_at timestamptz not null,
  payload_hash core.sha256_hex not null,
  created_at timestamptz not null default now(),
  unique (wallet, signature, movement_index, kind),
  constraint swap_has_quote check ((kind in ('BUY', 'SELL')) = (quote_amount is not null))
);
create index wallet_events_mint_idx on intelligence.wallet_events (mint, block_time desc) where mint is not null;
create index wallet_events_wallet_idx on intelligence.wallet_events (wallet, slot desc);
create trigger wallet_events_immutable before update or delete on intelligence.wallet_events
  for each row execute function core.forbid_update();

create table intelligence.wallet_cursors (
  wallet core.solana_address primary key references intelligence.wallets (address),
  last_signature core.tx_signature,
  last_slot bigint check (last_slot >= 0),
  updated_at timestamptz not null default now()
);
create trigger wallet_cursors_touch before update on intelligence.wallet_cursors
  for each row execute function core.touch_updated_at();

-- Backend-only: append events idempotently and move the wallet's cursor. Returns rows inserted.
create or replace function intelligence.ingest_wallet_events(p_wallet core.solana_address, p_events jsonb, p_cursor jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  e jsonb;
  v_inserted integer := 0;
begin
  if not exists (select 1 from intelligence.wallets w where w.address = p_wallet) then
    raise exception 'wallet % is not tracked', p_wallet using errcode = 'P0001';
  end if;
  if exists (select 1 from intelligence.wallets w where w.address = p_wallet and w.is_owned) then
    raise exception 'wallet % is owned; its flow is not evidence (D26)', p_wallet using errcode = 'P0001';
  end if;
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    insert into intelligence.wallet_events (id, wallet, signature, movement_index, slot, block_time, kind, mint, amount, decimals, quote_mint, quote_amount,
      counterparty, source, first_seen_at, payload_hash)
    values ((e ->> 'id')::uuid, p_wallet, (e ->> 'signature')::core.tx_signature, (e ->> 'movementIndex')::integer, (e ->> 'slot')::bigint,
      (e ->> 'blockTime')::timestamptz, e ->> 'kind', (e ->> 'mint')::core.solana_address, (e ->> 'amount')::core.amount, (e ->> 'decimals')::smallint,
      (e ->> 'quoteMint')::core.solana_address, (e ->> 'quoteAmount')::core.amount, (e ->> 'counterparty')::core.solana_address, e ->> 'source',
      (e ->> 'firstSeenAt')::timestamptz, (e ->> 'payloadHash')::core.sha256_hex)
    on conflict (wallet, signature, movement_index, kind) do nothing;
    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;
  if p_cursor is not null and (p_cursor ->> 'lastSignature') is not null then
    insert into intelligence.wallet_cursors (wallet, last_signature, last_slot)
    values (p_wallet, (p_cursor ->> 'lastSignature')::core.tx_signature, (p_cursor ->> 'lastSlot')::bigint)
    on conflict (wallet) do update set last_signature = excluded.last_signature, last_slot = excluded.last_slot;
  end if;
  return v_inserted;
end
$$;
revoke all on function intelligence.ingest_wallet_events(core.solana_address, jsonb, jsonb) from public, anon, authenticated;
grant execute on function intelligence.ingest_wallet_events(core.solana_address, jsonb, jsonb) to service_role;

alter table intelligence.wallet_events enable row level security;
alter table intelligence.wallet_events force row level security;
grant select on intelligence.wallet_events to authenticated;
create policy operators_read on intelligence.wallet_events for select to authenticated using (ops.has_role('viewer'));

alter table intelligence.wallet_cursors enable row level security;
alter table intelligence.wallet_cursors force row level security;
grant select on intelligence.wallet_cursors to authenticated;
create policy operators_read on intelligence.wallet_cursors for select to authenticated using (ops.has_role('viewer'));
