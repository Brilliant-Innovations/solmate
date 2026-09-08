-- §20.20 escalation: each delivery attempt records the escalation level it was made for, so a re-send after an
-- unacknowledged CRITICAL is a new attempt row and "delivered at level N" is answerable from the database.
alter table ops.notification_deliveries add column escalation_level smallint not null default 0 check (escalation_level >= 0);
create index notification_deliveries_level_idx on ops.notification_deliveries (notification_id, channel, escalation_level);
