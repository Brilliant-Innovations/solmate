-- M10 replay (§18, P9): the operator files a replay run as a control request; the worker's replay
-- role validates it, records the run with every version it binds and executes it. FAST (D41): a
-- replay reads captured data and writes research rows only; it can never touch capital.
-- Enum value in its own migration (see 003200).
alter type enums.control_request_kind add value if not exists 'RUN_REPLAY';
