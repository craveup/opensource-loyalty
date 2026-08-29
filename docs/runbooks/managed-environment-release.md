# Managed development, sandbox, and production release runbook

This is the release authority for the shared Crave Loyalty development, sandbox, and production
clusters. It complements
[`shared-cluster-provisioning.md`](shared-cluster-provisioning.md), which covers tenant onboarding
inside one cluster.

## Current activation status

The managed-service code and configuration can merge independently of provider activation. A merge
does not approve any environment for traffic, and `render.yaml` keeps automatic deploys disabled.
As of 2026-08-28, activation remains blocked until release evidence records all of the following:

- Render has the required GitHub repository access and the operator has completed the provider
  authorization flow.
- The production Neon role password has been rotated, with the new value stored only in the
  approved secret manager and Render.
- All three environments have their own direct Neon URLs and independently generated API and encryption
  keys in Render. Credential values must never be copied into this repository or release evidence.
- `crave-loyalty-development`, `crave-loyalty-sandbox`, and `crave-loyalty-production` exist on paid
  Starter plans in Virginia with one independent 1 GB disk each.
- Development verification passes before sandbox receives a candidate. Sandbox deployment, restore
  rehearsal, rollback rehearsal, and the required lifecycle smoke tests below pass before production
  promotion.

The settlement bridge remains a separate Crave integration dependency; managed-cluster activation
does not by itself prove end-to-end order settlement.

## Fixed topology and safety rules

- `crave-loyalty-development`, `crave-loyalty-sandbox`, and `crave-loyalty-production` are separate
  Render services in Virginia.
- Each service has its own disk, bootstrap/operator credentials, encryption key, and independently
  managed Neon project/database/role. No environment uses a Crave platform database.
- Both `LIP_CLOUD_DATABASE_URL` and `LIP_CLOUD_DATA_PLANE_DATABASE_URL` use the environment's direct
  Neon hostname. A `-pooler` hostname or `pgbouncer=true` fails before migrations or startup.
- `numInstances: 1` is a correctness limit, not a sizing preference. Do not scale out until Admin
  state and webhook dispatch no longer depend on one process.
- `LIP_CLOUD_SHARED_KEY_DISABLED` is operator-managed (`sync: false`) so a Blueprint sync cannot
  reopen the deprecated shared-key bootstrap. Set it to `false` only while creating the first
  platform administrator, then set it permanently to `true` and redeploy as described in
  `shared-cluster-provisioning.md`.
- Migrations run in `preDeployCommand`. The engine and control-plane migrators each serialize with a
  PostgreSQL advisory transaction lock and record applied versions.
- Source rollback never runs a down migration. Restore a Neon branch and repoint both database
  variables when data/schema rollback is required.

## Candidate promotion

1. Record the exact Git commit and immutable image digest from the candidate build.
2. Validate `render.yaml`; confirm exactly three services, `autoDeploy: false`, `region: virginia`,
   and `numInstances: 1` for all three.
3. Deploy development first. The pre-deploy log must contain
   `shared_cluster_migrations_applied`; a pooled URL must stop here with a safe direct-endpoint error.
4. Verify development with `LIP_EXPECTED_ENVIRONMENT=development`, then exercise provisioning,
   enrollment, accrual, refund adjustment, member closure, and webhook delivery against synthetic
   data. Record its independent database fingerprint and restore rehearsal.
5. Deploy the exact development-verified commit/image to sandbox. The pre-deploy log must contain
   `shared_cluster_migrations_applied`; a pooled URL must stop here with a safe direct-endpoint error.
6. Verify the exact candidate:

   ```bash
   LIP_DEPLOYMENT_URL=https://crave-loyalty-sandbox.onrender.com \
   LIP_EXPECTED_ENVIRONMENT=sandbox \
   LIP_EXPECTED_RELEASE=<git-commit> \
   LIP_CLOUD_OPERATOR_KEY=lip_ok_... \
   npm run cloud:deployment-verify
   ```

   Metrics are operator-only, so the key is required. The command also proves an
   anonymous scrape is refused, and prints `control_plane_database`,
   `data_plane_database` and both metrics statuses for the evidence record.

