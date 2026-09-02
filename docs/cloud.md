# Loyalty Interchange Cloud control plane

Loyalty Interchange Cloud is the managed-service layer around the open protocol
and engine. It is intentionally separate from `/lip/v1`: the protocol remains
portable and self-hostable, while the control plane manages organizations,
projects, environments, plans, subscriptions, provisioning, and usage limits.

## Product boundary

The durable business model is managed operations, not protocol lock-in:

- **Open source:** protocol, engine, SDKs, CLI, MCP, Admin UI, SQLite/Postgres
  storage, Docker deployment, and conformance tooling.
- **Cloud:** one-click environments, upgrades, backups, monitoring, regional
  operation, usage billing, managed messaging, and support.
- **Enterprise:** SSO/SCIM, dedicated infrastructure, private networking,
  contractual SLAs, data residency, and migration assistance.

Customers can leave Cloud and run the same LIP data plane themselves. Cloud
revenue comes from removing operational work and risk.

## Current vertical slice

The `@loyalty-interchange/cloud` workspace includes:

- tenant-safe organizations, issuer/subject identities, invitations, and
  membership management;
- projects and development, staging, or production environments;
- generated `tenant_id` and configured `program_id` data-plane scopes;
- queued provisioning records for each environment;
- a claim-safe provisioning worker with retries and a provider interface;
- Free, Pro, and Business plan definitions;
- one subscription per organization;
- idempotent monthly usage events and counters;
- hard quota enforcement under a transaction lock;
- an authenticated management API with direct OIDC or trusted-gateway modes;
- a Stripe billing adapter with signed webhook verification, plus a provider
  boundary for alternate billing systems.

New organizations use the `manual` billing provider on the Free plan. When
Stripe secret, webhook secret, and plan price ids are configured, owners,
admins, or billing members can create Checkout sessions and signed subscription
webhooks update the Cloud subscription. New environments remain `pending`
until a provisioning adapter processes their job. A local adapter ships today
(see below); regional infrastructure adapters remain future work.

## Local data-plane provisioner

Setting `LIP_CLOUD_PUBLIC_BASE_URL` starts the diskless managed runtime: one
listener, path-scoped tenant runtimes, and every durable byte in Postgres (see
[the diskless managed runtime runbook](https://github.com/craveup-oss/opensource-loyalty/blob/main/docs/runbooks/diskless-managed-runtime.md).
Setting `LIP_CLOUD_PROGRAM_DIR`
instead starts the standalone file-backed provisioner with
`LocalDataPlaneProvisioner`, which runs one LIP data-plane runtime per
environment inside the control-plane process. Each `create` job:

1. loads `<program_id>.json` from the program directory;
2. starts an isolated runtime — per-environment SQLite under
   `LIP_CLOUD_DATA_DIR` (default `.lip-cloud`), or tenant-scoped Postgres when
   `LIP_CLOUD_DATA_PLANE_DATABASE_URL` is set;
3. allocates a **stable port** from `LIP_CLOUD_DATA_PLANE_BASE_PORT` (default
   `13210`) recorded in `<data-dir>/ports.json`;
4. bootstraps an owner-role **merchant API key** through the tenant's own
   access-control service (hashed, audited, rotatable) and writes a `0600`
   AES-256-GCM credential envelope
   (`<data-dir>/<environment_id>.credentials.json`, format v3). The encrypted
   payload retains a v2 merchant credential plus a deprecated root key for
   backward-compatible runtime restore; legacy plaintext v1/v2 loads only when
   `LIP_CLOUD_ALLOW_LEGACY_CREDENTIAL_MIGRATION=true` and is immediately
   rewritten as v3; and
5. marks the environment `ready` with its reachable `api_url` and `admin_url`.

Merchant credentials are retrieved and rotated through the control plane:
`POST /cloud/v1/environments/{id}/credentials/rotate` (platform-admin
operator, org-scoped operator covering that org, or org owner/admin;
audited cloud-side, and tenant-side as actor `cloud:<subject>` where the
subject is the **verified** operator identity), with an
optional body `{"overlap_seconds": <0..604800>}` — `0` is an emergency
immediate cutover; the default keeps the replaced key valid for 24 h. The
response includes `replaced_api_key_expires_at`, the moment the previous
merchant key stops working. The equivalent CLI verb (all shown flags
required except `--overlap-seconds`; the key comes from the environment,
never a flag):

```bash
LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:provision -- rotate-credentials \
  --cloud-url https://<control-plane-host> \
  --environment env_... \
  [--overlap-seconds 0]
```

The root runtime key is never returned by any API. Tenants can additionally
self-rotate any of their keys via `POST /admin/api/v1/access/api-keys/rotate`
on their runtime; a rotated key's replacement inherits its expiry (an
explicit `expires_at` may shorten it, never extend it). If the tenant
self-rotates the merchant key, the control-plane rotation surface recovers by
re-adopting the live `cloud-merchant` lineage instead of failing.

New tenants start with zero webhook subscriptions. `provisionTenant` /
`npm run cloud:provision` accept an optional `--webhook-url` +
`--webhook-secret` (>= 16 chars) pair that creates the tenant's first
subscription through the runtime's admin API at provision time (stable
subscription id, so re-runs upsert), minting the merchant credential as a
side effect and returning it in the result.

