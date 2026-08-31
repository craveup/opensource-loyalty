# Shared LIP cluster: tenant provisioning runbook

> Managed development/sandbox/production release, restore rehearsal, and rollback authority lives in
> [`managed-environment-release.md`](managed-environment-release.md). This runbook describes tenant
> provisioning inside any independently deployed cluster.

This runbook stands up ONE regional Postgres-backed LIP cluster that serves
every brand, and onboards brands onto it. A brand is a `tenant_id` — a row
scope inside the shared database — never a per-brand deployment.

## Architecture at a glance

- **Deployable unit:** the `apps/cloud` host (`node apps/cloud/dist/cli.js`).
  It is the only multi-tenant runner in the repo: the control plane owns
  organizations → projects → environments (each environment gets a generated
  `tenant_id` and a `program_id`), a claim-safe worker processes provisioning
  jobs, and `LocalDataPlaneProvisioner` boots one row-scoped LIP runtime per
  tenant inside the same process. The single-tenant reference server
  (`packages/server/src/cli.ts`) cannot serve multiple brands from one
  process, so it is not the unit here.
- **One database per environment.** Inside one cluster, control-plane tables (`lip_cloud_*`) and
  tenant engine rows (`lip_engine_*`, keyed by `tenant_id` + `program_id`) share that environment's
  Neon database. Development, sandbox, and production never share a Neon project/database/role, and
  none uses a Crave platform database.
- **One service instance — a hard constraint.** `docs/postgres.md`: run at
  most one platform instance per tenant until multi-instance coordination lands (Admin
  extension stores cache per-process revisions; webhook journals assume a
  single dispatcher). `render.yaml` pins `numInstances: 1` and the attached
  disk prevents scale-out. Do not raise the instance count.
