-- §6.6 / §10.3 / D64: extend the events guard from M1. Two clocks and content stay immutable (as before);
-- additionally last_seen_at may only advance, a cluster assignment is set once, provenance (url hash, quality)
-- never changes, and rows are never deleted. A later, genuinely new source event is a new row.
create or replace function intelligence.events_guard_update()
returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.source_provider is distinct from old.source_provider
     or new.source_id is distinct from old.source_id or new.source_published_at is distinct from old.source_published_at
     or new.source_time_confidence is distinct from old.source_time_confidence or new.first_seen_at is distinct from old.first_seen_at
     or new.payload_hash is distinct from old.payload_hash or new.title is distinct from old.title or new.summary is distinct from old.summary
     or new.source_url_hash is distinct from old.source_url_hash or new.source_quality is distinct from old.source_quality then
    raise exception 'intelligence.events: source time, first_seen_at, payload and content are immutable (D8, D64)';
  end if;
  if new.last_seen_at < old.last_seen_at then
    raise exception 'intelligence.events: last_seen_at cannot move backwards';
  end if;
  if (old.cluster_id is not null and new.cluster_id is distinct from old.cluster_id)
     or (old.corroborates_event_id is not null and new.corroborates_event_id is distinct from old.corroborates_event_id) then
    raise exception 'intelligence.events: cluster assignment is set once';
  end if;
  return new;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'events_no_delete' and tgrelid = 'intelligence.events'::regclass) then
    create trigger events_no_delete before delete on intelligence.events for each row execute function core.forbid_delete();
  end if;
end $$;
