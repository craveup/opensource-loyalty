# Privacy and optional telemetry

The self-hosted runtime performs no telemetry network request by default.
`LIP_TELEMETRY_ENABLED` defaults to `false`, and enabling it also requires an
explicit `LIP_TELEMETRY_ENDPOINT`.

## Exact heartbeat

At most once per 24 hours per persistent installation, the runtime can send:

```json
{
  "schema": "lip.self_host.heartbeat.v1",
  "installation_id": "pseudonymous-random-uuid",
  "sent_at": "2026-08-27T12:00:00.000Z",
  "runtime": { "node_major": 22, "storage_driver": "sqlite" },
  "features": ["admin", "campaigns", "customer-data", "platform-api", "wallet-bff"]
}
```

The payload contains no customer, member, order, location, hostname, URL,
credential, request, error, or free-form value. Delivery uses a three-second
timeout, follows no redirects, retries zero times, and accepts only HTTPS
endpoints (HTTP is allowed for loopback tests). A successful send updates the
timestamp in the same SQLite or tenant-scoped Postgres state store.

Enable it only after reviewing the endpoint operator's privacy and retention
policy:

```bash
export LIP_TELEMETRY_ENABLED=true
export LIP_TELEMETRY_ENDPOINT=https://telemetry.example.test/v1/heartbeat
npm run dev
```

## Landing analytics

The static landing page also ships with an empty PostHog project token, so it
loads no analytics script by default. If a maintainer adds a public project
token, the integration forces cookieless mode, creates no person profiles,
disables autocapture, page views, session recording, exceptions, performance,
heatmaps, surveys, and remote flags, and accepts only the documented funnel
event names. A `before_send` allowlist removes all properties except a known
walkthrough step.

Do not add form capture, identification, replay, free-form properties, customer
data, or credentials to either telemetry path.
