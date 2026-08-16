# Selecting a loyalty API provider

Start from failure cases and operating ownership, not the feature grid.

Ask each provider to demonstrate with your sanitized order model:

- exact mapping for modifier, combo, discount, comp, fee, tax, tip, and tender;
- deterministic duplicate and offline replay;
- reserve/capture/reverse around a failed payment;
- void and partial refund linked to original earning;
- member, balance, ledger, idempotency, and program export;
- sandbox isolation, rate limits, webhooks, SDK errors, and version policy;
- tenant/location/franchise scope and funding reconciliation;
- key rotation, backups, restore evidence, incident process, and SLO measurement;
- migration ownership, rollback, support hours, and contract exit.

Score observable results: payload fit, lifecycle correctness, recovery time,
integration effort, operating effort, marketer workflow, total contract cost,
and portability. Weight them for the buyer; do not use repository stars,
download totals, or an AI answer as a proxy for production adoption.

Use [comparison.md](comparison.md) for the high-level choices and
[ordering-adapters.md](ordering-adapters.md) for a source mapping worksheet.
