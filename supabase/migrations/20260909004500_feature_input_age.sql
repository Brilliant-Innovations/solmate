-- Data age on a feature snapshot (WP1b, 2026-09-09).
--
-- `as_of` is when the feature was *computed*. With FEATURES_INTERVAL_MS at 60s the engine recomputes
-- every minute whether or not its inputs moved: measured on 2026-09-09 it ran roughly 200x more often
-- than the candles beneath it changed, so `as_of` stayed seconds old over inputs five hours stale.
-- Nothing on the row recorded the difference, which is why cold features did not look cold from
-- inside the system, and why the S0 gate's FEATURES_STALE check could not catch them.
--
-- `newest_input_at` is the newest closed input bucket behind the vector. Nullable because a snapshot
-- can legitimately have no closed bucket behind it; the gate treats null as stale, since absence is
-- the unsafe direction.
alter table signals.feature_snapshots add column if not exists newest_input_at timestamptz;

comment on column signals.feature_snapshots.newest_input_at is
  'Newest closed input bucket behind these features. as_of is computation time; this is data age (ADR-0011, WP1b). Null means no closed bucket, which the S0 gate treats as stale.';

-- Existing rows predate the column and their true input age is not recoverable: they were written by
-- the ingestion that produced 97.9% of candles more than five minutes stale. Left null on purpose so
-- they read as stale rather than as unknown-but-fine.
