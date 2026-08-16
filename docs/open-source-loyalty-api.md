# What an open-source loyalty API should provide

Source availability alone does not make a loyalty system portable. A useful
open API needs a versioned transaction contract, executable validation,
deterministic retry semantics, a ledger that explains balance changes, and an
export path that does not depend on one hosted account.

For foodservice, evaluate the full order lifecycle rather than only
`addPoints`: open-cart estimates, reservation before payment, capture after
payment, failed-payment reversal, duplicate delivery, offline replay, void,
partial refund, business date, modifiers, comps, fees, tax, tip, and split
tenders. Exact integer money and stable idempotency keys are prerequisites.

LIP supplies an OpenAPI/JSON Schema contract, foodservice lifecycle semantics,
an Apache-2.0 reference engine, SQLite/Postgres adapters, TypeScript SDK, CLI,
Admin, webhooks, adapter certification, state migration, and black-box
conformance. The protocol is a working draft and Cloud is preview software; it
does not yet have independent provider conformance reports or public production
SLO evidence.

When evaluating any project, clone it, run its tests, inspect the license and
release provenance, simulate duplicate/refund behavior, verify data export, and
identify who owns upgrades, backups, security response, and reconciliation.