- **Auth model.** Two kinds of keys are in play:
  - Per-operator **control-plane keys** (`lip_ok_...`) — every human or
    service gets its own operator record (`platform-admin`, or `org-scoped`
    to specific organizations) and key (hashed at rest, expiring,
    rotatable). The acting identity is the verified operator; the
    `X-LIP-Cloud-Subject` header is only an on-behalf-of audit annotation.
    The legacy shared `LIP_CLOUD_API_KEY` survives solely to bootstrap the
    first operator and is then disabled — see the cutover steps in
    section 4½.
  - Per-environment **merchant keys** (`lip_sk_...`) — owner-role,
    tenant-scoped access-control keys bootstrapped at provision time
    (audited, only valid on their own tenant's runtime; the runtime stores
    only a hash, but the control-plane host keeps a **plaintext copy in the
    environment's credentials file** — see the constraints table).
    Retrieved and rotated through the control plane (step 4c); the replaced
    key stays valid for a bounded overlap window (default 24 h) so BFFs swap
    without downtime. Each runtime also holds a root key in its credentials
    file — deprecated, never handed out, kept only for backward
    compatibility with pre-v2 consumers.

## 1. Create the environment's independent Neon Postgres

1. Create the matching PostgreSQL 18 Neon project in AWS US West 2 (Oregon):
   `crave-loyalty-development`, `crave-loyalty-sandbox`, or `crave-loyalty-production`. Create
   database `loyalty` and an environment-specific role. Never reuse another LIP environment or any
   Crave platform project/database/role.
2. Copy the **direct (unpooled)** connection string. Do not use the
   `-pooler` endpoint: the engine manages its own `pg` pool and uses
   advisory locks (`withLease` takes session-scoped locks that break under transaction pooling).
   Startup and migrations reject pooled endpoints before connecting.
3. Project → **Settings → Compute**: disable autosuspend (scale-to-zero) for sandbox and production;
   cold starts would stall externally exercised checkout-path loyalty calls. Development may retain
   autosuspend until continuous internal testing requires otherwise.
4. Project → **Settings → Storage**: set history retention to at least 7
   days — this is your point-in-time-recovery window.
5. Set both database variables on only the matching Render service. Keep connection strings in
   Render secrets; release evidence records project/branch/role identifiers, never values.

## 2. Deploy the service from the blueprint

1. Render dashboard → **New → Blueprint** → select this repo and exact reviewed branch/commit. Set
   **Blueprint Auto Sync to No** before linking or applying it; `autoDeploy: false` controls service
   deploys but does not disable Blueprint Auto Sync. The blueprint creates
   `crave-loyalty-development`, `crave-loyalty-sandbox`, and `crave-loyalty-production` in Oregon,
   all intentionally manual.
2. Fill every required `sync: false` value independently on each service when prompted:
   - `LIP_CLOUD_DATABASE_URL` and `LIP_CLOUD_DATA_PLANE_DATABASE_URL`: use the same direct,
     unpooled URL from that service's matching Neon project. Never reuse a URL across environments.
   - `LIP_CLOUD_API_KEY`: at least 16 random characters (for example,
     `openssl rand -base64 24`). This is only the **bootstrap** credential; after section 4½ it is
     disabled and can be deleted. Store it in the team password manager until then.
   - `LIP_CLOUD_CREDENTIAL_KEY`: an independent 32-byte unpadded base64url key for AES-256-GCM
     (for example, `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`). Never reuse this key.
   - `LIP_CLOUD_ALLOWED_ORIGINS`: the exact Business Manager origin(s) for that environment, with no
     wildcard (for example, `https://dashboard.craveup.com`).
   - `LIP_CLOUD_SHARED_KEY_DISABLED`: set `false` only for the first-operator bootstrap in section
     4½, then change it permanently to `true` and redeploy.
3. Leave optional groups completely unset unless that capability is enabled and fully configured:
   - operator OIDC: `LIP_CLOUD_OIDC_ISSUER`, `LIP_CLOUD_OIDC_AUDIENCE`,
     `LIP_CLOUD_OIDC_JWKS_URI`, and `LIP_CLOUD_BOOTSTRAP_SUBJECTS`;
   - Stripe billing: `LIP_CLOUD_STRIPE_SECRET_KEY`, `LIP_CLOUD_STRIPE_WEBHOOK_SECRET`,
     `LIP_CLOUD_STRIPE_PRICE_PRO`, and `LIP_CLOUD_STRIPE_PRICE_BUSINESS`;
   - customer OIDC: `LIP_CLOUD_CUSTOMER_OIDC_ISSUER`, `LIP_CLOUD_CUSTOMER_OIDC_AUDIENCE`,
     `LIP_CLOUD_CUSTOMER_AUTHORIZED_PARTIES`, `LIP_CLOUD_CUSTOMER_TENANT_ID`, and
     `LIP_CLOUD_CUSTOMER_PROVIDER_ID`.

   Do not partially populate a group. If a capability is enabled, satisfy the whole group's startup
   contract before applying the Blueprint.
4. Apply. The deploy runs `preDeployCommand: node apps/cloud/dist/migrate-cli.js`
   before going live; confirm the deploy log contains
   `{"event":"shared_cluster_migrations_applied","shared_database":true,...}`.
   The command is advisory-locked and idempotent — reruns are no-ops.
5. Verify health:

   ```bash
   curl -s https://<service>.onrender.com/health
   # includes status, service, instance_policy, environment, and exact release

   LIP_DEPLOYMENT_URL=https://<service>.onrender.com \
   LIP_EXPECTED_ENVIRONMENT=<development-or-sandbox-or-production> \
   LIP_EXPECTED_RELEASE=<git-commit> npm run cloud:deployment-verify
   ```

## 3. Seed program definitions

Provisioning a tenant fails unless `<program_id>.json` exists in
`LIP_CLOUD_PROGRAM_DIR` (`/data/programs`). Per brand, author the program
JSON (see `deploy/acme-sandbox/acme-program.json` for a template) and place
it on the disk:

```bash
render ssh <crave-loyalty-environment-service-id>
mkdir -p /data/programs
cat > /data/programs/demo-rewards.json <<'EOF'
{ "program_id": "demo-rewards", ... }
EOF
```

The file's `program_id` must equal its filename stem, or provisioning
rejects it.

## 4. Onboard a brand (tenant + program + API key)

Trigger: a Business Manager org toggles loyalty on. The craveup-turborepo
control-plane worker (or an operator) then runs ONE of the following against
the deployed control plane. Both paths use only the existing `/cloud/v1`
surface.

### 4a. One command (wraps the API)

```bash
LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:provision -- \
  --cloud-url https://<service>.onrender.com \
  --org-slug demo-restaurants --org-name "Demo Restaurants" \
  --project-slug loyalty --project-name "Loyalty" \
  --env-slug production --env-name "Production" \
  --kind production --region render-oregon \
  --program-id demo-rewards
```

(Identity comes from the operator key; add
`--subject org_<business_manager_org_id>` only as an optional on-behalf-of
audit annotation. The legacy `LIP_CLOUD_API_KEY` is rejected by this command
— it only authenticates the first-operator bootstrap route, so create an
operator first with `npm run cloud:operator`.)

Prints `{"event":"tenant_provisioned", "tenant_id":"tenant_...", "status":"ready",
"api_url":"http://<environment-service>:13210...", ...}` and exits non-zero on
failure or timeout. Re-running with the same slugs is idempotent (reuses the
org/project/environment); reusing an environment slug with a different
`--program-id` is rejected. `--region` must be listed in the service's
`LIP_CLOUD_REGIONS`.

### 4b. Raw API calls (what the command does)

```bash
H=(-H "Authorization: Bearer $LIP_CLOUD_OPERATOR_KEY" \
   -H "Content-Type: application/json")
BASE=https://<service>.onrender.com

curl "${H[@]}" -X POST $BASE/cloud/v1/organizations \
  -d '{"name":"Demo Restaurants","slug":"demo-restaurants"}'
curl "${H[@]}" -X POST $BASE/cloud/v1/organizations/<organization_id>/projects \
  -d '{"name":"Loyalty","slug":"loyalty"}'
curl "${H[@]}" -X POST $BASE/cloud/v1/projects/<project_id>/environments \
  -d '{"name":"Production","slug":"production","kind":"production",
       "region":"render-oregon","program_id":"demo-rewards"}'
# poll until status == "ready" (worker polls every 5s):
curl "${H[@]}" $BASE/cloud/v1/projects/<project_id>/environments
```

The environment response carries the generated `tenant_id` and, once ready,
`api_url`/`admin_url` on the private-network host
(`<environment-service>:<port>`).

### 4c. Retrieve or rotate the merchant API key (via the control plane)

Rotation doubles as retrieval — mint the credential the moment you need it
instead of reading files off the disk:

```bash
LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:provision -- rotate-credentials \
  --cloud-url https://<service>.onrender.com \
  --environment <environment_id>
# {"event":"tenant_credentials_rotated","merchant_api_key":"lip_sk_...",
#  "replaced_api_key_expires_at":"...", ...}
```

(Equivalent raw call: `POST $BASE/cloud/v1/environments/<environment_id>/credentials/rotate`
with the same auth headers as 4b; optional JSON body
`{"overlap_seconds": <0..604800>}`. Requires a platform-admin operator, an
org-scoped operator covering that org, or an org owner/admin; audited
cloud-side as `cloud.environment.credentials_rotated` (metadata carries the
verified `operator_id`) and tenant-side as actor `cloud:<verified subject>`.)

Copy `merchant_api_key` into the consuming BFF's secrets (`LIP_URL` +
`LIP_API_KEY` on the Express API's Render service) and into the password
manager. **Every run expires the previously issued merchant key** after the
overlap window (default 24 h; the response's `replaced_api_key_expires_at`
tells you exactly when) — so treat re-runs as real rotations, not free
retrievals, and swap the BFF before the window closes. For an emergency
cutover (leaked key), pass `--overlap-seconds 0` (or `{"overlap_seconds": 0}`
on the raw call): the replaced key dies immediately. Never hand out the root
`api_key` from the credentials file — it is deprecated and no API returns it.

Tenants can also self-serve rotation of any key they created on their own
runtime: `POST /admin/api/v1/access/api-keys/rotate` with
`{"key_id": "key_...", "overlap_seconds": 86400}` (0 = immediate cutover),
and revoke early via `POST /admin/api/v1/access/api-keys/revoke`. The
replacement inherits the rotated key's expiry (an explicit `expires_at` may
shorten it, never extend it), so time-boxed keys stay time-boxed across
rotations. If a tenant self-rotates the merchant key, the next control-plane
`rotate-credentials` run recovers automatically by rotating the live
`cloud-merchant` lineage (or minting a fresh one if none is left).

