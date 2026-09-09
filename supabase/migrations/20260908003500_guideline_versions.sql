-- §11.5 / §20.12: versioned behavioural guidelines as a ledger fact, so the Skill Console renders
-- and diffs them from the database rather than from code the browser cannot import. Immutable once
-- registered; a new guideline set is a new version bound by a new skill version (§11.1).
create table agents.guideline_versions (
  version_id core.version_id primary key,
  skill_id text not null check (length(skill_id) between 1 and 64),
  rules jsonb not null check (jsonb_typeof(rules) = 'array' and jsonb_array_length(rules) >= 1),
  registered_at timestamptz not null default now()
);
alter table agents.guideline_versions enable row level security;
alter table agents.guideline_versions force row level security;
grant select on agents.guideline_versions to authenticated;
create policy operators_read on agents.guideline_versions for select to authenticated using (ops.has_role('viewer'));
create trigger guideline_versions_immutable before update or delete on agents.guideline_versions for each row execute function core.forbid_update();