On control-plane startup the provisioner calls `restore()` and relaunches every
credentialed environment on the same port and API key so BFF `LIP_URL` values
survive restarts. A weak, tampered, or unreadable credentials file is skipped
with a `cloud_environment_restore_failed` log line instead of aborting the
other tenants' restore. Set `LIP_CLOUD_DATA_PLANE_HOST` to control the bind
address and `LIP_CLOUD_DATA_PLANE_PUBLIC_HOST` to control the hostname written
into each runtime's `api_url` (for example a private-network service name).
Set `LIP_CLOUD_CREDENTIAL_KEY` to a 32-byte base64url key from an approved
secret manager. Credential files are `0600`, authenticated, and written
atomically. The local SQLite adapter also exposes audited operations at
`POST /cloud/v1/environments/{id}/operations/{suspend|resume|backup|restore}`.
Backup quiesces and resumes the runtime, writes a private checksummed encrypted
artifact under `LIP_CLOUD_BACKUP_DIR`, and restore requires a `backup_id` while
the environment is suspended. Local backup refuses Postgres; use
provider-native PITR there. Regional adapters still replace the local
provisioner for production.

`npm run cloud:migrate` applies the engine and control-plane schemas ahead of
boot (for release/preDeploy steps), and `npm run cloud:provision` onboards one
tenant end to end through the API surface below. Deployment and operations for
the shared cluster are documented in
[the shared-cluster provisioning runbook](runbooks/shared-cluster-provisioning.md).

## Attaching a data-plane host

`POST /cloud/v1/environments/{environment_id}/attach` binds an environment to
a LIP data-plane host you run yourself — anywhere, on any infrastructure —
without any cloud-provider API. This is the remote counterpart to the
in-process `LocalDataPlaneProvisioner` above: instead of provisioning a
runtime, the control plane validates and records a host you already run.

Request body:

```json
{ "endpoint_url": "https://lip.example.com", "api_key": "lip_sk_..." }
```

Attach is synchronous — no job is queued. The control plane performs five
checks against `endpoint_url` before binding it:

1. the URL uses public HTTPS, has no credentials, query, or fragment, and its
   DNS answers contain no private or reserved addresses;
2. `GET /health` responds and reports `status: "ok"`;
3. `GET /.well-known/lip` matches the expected protocol version and profile;
4. the supplied `api_key` authenticates against `GET /lip/v1/capabilities`,
   and an unknown key is correctly rejected;
5. `POST /lip/v1/programs/get` confirms the host serves the environment's
   `program_id`.

On success the environment moves to `ready` with its `api_url`, `admin_url`,
and an `api_key_fingerprint` — only a masked fingerprint is stored, never the
key itself. On failure the environment is marked `failed` with a
`status_message` describing which check failed, and the request returns
`422` with a matching error code (for example `auth_rejected` or
`program_mismatch`). Requests have a five-second timeout and never follow
redirects. A loopback/private endpoint is available only for local development
when the Cloud process explicitly sets
`LIP_CLOUD_ALLOW_PRIVATE_ATTACH_NETWORKS=true`; never enable that switch in a
networked control plane.

Re-attaching is allowed for `pending`, `ready`, or `failed` environments, so
you can rebind after key rotation or a host migration; a `suspended`
environment rejects attach with `409 environment_suspended`.

## Verifying a staging tenant

Attach binds the host, but binding is not proof the tenant is safe to send
traffic to. After `/attach` returns `ready` with an `api_url`, run the same
diagnostics used to gate a local sandbox against that URL:

```bash
lip cloud-verify <api_url> \
  --api-key <key> \
  --program-id <id> \
  --expect-member <token> \
  --expect-available <n> \
  [--expect-members <N>]
```

