-- Per-wallet tracking switch, database-level INV-11 and missing immutability (blueprint §6.7, D26,
-- §6.2; interim review R4-07, R4-16). A tracked wallet's history is immutable evidence and stays;
-- polling can be paused for wallets that turn out to be noise (bots emitting hundreds of events a
-- minute) without touching what was already recorded.

alter table intelligence.wallets add column tracking_active boolean not null default true;
create index wallets_tracking_idx on intelligence.wallets (tracking_active) where tracking_active;

-- Ownership must hold in the database, not only in whichever worker role happens to run (R4-07):
-- every trading wallet and custody address is registered as owned the moment it is inserted.
create or replace function intelligence.register_owned_from_account()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into intelligence.owned_addresses (address, purpose, cluster, account_id)
  values (new.trading_wallet, 'TRADING_WALLET', new.cluster, new.id)
  on conflict (address) do nothing;
  update intelligence.wallets set is_owned = true where address = new.trading_wallet and not is_owned;
  return new;
end $$;
create trigger accounts_register_owned after insert on trading.accounts
  for each row execute function intelligence.register_owned_from_account();

create or replace function intelligence.register_owned_from_custody()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_cluster enums.solana_cluster;
begin
  select cluster into v_cluster from trading.accounts where id = new.account_id;
  insert into intelligence.owned_addresses (address, purpose, cluster, account_id)
  values (new.address,
    case new.kind when 'TRADING_WALLET' then 'TRADING_WALLET' when 'ASSOCIATED_TOKEN_ACCOUNT' then 'ASSOCIATED_TOKEN_ACCOUNT'
      when 'JUPITER_TRIGGER_VAULT' then 'JUPITER_TRIGGER_VAULT' else 'OTHER' end,
    coalesce(v_cluster, 'mainnet-beta'), new.account_id)
  on conflict (address) do nothing;
  update intelligence.wallets set is_owned = true where address = new.address and not is_owned;
  return new;
end $$;
create trigger custody_register_owned after insert on trading.custody_accounts
  for each row execute function intelligence.register_owned_from_custody();

-- Wallet-event ingest refuses any owned address, from every source of ownership.
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
  if exists (select 1 from intelligence.wallets w where w.address = p_wallet and w.is_owned)
     or exists (select 1 from intelligence.owned_addresses o where o.address = p_wallet)
     or exists (select 1 from trading.accounts a where a.trading_wallet = p_wallet)
     or exists (select 1 from trading.custody_accounts c where c.address = p_wallet) then
    update intelligence.wallets set is_owned = true where address = p_wallet and not is_owned;
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

-- Immutability that was missing (R4-16): emergency route snapshots are history; an owned address may
-- only ever be retired (retired_at null → set), never un-owned, re-purposed or deleted.
create trigger emergency_exit_route_snapshots_immutable before update or delete on core.emergency_exit_route_snapshots
  for each row execute function core.forbid_update();

create or replace function intelligence.owned_addresses_guard_update()
returns trigger language plpgsql as $$
begin
  if old.retired_at is not null or new.retired_at is null
     or (to_jsonb(old) - 'retired_at') <> (to_jsonb(new) - 'retired_at') then
    raise exception 'intelligence.owned_addresses: only retired_at may be set, once (D26)';
  end if;
  return new;
end $$;
create trigger owned_addresses_guard before update on intelligence.owned_addresses
  for each row execute function intelligence.owned_addresses_guard_update();
create trigger owned_addresses_no_delete before delete on intelligence.owned_addresses
  for each row execute function core.forbid_delete();
