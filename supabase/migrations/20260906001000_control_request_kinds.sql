-- Passkey lifecycle requests (§20.26, D41; ADR-0006). Enum values are added in their own
-- migration because a value cannot be referenced in the transaction that adds it.
alter type enums.control_request_kind add value if not exists 'REGISTER_PASSKEY';
alter type enums.control_request_kind add value if not exists 'REVOKE_PASSKEY';
