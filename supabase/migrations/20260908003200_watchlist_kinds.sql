-- §20.4 / §20.27 operator attention controls. Enum values live in their own migration because a
-- value cannot be referenced in the transaction that adds it. All three are FAST (D41): they
-- never grant eligibility or execution permission, only attention and a research re-run.
alter type enums.control_request_kind add value if not exists 'WATCH_ASSET';
alter type enums.control_request_kind add value if not exists 'UNWATCH_ASSET';
alter type enums.control_request_kind add value if not exists 'REQUEST_RESEARCH_REFRESH';
