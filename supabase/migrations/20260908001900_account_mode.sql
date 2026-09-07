-- M5a: paper accounts are first-class trading accounts with virtual custody (blueprint §17, §6.16).
-- Chain/custody reconciliation (D9, D45) is authoritative for LIVE accounts only; a PAPER account's
-- wallet is an identifier for quotes and attribution, never a custody claim, so reconciliation and
-- the owned-address registry must be able to tell them apart.
create type enums.account_mode as enum ('LIVE', 'PAPER');

alter table trading.accounts add column mode enums.account_mode not null default 'LIVE';
create index accounts_mode_idx on trading.accounts (mode);

-- A paper account never carries live custody rows.
create or replace function trading.custody_accounts_live_only()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_mode enums.account_mode;
begin
  select mode into v_mode from trading.accounts where id = new.account_id;
  if v_mode = 'PAPER' then
    raise exception 'trading.custody_accounts: a PAPER account has virtual custody only (§17)';
  end if;
  return new;
end $$;
create trigger custody_accounts_live_only before insert on trading.custody_accounts
  for each row execute function trading.custody_accounts_live_only();

-- Mode is immutable: a paper book can never be promoted into a live account (§31 "one physical live wallet").
create or replace function trading.accounts_mode_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.mode <> old.mode then
    raise exception 'trading.accounts: mode is immutable';
  end if;
  return new;
end $$;
create trigger accounts_mode_immutable before update on trading.accounts
  for each row execute function trading.accounts_mode_immutable();
