-- M11 automated drills (blueprint §29, P10; plan M11 "every P10 drill automated where possible and
-- exposed via Live Readiness Run drill"): an admin asks the worker to execute one of the automatable
-- drills; the worker runs it and records the readiness row with the transcript as evidence. FAST
-- (D41): running a rehearsal widens no authority. Enum value in its own migration (see 003200).
alter type enums.control_request_kind add value if not exists 'EXECUTE_READINESS_DRILL';
