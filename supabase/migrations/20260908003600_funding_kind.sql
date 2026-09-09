-- §20.18 manual funding: the browser reports what the operator's own wallet signed as a control
-- request; the worker records the funding event and reconciliation confirms it from chain deltas.
-- Enum value in its own migration (see 003200). FAST (D41): the external wallet's own prompt is the
-- signing authority and the transfer cannot widen trading authority.
alter type enums.control_request_kind add value if not exists 'FUND_TRADING_WALLET';