`cloud-verify` runs `lip doctor` (discovery, health, authentication, and
capabilities) and baseline conformance against `<api_url>`, then, given
`--program-id`, `--expect-member`, and `--expect-available`, looks up that
member's balance and compares it to the expected value. The optional
`--expect-members <N>` additionally checks the total member count. Record the
printed report as part of the cutover: the command exits non-zero on any
failure, so it can gate promoting a newly attached tenant rather than relying
on `/attach` having returned `200` alone.

Member counts also appear in `lip state import`'s summary output when you
migrate an archive into the target host; `--expect-members` gives you the same
number from a second, independent source by reading it directly off the
running host. That count comes from the host's admin snapshot endpoint, which
is a non-normative operational surface outside the versioned `/lip/v1`
protocol — treat `--expect-members` as an operator convenience for staging
verification, not a protocol guarantee.

## Start locally

Start Postgres and the Cloud API:

```bash
LIP_CLOUD_API_KEY="replace-with-at-least-16-characters" \
docker compose --profile cloud up --build
```

The management API listens on `http://127.0.0.1:3220`. From source:

```bash
LIP_CLOUD_DATABASE_URL="postgres://loyalty:password@localhost:5432/loyalty" \
LIP_CLOUD_API_KEY="replace-with-at-least-16-characters" \
npm run cloud:dev
```

Configuration:

- `LIP_CLOUD_DATABASE_URL` (falls back to `LIP_DATABASE_URL`)
- `LIP_CLOUD_API_KEY` — **deprecated** shared bootstrap key; see
  the authentication boundary below
- `LIP_CLOUD_SHARED_KEY_DISABLED=true` — reject the shared key outright once
  operators exist
- `LIP_CLOUD_OIDC_ISSUER`, `LIP_CLOUD_OIDC_AUDIENCE`, and optional
  `LIP_CLOUD_OIDC_JWKS_URI` for direct JWT validation instead of the shared key
- `LIP_CLOUD_HOST` and `LIP_CLOUD_PORT`
- `LIP_CLOUD_REGIONS`, comma-separated
- `LIP_CLOUD_DEFAULT_PLAN`
- `LIP_CLOUD_ALLOWED_ORIGINS`, comma-separated
- `LIP_CLOUD_ALLOW_PRIVATE_ATTACH_NETWORKS=true`, development-only opt-in for
  attaching loopback/private data planes; disabled by default
- `LIP_CLOUD_CREDENTIAL_KEY`, required 32-byte base64url key when local
  provisioning is enabled
- `LIP_CLOUD_ALLOW_LEGACY_CREDENTIAL_MIGRATION=true`, one-time plaintext v1/v2
  migration switch
- `LIP_CLOUD_BACKUP_DIR`, private local backup directory
- `LIP_CLOUD_STRIPE_SECRET_KEY`, `LIP_CLOUD_STRIPE_WEBHOOK_SECRET`, and
  `LIP_CLOUD_STRIPE_PRICE_PRO` / `LIP_CLOUD_STRIPE_PRICE_BUSINESS`
- `LIP_CLOUD_CUSTOMER_OIDC_ISSUER`, `LIP_CLOUD_CUSTOMER_TENANT_ID`, and
  `LIP_CLOUD_CUSTOMER_PROVIDER_ID` to enable managed customer BFF routes;
  also set `LIP_CLOUD_CUSTOMER_OIDC_AUDIENCE` or the comma-separated
  `LIP_CLOUD_CUSTOMER_AUTHORIZED_PARTIES` so tokens cannot be replayed from an
  unintended client

## Authentication boundary

With the operator credential model, the acting identity on `/cloud/v1` always comes from a
**verified credential** — never from a caller-chosen header.

**Operator API keys (primary).** Every human or service operating the
control plane has an operator record (`platform-admin`, or `org-scoped`
with an explicit organization list) and authenticates with a personal key:

```http
Authorization: Bearer lip_ok_...
```

