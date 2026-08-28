# Managed sandbox and production release runbook

This is the release authority for the shared LIP sandbox and production clusters. It complements
[`shared-cluster-provisioning.md`](shared-cluster-provisioning.md), which covers tenant onboarding
inside one cluster.

## Fixed topology and safety rules

- `lip-cloud-sandbox` and `lip-cloud-production` are separate Render services.
- Each service has its own disk, bootstrap/operator credentials, encryption key, and independently
  managed Neon project/database/role. Neither environment uses a Crave database.
- Both `LIP_CLOUD_DATABASE_URL` and `LIP_CLOUD_DATA_PLANE_DATABASE_URL` use the environment's direct
  Neon hostname. A `-pooler` hostname or `pgbouncer=true` fails before migrations or startup.
- `numInstances: 1` is a correctness limit, not a sizing preference. Do not scale out until Admin
  state and webhook dispatch no longer depend on one process.
- Migrations run in `preDeployCommand`. The engine and control-plane migrators each serialize with a
  PostgreSQL advisory transaction lock and record applied versions.
- Source rollback never runs a down migration. Restore a Neon branch and repoint both database
  variables when data/schema rollback is required.

## Candidate promotion

1. Record the exact Git commit and immutable image digest from the candidate build.
2. Validate `render.yaml`; confirm exactly two services, `autoDeploy: false`, and
   `numInstances: 1` for both.
3. Deploy sandbox first. The pre-deploy log must contain
   `shared_cluster_migrations_applied`; a pooled URL must stop here with a safe direct-endpoint error.
4. Verify the exact candidate:

   ```bash
   LIP_DEPLOYMENT_URL=https://lip-cloud-sandbox.onrender.com \
   LIP_EXPECTED_ENVIRONMENT=sandbox \
   LIP_EXPECTED_RELEASE=<git-commit> \
   npm run cloud:deployment-verify
   ```

5. Exercise tenant provisioning, enrollment, accrual, refund adjustment, member closure, and
   webhook delivery in sandbox. Confirm the original accrual multiplier is used after membership or
   tier changes.
6. Create a Neon restore branch and complete the restore rehearsal below.
7. Promote the same reviewed commit/image to production. Repeat migration, health, metrics, and
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

For sandbox and production, retain: service ID/hostname, Neon project/branch/role identifiers,
database-directness check, deploy ID, Git commit, image digest, migration log event, `/health`
response, `/metrics` probe, instance count, backup branch/timestamp, restore verification result,
rollback target, and reviewer sign-off. Never record connection strings or credential values.