### 4d. Create the tenant's first webhook subscription

Tenant runtimes start with **zero** webhook subscriptions — without this step
nothing is ever delivered. Two ways to wire the first one:

- **At provision time** — add webhook flags to the 4a command (also works on
  an idempotent re-run against an already-ready environment):

  ```bash
  LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:provision -- \
    ... same flags as 4a ... \
    --webhook-url https://bff.example.com/hooks/loyalty \
    --webhook-secret <at least 16 random characters>
  ```

  This mints the merchant key via 4c and upserts a subscription with the
  stable id `webhook_onboarding` through the runtime's admin API, so re-runs
  update rather than duplicate. The output's `credentials.merchant_api_key`
  is the credential for the BFF — store it as in 4c. Note the minting side
  effect: any previously issued merchant key enters its overlap window. Run
  it from a machine that can reach the tenant runtime (private network, like
  4e).

- **Manually via the runtime admin API** (with the merchant key from 4c):

  ```bash
  curl -X PUT http://<environment-service>:<port>/admin/api/v1/webhooks/subscription \
    -H "Authorization: Bearer $LIP_API_KEY" -H "Content-Type: application/json" \
    -d '{"url":"https://bff.example.com/hooks/loyalty","secret":"<>=16 chars>"}'
  ```

Confirm with `GET /admin/api/v1/webhooks/health` (`subscription_count` >= 1).

