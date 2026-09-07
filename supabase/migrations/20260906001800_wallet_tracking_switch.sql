-- Per-wallet tracking switch (blueprint §6.7). A tracked wallet's history is immutable evidence
-- and stays; polling can be paused for wallets that turn out to be noise (bots emitting hundreds
-- of events a minute) without touching what was already recorded.

alter table intelligence.wallets add column tracking_active boolean not null default true;
create index wallets_tracking_idx on intelligence.wallets (tracking_active) where tracking_active;
