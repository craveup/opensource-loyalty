# Diskless managed runtime

The authoritative operating document for the Crave-hosted Loyalty deployments
(`crave-loyalty-development`, `crave-loyalty-sandbox`, `crave-loyalty-production`).

Everything durable lives in that environment's Neon database. There is no Render
disk, no program JSON, no credentials file, and no port registry. A container is
disposable: a cold process reads the control-plane tables, rebuilds every ready
environment's runtime, and serves the same URLs it served before.

## What changed, and why it matters operationally

| Previously | Now |
| --- | --- |
| One TCP port per environment, remembered in `/data/lip-cloud/ports.json` | One listener; `/runtime/v1/environments/<environment_id>` is the address |
| `<program_id>.json` seeded onto the disk before provisioning | A valid, inert bootstrap program created in Postgres at provisioning |
| `<environment_id>.credentials.json` on the disk | Access-control key hashes in tenant rows; a short-lived encrypted handoff in the control plane |
| Per-tenant SQLite database files | Tenant-scoped rows in the shared Neon database, under forced row-level security |
| Encrypted local disk backups | Neon backup / PITR and isolated restore branches |

The practical consequence: **there is nothing to seed and nothing to copy before
a brand can be provisioned.** Onboarding is entirely API-driven.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `LIP_CLOUD_DATABASE_URL` | The environment's **direct** (never `-pooler`) Neon URL. The single required database URL. |
| `LIP_CLOUD_PUBLIC_BASE_URL` | This service's exact public origin. **Selects the managed runtime.** Merchant URLs are built from it. |
| `LIP_CLOUD_CREDENTIAL_KEY` | 32-byte unpadded base64url AES-256-GCM key for credential handoffs. |
| `LIP_CLOUD_DEPLOYMENT_ENVIRONMENT` | `development` \| `sandbox` \| `production`, published on `/health`. |

`LIP_CLOUD_DATA_PLANE_DATABASE_URL` is now optional and defaults to
`LIP_CLOUD_DATABASE_URL`. Set it only for a self-hosted deployment that
genuinely splits the two.

**Retired. Remove them from every managed service:**
`LIP_CLOUD_PROGRAM_DIR`, `LIP_CLOUD_DATA_DIR`, `LIP_CLOUD_BACKUP_DIR`,
`LIP_CLOUD_ALLOW_LEGACY_CREDENTIAL_MIGRATION`, `LIP_CLOUD_DATA_PLANE_HOST`,
`LIP_CLOUD_DATA_PLANE_PUBLIC_HOST`, `LIP_CLOUD_DATA_PLANE_BASE_PORT`.

Setting `LIP_CLOUD_PUBLIC_BASE_URL` and `LIP_CLOUD_PROGRAM_DIR` together is
refused at boot. The ambiguity is not resolved by precedence, because the wrong
resolution writes tenant credentials to a filesystem that does not survive a
redeploy.

## Health and readiness

`GET /health` is liveness plus deployment identity. It publishes
`service`, the deployment environment, `instance_policy: "single"`,
`storage_policy: "postgres_only"`, `shared_database`, `disk_required: false`,
and the non-secret `control_plane_database` / `data_plane_database`
fingerprints (SHA-256 prefixes of `host:port/database` — no role, no password).
Comparing sandbox's and production's fingerprints from outside is how their
independence is proved; neither process can see the other's URL.

`GET /ready` is the deploy gate, and reports its four claims separately so a
stuck deploy names its own cause:

```json
{
  "ready": true,
  "migrations_applied": true,
  "database_reachable": true,
  "provisioning_worker_running": true,
  "expected_runtimes": 4,
  "restored_runtimes": 4
}
```

It answers 503 until every claim holds. `healthCheckPath` is `/ready` precisely
so Render does not cut traffic over to a process that is up but serving nothing.

## Migrations

Both schemas migrate at startup under Postgres advisory locks, so concurrent
runs serialize rather than race. `preDeployCommand` repeats them as defence in
depth on paid plans. **The service does not depend on it** — Render Free has no
pre-deploy step, which is what lets development run there.

## Provisioning a brand

1. `POST /cloud/v1/organizations`, then `.../projects`, then `.../environments`.
2. The provisioning worker claims the job and creates the environment's runtime
   state, including a bootstrap program: USD, zero earn rate, no rewards, tiers,
   plans, members or seeded activity. It is valid so the engine boots, and inert
   so nothing can accrue or redeem before the merchant publishes a real program
   through the Admin API.
3. The environment becomes `ready` with
   `api_url = admin_url = <public base>/runtime/v1/environments/<environment_id>`.
4. `POST /cloud/v1/environments/<id>/credentials/rotate` with an
   **`Idempotency-Key` header** returns the merchant credential.

Nothing is written to a filesystem at any step.

## Credential issuance

The merchant secret is returned once and stored nowhere it can be read back, so
issuance carries an idempotency contract:

- Same key, same request → the identical credential, replayed from an encrypted
  handoff, for 24 hours. No second key is minted.
- Same key, different request → `409 idempotency_conflict`.
- Same key after 24 hours → `410 credential_handoff_expired`. Issue a new one.
- A crash between minting and persisting → the next attempt revokes the orphaned
  key before minting its replacement, with zero overlap. If the revocation
  fails, the operation aborts rather than leaving two live owner keys.

Pass a caller-owned durable identifier (a provisioning attempt id, a mutation
id) as the key. A random per-click key is honest but gives up the replay.

Root authority never leaves the process: the runtime's root key is generated per
boot, never persisted, never logged, never returned.

## Tenant isolation

`lip_engine_*` and `lip_platform_state` carry forced row-level security keyed on
a transaction-local `lip.tenant_id`. `FORCE` matters: the service connects as
the table owner, which would otherwise bypass every policy. A query that never
declares a tenant compares against NULL and sees an empty database.

Two environments with the *same* `program_id` are still separated, because the
boundary is the tenant, not the program. A credential minted for environment A
answers 401/403 against environment B.

## Backup and restore

Neon is the backup authority. Use branch restore or point-in-time restore
against an **isolated restore branch**; never restore in place over a live
environment. The `backup` and `restore` control-plane operations are refused for
a managed deployment — this process cannot honestly perform a file copy of a
database it does not own.

Preserve `LIP_CLOUD_CREDENTIAL_KEY` across any restore. Credential handoffs
encrypted under a retired key decrypt to `410 credential_handoff_expired`, which
is correct but means those credentials must be reissued.

## Scaling

`numInstances: 1` is a correctness constraint. The campaign, membership and
engagement schedulers, webhook dispatch, and the credential single-flight all
assume one process. The single-flight is also what makes crash recovery sound:
a `pending` credential operation observed by a fresh call can only be a dead
process's residue *because* no concurrent caller in this process reaches the
store. Distributed leasing has to land before the instance count moves.

## Development certification checklist

1. Deploy only `crave-loyalty-development`. No disk.
2. Remove the retired variables; set `LIP_CLOUD_PUBLIC_BASE_URL` to the exact
   service origin and keep the development direct Neon URL.
3. Provision two test organizations; confirm each credential is refused against
   the other's environment.
4. Publish a real program, enroll a customer, accrue, reserve and capture a
   reward, rotate credentials, deliver a signed webhook.
5. Restart and redeploy; confirm URLs, programs, credentials, members, balances
   and webhook state all survive.
6. Exercise a Neon branch restore and record the evidence.
7. Confirm `/health` and `/ready`.
8. Return the development service to Free.

Sandbox and production stay undeployed until a separate promotion decision.
Before external sandbox access or production activation, move the service to a
paid plan and complete load, alerting, restore and rollback certification.