### 4e. Verify before routing traffic

```bash
npm run lip -- doctor http://<environment-service>:<port> --api-key "$LIP_API_KEY"
npm run lip -- cloud-verify http://<environment-service>:<port> \
  --api-key "$LIP_API_KEY" --program-id demo-rewards
```

(Run from a machine on the private network, e.g. a Render job or the BFF
host; the tenant ports are not public.)

### 4f. Migrating an existing brand's state in

Follow `MIGRATION.md` end to end. The Postgres import target uses the
provisioned tenant:

```bash
LIP_DATABASE_URL='<shared postgres url>' LIP_TENANT_ID='<tenant_id>' \
npm run lip -- state import --program ./demo-rewards.json --input ./archive.json
```

## 4½. Operator cutover: retire the shared control-plane key

Run once per cluster, right after the first deploy (and on existing
clusters as a migration):

1. **Bootstrap the first platform-admin** with the shared key — the only
   thing that key is still for:

   ```bash
   LIP_CLOUD_API_KEY=<shared key> npm run cloud:operator -- create \
     --cloud-url https://<service>.onrender.com \
     --subject alvin@craveup.com --email alvin@craveup.com \
     --role platform-admin
   ```

   The printed `secret` (`lip_ok_...`) is shown exactly once — store it in
   the password manager. A second bootstrap attempt with the shared key
   returns `403 operator_bootstrap_exhausted`.
2. **Create one operator per human/service** with the platform-admin key.
   Give automation the narrowest scope that works, e.g. the
   Business-Manager provisioning worker:

   ```bash
   LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:operator -- create \
     --cloud-url ... --subject bm-provisioner \
     --role org-scoped --org-ids org_...,org_...
   ```

