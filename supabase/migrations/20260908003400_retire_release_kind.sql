-- §20.29 Releases: `Retire` is an admin control with step-up; live artifacts are never edited in
-- place and a retired Release cannot be re-armed. Enum value in its own migration (see 003200).
alter type enums.control_request_kind add value if not exists 'RETIRE_RELEASE';