The resolved operator record supplies the subject; keys are sha256-hashed at
rest, support `expires_at`, and rotate with the same bounded-overlap
semantics as tenant keys (`POST /cloud/v1/operators/{id}/keys/rotate`,
platform-admin only; the replacement inherits and can never extend the
rotated key's expiry). Platform-admins are unrestricted; org-scoped
operators can only touch their organizations' projects and environments.
An `X-LIP-Cloud-Subject` header sent alongside an operator key is recorded
in audit metadata as `on_behalf_of` — it never grants authority.

Bootstrap the first platform-admin with `npm run cloud:operator -- create`
(authenticated by the legacy shared key exactly once), then migrate every
caller to `LIP_CLOUD_OPERATOR_KEY`.

**OIDC bearer mode.** Production can validate OIDC access tokens directly.
Configure `LIP_CLOUD_OIDC_ISSUER` and `LIP_CLOUD_OIDC_AUDIENCE` together;
signature, issuer, audience, expiry, allowed algorithm, and subject are
validated against the provider JWKS. Invitation acceptance only uses the
email claim when `email_verified` is true. When the verified `sub` matches
an **active operator record**, the token carries that operator's
role/scope; other verified subjects act as ordinary invitation-based
organization members.

**Legacy shared key (retired, bootstrap only).** The old trusted-gateway
mode — `Authorization: Bearer <LIP_CLOUD_API_KEY>` plus a caller-chosen
`X-LIP-Cloud-Subject` — no longer grants identity. The shared key now
authenticates exactly one thing: creating the first operator, and only
while zero operators exist. Every other route, and every use once an
operator exists, returns `401 shared_key_retired`. Setting
`LIP_CLOUD_SHARED_KEY_DISABLED=true` additionally closes the bootstrap
route, returning `401 shared_key_disabled`. A single
`cloud_shared_key_deprecated` notice is logged once per boot while the key
is still configured. Do not expose any control-plane key directly to
browsers or mobile applications.

## API

All successful payloads use `{ "data": ... }`; errors use RFC 9457 problem
details.

- `GET /cloud/v1/plans`
- `GET|POST /cloud/v1/operators` (platform-admin; POST also serves the
  one-time shared-key bootstrap)
- `PATCH /cloud/v1/operators/{operator_id}` (activate/deactivate;
  the last active platform-admin cannot be deactivated)
- `POST /cloud/v1/operators/{operator_id}/keys`
- `POST /cloud/v1/operators/{operator_id}/keys/rotate`
- `POST /cloud/v1/operators/{operator_id}/keys/revoke`
- `GET|POST /cloud/v1/organizations`
- `GET /cloud/v1/organizations/{organization_id}`
- `GET|POST /cloud/v1/organizations/{organization_id}/projects`
- `GET|PATCH /cloud/v1/organizations/{organization_id}/members`
- `POST /cloud/v1/organizations/{organization_id}/invitations`
- `POST /cloud/v1/invitations/accept`
- `GET|POST /cloud/v1/projects/{project_id}/environments`
- `POST /cloud/v1/environments/{environment_id}/attach`
- `POST /cloud/v1/environments/{environment_id}/credentials/rotate`
- `POST /cloud/v1/environments/{environment_id}/operations/{suspend|resume|backup|restore}`
- `POST /cloud/v1/environments/{environment_id}/usage-events`
- `GET /cloud/v1/environments/{environment_id}/usage`
- `POST /cloud/v1/organizations/{organization_id}/billing/checkout`
- `POST /cloud/v1/organizations/{organization_id}/billing/cancel`
- `POST /cloud/v1/billing/webhooks/stripe` (Stripe signature, no Cloud bearer)
- `/cloud/v1/customer/{session|profile|consents|identities/link|loyalty/enroll|export|account}`
  (external customer bearer plus fixed tenant/provider headers)

Example:

```bash
curl -X POST http://127.0.0.1:3220/cloud/v1/organizations \
  -H "Authorization: Bearer $LIP_CLOUD_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo Restaurants","slug":"demo-restaurants"}'
```

## Isolation and metering

Every project belongs to one organization, every environment belongs to one
project, and each environment receives a unique `tenant_id`. Repository queries
resolve ownership before writes. Usage writes:

1. lock the environment, metric, and month;
2. verify the environment belongs to the expected organization;
3. deduplicate by environment, metric, and idempotency key;
4. enforce the plan hard limit;
5. insert the immutable event and update its monthly counter atomically.

Charging by monthly active members and transactions is represented directly;
points issued are not a billing metric.

## Next production steps

1. Replace the local provisioner with regional adapters that create durable
   data-plane runtimes (stable hosts, restarts, suspend/delete/upgrade jobs)
   through the existing claim-safe worker.
2. Move credential encryption from the local operator key into managed KMS
   envelope encryption and drill rotation.
3. Aggregate runtime usage into the control plane automatically.
4. Add regional restore/migration drills, durable pending-provider-deletion
   retries, and measured SLO evidence.