3. **Swap every caller** from `LIP_CLOUD_API_KEY` to its own
   `LIP_CLOUD_OPERATOR_KEY` (BFF workers, CI, runbook shells). Do this
   before step 1 lands if you can: the moment the first operator exists,
   the shared key stops working on every route but the bootstrap one, so
   a straggler fails immediately rather than degrading. Stragglers show up
   as `401 shared_key_retired` responses in the caller's own logs — the
   control plane no longer emits a per-request `cloud_shared_key_used`
   line, because the key can no longer reach a data route at all. The
   remaining deprecation signal is the once-per-boot
   `cloud_shared_key_deprecated` notice.
4. **Disable the shared key:** set `LIP_CLOUD_SHARED_KEY_DISABLED=true` on
   the Render service and redeploy. This closes the bootstrap route too —
   the only thing the key could still do — so the response changes from
   `401 shared_key_retired` to `401 shared_key_disabled` and the boot
   notice stops. Delete the shared key from the password manager and the
   Render env when convenient.
5. **Operate:** rotate operator keys like tenant keys
   (`POST /cloud/v1/operators/{id}/keys/rotate`, default 24 h overlap,
   `overlap_seconds: 0` for emergency cutover; rotation can shorten but
   never extend an expiry), revoke with `.../keys/revoke`, and offboard by
   `PATCH /cloud/v1/operators/{id}` `{"active": false}` — the last active
   platform-admin cannot be deactivated, so the cluster can never strand
   itself. All lifecycle events land in `lip_cloud_operator_audit`.

## 5. Backups and point-in-time recovery

- **Neon:** restore = create a branch at a timestamp (**Restore** tab or
  `neon branches create --parent-timestamp ...`) inside the history-retention
  window. While writes remain frozen, run `npm run cloud:restore-verify` with
  the direct source and restored-branch URLs. Repoint both service database
  variables only after schema versions, row counts, and content fingerprints match.
- **The service disk is state too.** `/data` holds program JSONs and the
  per-environment credentials files. Render disks take daily snapshots;
  restore from the disk's **Snapshots** tab. Additionally keep programs in
  git and merchant keys in the password manager.
- **Lost or corrupted credentials file — the real recovery path:**
  1. If the runtime is still running (file lost while the service stayed
     up), `rotate-credentials` (4c) recovers on its own: the control plane
     rotates the tenant's live `cloud-merchant` lineage (or mints a fresh
     owner key if none survives) and rewrites the file.
  2. If the service restarted without the file, `restore()` skips that
     environment (there is nothing to restore from) — the runtime is down,
     not just the credential. Re-run provisioning for the same slugs (4a is
     idempotent); the provisioner reuses the persisted port and tenant
     database, re-adopts the existing merchant lineage from the tenant's
     access state instead of minting a parallel key, and writes a fresh
     credentials file. Then run `rotate-credentials` (4c) to hand the new
     merchant key to the BFF.
  3. If the data plane itself is unrecoverable, fall back to the
     re-provision (4a) or external-host attach path
     (`POST /cloud/v1/environments/{id}/attach`, `docs/cloud.md`) and
     migrate state per 4f.
  A weak, tampered, or unreadable credentials file no longer aborts startup
  for the other tenants: `restore()` logs
  `cloud_environment_restore_failed` for that environment and continues.
- **Restore drill:** after any restore, run step 4e verification plus a
  known-member balance spot check (`cloud-verify --expect-member ...`)
  before unfreezing.

### Write-freeze cutover guard

The data-plane write freeze (shipped per `MIGRATION.md` / issue #6 — env
`LIP_WRITE_FREEZE`, the flag this platform provides for what the cutover
checklist calls the loyalty write freeze) refuses every `/lip/v1` write with
a stable `503 {"code":"write_frozen"}` + `Retry-After` while reads and
`/health` stay up:

- **Per-tenant, at runtime (the path that works on the shared cluster):**

  ```bash
  curl -X POST http://<environment-service>:<port>/admin/api/v1/maintenance \
    -H "Authorization: Bearer $LIP_API_KEY" -H "Content-Type: application/json" \
    -d '{"write_frozen": true}'   # false to unfreeze
  ```

- **At startup** (`LIP_WRITE_FREEZE=true` / `lip serve --write-freeze`) —
  applies to standalone hosts; the in-process tenant runtimes do not read it,
  so on the shared cluster use the runtime toggle per tenant.
