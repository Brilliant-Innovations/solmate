-- Whether an agent run's recorded cost is what the provider billed, or a floor (2026-09-10).
--
-- A model call that overruns our own deadline is aborted client-side, and the provider may well have
-- generated and billed for it; a non-2xx may not have been billed at all. Both recorded cost_usd = 0,
-- which made a failed cycle look free.
--
-- That is not only a spend-accounting gap. EVALUATION.md 7(2) expresses the go/no-go threshold as net
-- edge per decision divided by model cost per decision, so an undercounted denominator inflates the
-- measured edge - and the undercount is biased toward the most expensive calls, since a timeout is by
-- definition a long generation. Both errors point the same way: toward proceeding.
--
-- So the uncertainty is recorded rather than rounded to zero. MEASURED means the provider returned
-- usage metadata and cost_usd is what it billed (this includes malformed output: the call completed
-- and was billed, it just did not parse). UNKNOWN means the call ended without metadata - timeout or
-- outage - and cost_usd is a floor, not a measurement.
alter table agents.runs add column if not exists cost_accrual text not null default 'MEASURED'
  check (cost_accrual in ('MEASURED', 'UNKNOWN'));

comment on column agents.runs.cost_accrual is
  'MEASURED: cost_usd is what the provider billed. UNKNOWN: the call ended without usage metadata (timeout or outage) and cost_usd is a floor. Any metric dividing by model cost must report the UNKNOWN share alongside it (EVALUATION.md 7(2)).';

-- Existing rows predate the distinction. Defaulting them to MEASURED is wrong for whichever were
-- failures, so correct those from what the row already records: a run that did not succeed and has
-- zero tokens never returned usage metadata.
update agents.runs set cost_accrual = 'UNKNOWN'
where success = false and coalesce((tokens ->> 'input')::bigint, 0) = 0 and coalesce((tokens ->> 'output')::bigint, 0) = 0;
