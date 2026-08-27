# Security policy

Do not report security vulnerabilities in a public issue. Contact the repository
maintainers privately with the affected version, reproduction steps, and impact.

Implementations must use TLS, authenticate every non-health endpoint, avoid
placing direct customer identifiers in logs or idempotency keys, and encrypt
sensitive identity claims at rest. The protocol permits identity references so
that transaction processors do not need to receive raw email addresses or phone
numbers.

## Public repository data policy

Everything committed here must be safe for permanent public distribution,
including Git history, tests, fixtures, screenshots, generated files, issue
templates, and documentation. Use synthetic `example.test` identities and
generic tenant/location/source identifiers. Never commit customer or employee
data, production payloads, credentials, private URLs, webhook signatures,
provider tokens, confidential contracts, or unreleased vendor documentation.

Source adapters require sanitized or synthetic fixtures and must distinguish
repository certification from vendor endorsement. Self-host telemetry is
disabled by default and its fixed allowlisted payload is documented in
[docs/telemetry.md](docs/telemetry.md). Landing analytics must remain
cookieless, personless, replay-free, and restricted to the documented funnel
events.
