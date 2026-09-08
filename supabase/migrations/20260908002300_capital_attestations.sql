-- D56 / §29: the capital ceiling live arming attested to, per account and Release. Append-only; the newest row is
-- the ceiling the state projector carries and the authorizer enforces (CAPITAL_REATTEST_REQUIRED above it).
create table ops.capital_attestations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references trading.accounts (id),
  release_id uuid not null references research.releases (id),
  attestation_id uuid not null references research.release_attestations (id),
  ceiling_usd double precision not null check (ceiling_usd > 0),
  recognized_usd_at_attestation double precision check (recognized_usd_at_attestation >= 0),
  attested_by uuid not null references auth.users (id),
  attested_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index capital_attestations_latest_idx on ops.capital_attestations (account_id, attested_at desc);
create trigger capital_attestations_immutable before update or delete on ops.capital_attestations for each row execute function core.forbid_update();
alter table ops.capital_attestations enable row level security;