7. Exercise tenant provisioning, enrollment, accrual, refund adjustment, member closure, and
   webhook delivery in sandbox. Confirm the original accrual multiplier is used after membership or
   tier changes.
8. Create a Neon restore branch and complete the restore rehearsal below.
9. Promote the same reviewed commit/image to production. Repeat migration, health, metrics, and
   restore checks with `LIP_EXPECTED_ENVIRONMENT=production` before routing Crave traffic.

## Health and metrics

- `GET /health` must report `status=ok`, `service=lip-cloud-control-plane`,
  `instance_policy=single`, the expected environment, and the exact Render Git commit.
- `GET /metrics` exposes Prometheus text for completed HTTP requests, process uptime, and resident
  memory. Alert on non-200 health, restart loops, sustained 5xx, and memory approaching the service
  limit.
- Tenant runtimes still require their own `/health`, `/metrics`, and webhook-health checks on the
  private network.

## Backup and restore rehearsal

Neon history retention/PITR is the database backup authority. The encrypted service disk backup is
separate and covers program definitions and local environment credential material.

1. Freeze writes on every tenant runtime and record the freeze timestamp, source database branch,
   current Render deploy ID, Git commit, and image digest.
2. Create a Neon branch at that timestamp. Use its direct endpoint and a restore-only role.
3. While source writes remain frozen, compare schema versions and deterministic fingerprints for
   control-plane, ledger, balance, idempotency, accrual, adjustment, member, and state relations:

   ```bash
   LIP_BACKUP_SOURCE_DATABASE_URL='<direct frozen source URL>' \
   LIP_BACKUP_RESTORE_DATABASE_URL='<direct restored branch URL>' \
   npm run cloud:restore-verify
   ```

4. Point a non-production verification service at the restored branch, run
   `cloud:deployment-verify`, and verify one known member balance/order lifecycle through the public
   protocol.
5. Record the source/restore branch IDs, restore timestamp, command result, row counts/checksums, and
   operator. Delete the rehearsal branch only after review. Unfreeze the source last.

The rehearsal fails closed on missing schemas, a pooled endpoint, a reused source URL, row-count
drift, or content-checksum drift.

## Rollback

### Application-only rollback

1. Freeze tenant writes.
2. Select the last reviewed Render deploy whose commit/image is recorded in release evidence.
3. Redeploy that exact artifact; do not rebuild a mutable branch.
4. Run `cloud:deployment-verify` with the rollback commit in `LIP_EXPECTED_RELEASE`.
5. Run a known-member balance and idempotent order replay before unfreezing.

### Data/schema rollback

1. Keep writes frozen and create/retain a Neon branch at the chosen pre-change timestamp.
2. Run `cloud:restore-verify` against the frozen source snapshot or the recorded backup evidence.
3. Repoint both database variables to the restored branch's direct endpoint and redeploy the last
   compatible application artifact.
4. Repeat migration (forward/idempotent only), health, metrics, tenant smoke, and reconciliation.
5. Preserve the old branch until finance/loyalty reconciliation and incident review are complete.

## Required release evidence

Record it in a file shaped by
[`docs/releases/managed-environment-evidence.schema.json`](../releases/managed-environment-evidence.schema.json)
and validate it before activation:

```
npm run cloud:evidence:check -- path/to/evidence.json
```

For development, sandbox, and production, retain: service ID/hostname, Neon project/branch identifiers,
database-directness check, deploy ID, Git commit, image digest, migration log event, `/health`
response, `/metrics` probe, instance count, backup branch/timestamp, restore verification result,
rollback target, and reviewer sign-off. Never record connection strings or credential values — the
checker refuses a record that contains anything matching a credential.

The evidence file itself is operator-supplied and is not committed. Only the schema, the checker and
a secret-free example live in this repository, so the record can be validated without the repository
ever holding an environment's secrets.

Two properties the checker enforces beyond shape:

- **Development, sandbox, and production must report different `databaseFingerprint` values.** Each deployment
  publishes `control_plane_database` on `GET /health`, a SHA-256 prefix of `host:port/database` that
  contains no role or password. No process can see another environment's URL, so comparing all three
  published identities is the only way to prove the deployments are independent.
- **An anonymous `/metrics` scrape must have been refused (401).** The series name tenants and
  environments, and the control plane is on a public URL.
