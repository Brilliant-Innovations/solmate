-- Foundation: extensions, schemas, closed vocabularies, domains, helper functions.
-- Blueprint §5.3 (SQL migrations are schema authority), §6 (entities), §23.2 (RLS, service roles).
-- Column shapes mirror /libs/contracts; the contract set is canonical, this schema stores it.

create extension if not exists pgcrypto;
create extension if not exists pgmq;

create schema if not exists core;
create schema if not exists market;
create schema if not exists intelligence;
create schema if not exists signals;
create schema if not exists agents;
create schema if not exists trading;
create schema if not exists risk;
create schema if not exists research;
create schema if not exists ops;
create schema if not exists audit;
create schema if not exists enums;

-- ---------------------------------------------------------------------------------------------
-- Closed vocabularies (mirror libs/contracts/src/enums.ts; values identical)
-- ---------------------------------------------------------------------------------------------
create type enums.capital_authority as enum ('OBSERVE', 'PAPER', 'LIVE_APPROVAL', 'LIVE_AUTO');
create type enums.activity_state as enum ('OFF', 'STARTING', 'WATCH', 'ACTIVE', 'EVENT_WINDOW', 'WIND_DOWN');
create type enums.deployment_profile as enum ('P0', 'P1A', 'P1B', 'P2', 'P3', 'P4');
create type enums.speed_tier as enum ('T0_FAST', 'T1_MOMENTUM', 'T2_CONTEXTUAL', 'T3_CATALYST');
create type enums.trading_action_type as enum ('ENTER', 'IGNORE', 'HOLD', 'REDUCE', 'EXIT', 'ADJUST_PROTECTION', 'ADD');
create type enums.proposal_source as enum ('AI', 'DETERMINISTIC');
create type enums.adversary_verdict as enum ('CONFIRM', 'CHALLENGE', 'REJECT');
create type enums.agent_role as enum ('TRADING_PROPOSER', 'ACTION_ADVERSARY', 'EVENT_CLASSIFIER', 'SUMMARIZER');
create type enums.action_cycle_state as enum ('TRIGGERED', 'CONTEXT_BUILT', 'PROPOSED', 'REVISION_REQUESTED', 'CLEARED', 'REJECTED', 'EXPIRED', 'UNRESOLVED');
create type enums.unresolved_reason as enum ('DISAGREEMENT', 'ADVERSARY_UNAVAILABLE', 'TIMEOUT', 'BUDGET', 'MALFORMED_OUTPUT', 'REVISION_EXHAUSTED');
create type enums.strategy_status as enum ('EXPERIMENTAL', 'PAPER', 'ELIGIBLE_LIVE', 'RETIRED');
create type enums.skill_status as enum ('DRAFT', 'PAPER', 'ELIGIBLE_LIVE', 'RETIRED');
create type enums.release_status as enum ('DRAFT', 'PAPER_VALIDATED', 'ELIGIBLE_LIVE', 'ARMED', 'RETIRED');
create type enums.automation_trigger_family as enum ('CANDIDATE', 'OPEN_POSITION', 'SYSTEM');
create type enums.tool_classification as enum ('READ_ONLY', 'PROPOSAL_ONLY');
create type enums.position_review_state as enum ('REVIEWED', 'PROTECTION_ONLY', 'BUDGET_PAUSED');
create type enums.position_safety_state as enum ('NORMAL', 'DEGRADED', 'EXIT_RECOMMENDED', 'CRITICAL_EXIT');
create type enums.position_status as enum ('OPEN', 'CLOSING', 'CLOSED');
create type enums.protection_mode as enum ('MONITORED_EXIT', 'JUPITER_TRIGGER');
create type enums.stop_model as enum ('ATR', 'STRUCTURE_LOW', 'PERCENTAGE', 'STRATEGY_INVALIDATION');
create type enums.take_profit_policy as enum ('FIXED_R', 'PARTIAL_TIERS', 'TRAILING_AFTER_THRESHOLD', 'VOLATILITY_TRAIL', 'MOMENTUM_DECAY', 'TIME_STOP');
create type enums.trade_side as enum ('BUY', 'SELL');
create type enums.intent_action as enum ('ENTER', 'ADD', 'REDUCE', 'EXIT', 'PROTECTION_INSTALL', 'PROTECTION_CANCEL_WITHDRAW', 'EMERGENCY_CLOSE');
create type enums.exposure_effect as enum ('INCREASE', 'NEUTRAL', 'REDUCE');
create type enums.order_attempt_state as enum ('PREPARED', 'SIGNED_NOT_SUBMITTED', 'SUBMITTED', 'CONFIRMED_PROVISIONAL', 'FINALIZED', 'REORG_PENDING', 'NOT_LANDED');
create type enums.chain_commitment as enum ('processed', 'confirmed', 'finalized');
create type enums.execution_path as enum ('JUPITER_ORDER', 'PROVIDER_PROTECTIVE', 'DIRECT_POOL_PRIVATE', 'DIRECT_POOL_RPC');
create type enums.transaction_class as enum ('SWAP_V2', 'TRIGGER_DEPOSIT', 'TRIGGER_CANCEL_WITHDRAW', 'TRIGGER_AUTH_CHALLENGE', 'DIRECT_POOL_EMERGENCY_EXIT', 'SWEEP_TO_COLD_RECOVERY');
create type enums.emergency_command_type as enum ('PAUSE_NEW_ENTRIES', 'EMERGENCY_CLOSE_ASSET', 'EMERGENCY_CLOSE_ALL');
create type enums.custody_kind as enum ('TRADING_WALLET', 'ASSOCIATED_TOKEN_ACCOUNT', 'JUPITER_TRIGGER_VAULT', 'APPROVED_OTHER');
create type enums.asset_status as enum ('DISCOVERED', 'EVALUATING', 'ELIGIBLE', 'BLOCKED', 'RETIRED');
create type enums.candidate_status as enum ('DETECTED', 'ENRICHING', 'REJECTED', 'AGENT_REVIEW', 'QUALIFIED', 'EXPIRED');
create type enums.trigger_family as enum ('MOMENTUM_CONTINUATION', 'EARLY_ACCELERATION', 'SMART_MONEY_ACCUMULATION', 'CATALYST_RESPONSE', 'SOCIAL_ACCELERATION', 'HOLDER_LIQUIDITY_EXPANSION', 'MANUAL_WATCH');
create type enums.market_regime as enum ('RISK_ON_TREND', 'BROAD_SELLOFF', 'SOL_LED_RALLY', 'NARRATIVE_ROTATION', 'LOW_LIQUIDITY_CHOP', 'VOLATILITY_SHOCK', 'POST_EVENT_INSTABILITY');
create type enums.market_session as enum ('ASIA', 'EUROPE', 'US', 'ASIA_EUROPE_OVERLAP', 'EUROPE_US_OVERLAP', 'WEEKEND');
create type enums.data_provenance as enum ('LIVE', 'BACKFILL', 'REPLAY');
create type enums.event_kind as enum ('NEWS', 'SOCIAL', 'ONCHAIN', 'PROJECT', 'MACRO', 'LISTING', 'SECURITY', 'OTHER');
create type enums.source_quality_class as enum ('OFFICIAL_PROJECT', 'OFFICIAL_EXCHANGE_PROTOCOL', 'PRIMARY_GOVERNMENT_REGULATORY', 'REPUTABLE_PUBLICATION', 'ANALYTICS_PROVIDER', 'IDENTIFIED_CREATOR', 'UNKNOWN_SOCIAL');
create type enums.source_time_confidence as enum ('HIGH', 'MEDIUM', 'LOW', 'ABSENT');
create type enums.wallet_classification as enum ('SMART_MONEY', 'WHALE', 'DEV', 'INSIDER', 'SNIPER', 'BUNDLER', 'EXCHANGE', 'TREASURY', 'OWNED', 'UNKNOWN');
create type enums.funding_event_state as enum ('PREPARED', 'WALLET_PROMPTED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'ABANDONED');
create type enums.alert_severity as enum ('INFO', 'NOTICE', 'HIGH', 'CRITICAL');
create type enums.operator_role as enum ('viewer', 'operator', 'admin');
create type enums.actor_kind as enum ('OPERATOR', 'WORKER', 'RISK_AUTHORIZER', 'EXECUTOR', 'OUT_OF_BAND_KEY', 'AUTOMATION', 'WATCHDOG', 'SCHEDULE');
create type enums.provider_health as enum ('HEALTHY', 'DEGRADED', 'FAILED');
create type enums.solana_cluster as enum ('mainnet-beta', 'devnet', 'testnet', 'localnet');
create type enums.notification_channel as enum ('IN_APP', 'PUSH', 'TELEGRAM', 'SMS', 'EMAIL');
create type enums.token_program as enum ('TOKEN', 'TOKEN_2022', 'UNKNOWN');
create type enums.authority_state as enum ('NONE', 'PRESENT', 'UNKNOWN');
create type enums.candle_resolution as enum ('15s', '1m', '5m', '15m', '1h', '4h');
create type enums.strategy_id as enum ('S0_RAW', 'S0_SAFE', 'S1', 'S2', 'S3', 'S4');
create type enums.audit_origin as enum ('NORMAL', 'EMERGENCY_JOURNAL_IMPORT', 'WATCHDOG');
create type enums.control_request_kind as enum (
  'SET_REQUESTED_MODE', 'PAUSE_NEW_ENTRIES', 'RESUME_NEW_ENTRIES', 'APPROVE_AUTHORIZATION', 'REJECT_AUTHORIZATION',
  'MANUAL_REDUCE', 'MANUAL_CLOSE', 'EMERGENCY_CLOSE_ALL', 'ACKNOWLEDGE_ALERT', 'PROMOTE_RELEASE', 'ARM_RELEASE',
  'RUN_READINESS_DRILL', 'START_SESSION', 'END_SESSION'
);
create type enums.control_request_state as enum ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- ---------------------------------------------------------------------------------------------
-- Domains (mirror primitives.ts)
-- ---------------------------------------------------------------------------------------------
create domain core.amount as numeric(20, 0) check (value >= 0 and value <= 18446744073709551615);
create domain core.signed_amount as numeric(21, 0);
create domain core.bps as integer check (value between 0 and 10000);
create domain core.fraction as double precision check (value >= 0 and value <= 1);
create domain core.sha256_hex as text check (value ~ '^[0-9a-f]{64}$');
create domain core.ed25519_signature_hex as text check (value ~ '^[0-9a-f]{128}$');
create domain core.key_id as text check (value ~ '^ed25519:[0-9a-f]{32}$');
create domain core.solana_address as text check (value ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
create domain core.tx_signature as text check (value ~ '^[1-9A-HJ-NP-Za-km-z]{86,88}$');
create domain core.version_id as text check (length(value) between 1 and 64);
create domain core.reason_code as text check (value ~ '^[A-Z][A-Z0-9_]{2,63}$');
create domain core.nonce as text check (value ~ '^[0-9a-f]{32}$');

-- ---------------------------------------------------------------------------------------------
-- Operators and role resolution (§20.26). The browser acts as an authenticated Supabase user;
-- its role comes from this table, never from a claim the client can set.
-- ---------------------------------------------------------------------------------------------
create table ops.operators (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role enums.operator_role not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create or replace function ops.current_operator_role()
returns enums.operator_role
language sql
stable
security definer
set search_path = ''
as $$
  select o.role
  from ops.operators o
  where o.user_id = auth.uid() and o.disabled_at is null
$$;

revoke all on function ops.current_operator_role() from public;
grant execute on function ops.current_operator_role() to authenticated;

create or replace function ops.has_role(minimum enums.operator_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case ops.current_operator_role()
    when 'admin' then true
    when 'operator' then minimum in ('viewer', 'operator')
    when 'viewer' then minimum = 'viewer'
    else false
  end
$$;

revoke all on function ops.has_role(enums.operator_role) from public;
grant execute on function ops.has_role(enums.operator_role) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Immutability helpers (D7, D38, §6.10D, §6.11–6.14, §6.22). Attached per table below.
-- ---------------------------------------------------------------------------------------------
create or replace function core.forbid_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'rows in %.% are append-only', tg_table_schema, tg_table_name using errcode = 'P0001';
end $$;

create or replace function core.forbid_update()
returns trigger language plpgsql as $$
begin
  raise exception 'rows in %.% are immutable', tg_table_schema, tg_table_name using errcode = 'P0001';
end $$;

create or replace function core.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