- The flag is in-memory: a service restart unfreezes. Re-check
  `GET /health` (`write_frozen` field) after any deploy during a cutover.

## 6. Observability

Monitor per layer:

| Signal | Where | Alert on |
| --- | --- | --- |
| Control-plane liveness | `GET /health` on the public URL (Render health check uses it) | non-200; Render "server failed health check" notification |
| Tenant runtime liveness + freeze state | `GET http://<environment-service>:<port>/health` per tenant (reports `status`, `write_frozen`) | non-200, or `write_frozen: true` outside a planned window |
| Webhook delivery health | `GET /admin/api/v1/webhooks/health` per tenant (merchant key; returns delivery counts, `success_rate`, `healthy`) | `healthy: false` or falling `success_rate` |
| Request metrics | `GET /metrics` per tenant runtime (authenticated, Prometheus text) | error-rate/latency regressions |
| Provisioning | service logs: `cloud_environment_provisioned` / `cloud_environment_restored` / `cloud_environment_restore_failed` events; environments stuck `pending`/`failed` in `/cloud/v1/projects/{id}/environments` | any `cloud_environment_restore_failed` (that tenant is down until fixed); job `attempts >= 5` (worker gives up) |
| Database | Render/Neon dashboard: storage, connections, CPU | > 80% storage, connection saturation |

Render dashboard → service → **Settings → Notifications**: enable deploy
failure + health-check alerts to the engineering Slack. Stream logs (Render
**Log Streams**) to the team's sink for retention.

## 7. Constraints and follow-ups

| Constraint | Tracking |
| --- | --- |
| One platform instance per tenant → `numInstances: 1`, no horizontal scaling of the shared host | multi-instance coordination |
| **Per-operator control-plane auth (shipped):** management calls authenticate as individual operators (`lip_ok_` keys or OIDC subjects mapped to operator records); the subject header no longer grants identity. The shared `LIP_CLOUD_API_KEY` is bootstrap-only and is retired the moment the first operator exists — every other route returns `401 shared_key_retired`, with or without the `LIP_CLOUD_SHARED_KEY_DISABLED=true` flag (the flag additionally refuses the bootstrap route itself). Run the section 4½ cutover to set it | done; residual action = section 4½ cutover per cluster |
| Tenant runtimes are private-network only (one public port per Render service) | follow-up: per-tenant public hostnames or gateway routing |
| Credentials files retain tenant access material on the environment disk | encrypted v3 files (`0600`, atomic writes); preserve the environment encryption key through restore and rotation |

## Owner actions checklist (dashboard-only steps)

1. Render: **New → Blueprint** on this repo/branch; approve the plan.
2. Render: set `LIP_CLOUD_API_KEY` (bootstrap-only) and
   `LIP_CLOUD_ALLOWED_ORIGINS` when prompted; save the key to the password
   manager until the section 4½ cutover retires it.
2½. Run the section 4½ operator cutover: bootstrap the platform-admin
   operator, create per-human/service operators, swap callers to
   `LIP_CLOUD_OPERATOR_KEY`, then set `LIP_CLOUD_SHARED_KEY_DISABLED=true`.
3. Create independent development, sandbox, and production Neon projects/roles in AWS US West 2
   (Oregon), disable sandbox/production autosuspend, set history retention, and paste each direct
   URL only into its matching service.
4. Render: enable failure/health notifications; optionally add a log stream.
5. Seed `/data/programs/<program_id>.json` via `render ssh` per brand.
6. Per onboarded brand: run `rotate-credentials` (step 4c) to mint the
   merchant key, set `LIP_URL` + `LIP_API_KEY` on the BFF service, store the
   key in the password manager.
7. Per onboarded brand: create the first webhook subscription (step 4d) —
   without it the tenant delivers no webhooks.
8. Follow `managed-environment-release.md` to record exact deploy, migration, health/metrics,
   backup/restore, and rollback evidence for all three environments.
