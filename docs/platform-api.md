# Customer engagement platform API

The reference runtime exposes a non-normative customer engagement API at
`/platform/v1`. It is the product layer for marketer workflows; it does not
change the portable transaction contract at `/lip/v1`.

## Boundaries

- `/lip/v1` is the vendor-neutral protocol for member, order, accrual,
  redemption, balance, reward, and ledger operations.
- `/platform/v1` is the reference product API for profiles, consent, behavioral
  events, imports, segments, campaigns, connectors, and attribution.
- Customer sign-in remains external. A BFF validates OIDC and maps the subject
  to an opaque `member_id`.
- Every route requires Bearer authentication. `viewer` can read; platform
  writes require a role with `platform:write`. Location-scoped credentials fail
  closed because these endpoints currently return tenant-wide customer data.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/platform/v1` | Version and boundary discovery |
| `GET`, `PUT` | `/platform/v1/members` | List or upsert customer profiles and consent |
| `GET`, `POST` | `/platform/v1/events` | List or ingest idempotent behavioral events |
| `GET`, `PUT` | `/platform/v1/segments` | List or upsert static/dynamic audiences |
| `POST` | `/platform/v1/segments/preview` | Count and sample a segment before use |
| `GET`, `PUT` | `/platform/v1/campaigns` | List or upsert reward campaigns |
| `POST` | `/platform/v1/campaigns/status` | Activate, pause, or return a campaign to draft |
| `POST` | `/platform/v1/campaigns/run` | Execute an active campaign idempotently |
| `GET` | `/platform/v1/campaigns/report` | Attribution report for one campaign |
| `GET`, `PUT` | `/platform/v1/connectors` | List redacted connectors or upsert one |
| `POST` | `/platform/v1/connectors/delete` | Delete a connector explicitly |
| `GET` | `/platform/v1/analytics` | Customer-data and loyalty rollups |
| `POST` | `/platform/v1/imports/members` | Bounded JSON-row or CSV member import |

## Synthetic profile example

```bash
curl --fail-with-body -X PUT http://127.0.0.1:3210/platform/v1/members \
  -H 'Authorization: Bearer lip-dev-key' \
  -H 'Content-Type: application/json' \
  --data '{
    "member_id": "member-demo-101",
    "external_id": "guest-demo-101",
    "email": "guest101@example.test",
    "consent": { "marketing": true, "source": "synthetic-quickstart" }
  }'
```

Event writes require an `idempotency_key`. Replaying the same key with the same
facts returns the existing event; changing the facts returns a conflict.

## CSV import safety

CSV imports are limited to 1 MiB and 1,000 data rows. Headers must be unique and
come from the documented allowlist. Every row must match the header width.
`attributes_json` must be an object and rejects prototype-like keys. Never place
credentials or payment data in profile attributes.

The machine-readable surface is [spec/platform-openapi.yaml](../spec/platform-openapi.yaml).
It documents the reference product API and is intentionally separate from the
normative [LIP OpenAPI](../spec/openapi.yaml).
