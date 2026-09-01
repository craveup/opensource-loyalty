# Managed development, sandbox, and production release runbook

This is the release authority for the shared Crave Loyalty development, sandbox, and production
clusters. It complements
[`shared-cluster-provisioning.md`](shared-cluster-provisioning.md), which covers tenant onboarding
inside one cluster.

## Current activation status

The managed-service code and configuration can merge independently of provider activation. A merge
does not approve any environment for traffic, and `render.yaml` keeps automatic deploys disabled.
As of 2026-09-01, all three services are deployed and healthy, and development has passed its
database migration, Postgres 18 tenant isolation, restart, health/readiness, authenticated metrics,
and frozen-source Neon restore checks. Deployment is not activation: development still requires a
fresh exact-head certification after each candidate, and sandbox/production remain blocked from
external traffic until the evidence below is complete. The signed-webhook delivery drill still
requires an approved synthetic external test event.

- Render has the required GitHub repository access and the operator has completed the provider
  authorization flow.
- The production Neon role password has been rotated, with the new value stored only in the
  approved secret manager and Render.
- All three environments have their own direct Neon URLs and independently generated API and encryption
  keys in Render. Credential values must never be copied into this repository or release evidence.
- `crave-loyalty-development`, `crave-loyalty-sandbox`, and `crave-loyalty-production` exist as
  diskless Oregon services. Development stays on Starter while certification runs and may move to
  Free only after it passes; sandbox and production require a paid plan before activation.
- Development verification passes before sandbox receives a candidate. Sandbox deployment, restore
  rehearsal, rollback rehearsal, and the required lifecycle smoke tests below pass before production
  promotion.

The settlement bridge remains a separate Crave integration dependency; managed-cluster activation
does not by itself prove end-to-end order settlement.

## Fixed topology and safety rules

- `crave-loyalty-development`, `crave-loyalty-sandbox`, and `crave-loyalty-production` are separate
  Render services in Oregon.
- Keep all Crave API and Loyalty Render services in Oregon. Managed tenant runtimes are currently
  reached through their exact public HTTPS base URL, so same-region placement is not required for
  basic reachability; it minimizes the live API-to-Loyalty hop and preserves the option to adopt
  Render private networking without rebuilding services. Each Loyalty environment's Neon project
  stays in `aws-us-west-2`. A separately managed Crave platform database may remain in another
  region temporarily, but that cross-region dependency must be recorded and removed before its own
  production latency certification; it is not a reason to move the existing Render services.
- Each service has its own bootstrap/operator credentials, encryption key, and independently
  managed Neon project/database/role. No environment uses a Crave platform database.
- Both `LIP_CLOUD_DATABASE_URL` and `LIP_CLOUD_DATA_PLANE_DATABASE_URL` use the environment's direct
  Neon hostname. A `-pooler` hostname or `pgbouncer=true` fails before migrations or startup.
- Each service tracks its own branch — development `dev`, sandbox `sandbox`, production `main` —
  and `autoDeploy: false` keeps every deploy deliberate. Promotion is a **normal merge along
  dev -> sandbox -> main**, never a direct push. Normal merges produce different commit SHAs, so
  promotion equality is proved with each commit's canonical Git tree (`git rev-parse <sha>^{tree}`).
  The three tree SHAs must match exactly. `sandbox` and `main` are protected so a direct push cannot
  quietly break that.
- `numInstances: 1` is a correctness limit, not a sizing preference. Do not scale out until Admin
  state and webhook dispatch no longer depend on one process.
- `LIP_CLOUD_SHARED_KEY_DISABLED` is operator-managed (`sync: false`) so a Blueprint sync cannot
  reopen the deprecated shared-key bootstrap. Set it to `false` only while creating the first
  platform administrator, then set it permanently to `true` and redeploy as described in
  `shared-cluster-provisioning.md`.
- Migrations run at process startup under PostgreSQL advisory transaction locks and record applied
  versions. Paid services repeat the same idempotent migration command in `preDeployCommand` as
  defence in depth; development must still boot correctly on Free, where pre-deploy is unavailable.
- Source rollback never runs a down migration. Restore a Neon branch and repoint both database
  variables when data/schema rollback is required.

## Candidate promotion

1. Select the exact full development Git commit and compute its canonical source-tree SHA with
   `git rev-parse <full-commit>^{tree}` from a canonical checkout with `dev`, `sandbox`, and `main`
   fetched. Do not record a Render deploy ID yet because the candidate has not been deployed. These
   are Git-backed Docker services; Render builds each service from source and does not expose a
   registry image digest for promotion. Do not invent one. A future switch to prebuilt,
   digest-pinned registry images requires a separate topology decision.
2. Validate `render.yaml`; confirm exactly three services, `autoDeploy: false`, `region: oregon`,
   and `numInstances: 1` for all three.
3. Deploy the selected development commit first. After Render marks it live, record the deploy ID
   and the full commit Render reports, require that commit to equal the selected commit, recompute
   its canonical tree, and require that tree to equal the candidate tree. On a paid plan, the
   pre-deploy log must contain `shared_cluster_migrations_applied`. On Free, where no pre-deploy step
   exists, startup must apply the same migrations and `/ready` must report
   `migrations_applied: true`. A pooled URL must stop before either path with a safe direct-endpoint
   error. Finally, require `/health.release` to equal Render's recorded commit.
4. Verify development with `LIP_EXPECTED_ENVIRONMENT=development`, then exercise provisioning,
   enrollment, accrual, refund adjustment, member closure, and webhook delivery against synthetic
   data. Record its independent database fingerprint and restore rehearsal.
5. Merge development into `sandbox`, prove the resulting full sandbox commit has the exact recorded
   source-tree SHA, and deploy that commit. After it is live, record Render's deploy ID and reported
   commit and bind `/health.release` to that commit. The pre-deploy log must contain
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
9. Merge sandbox into `main`, prove the resulting full production commit has the exact recorded
   source-tree SHA, and deploy that commit. After it is live, record Render's deploy ID and reported
   commit and bind `/health.release` to that commit. Repeat migration, health, metrics, and restore
   checks with `LIP_EXPECTED_ENVIRONMENT=production` before routing Crave traffic.

## Health and metrics

- `GET /health` must report `status=ok`, `service=lip-cloud-control-plane`,
  `instance_policy=single`, the expected environment, and the exact Render Git commit.
- `GET /metrics` exposes Prometheus text for completed HTTP requests, process uptime, and resident
  memory. Alert on non-200 health, restart loops, sustained 5xx, and memory approaching the service
  limit.
- Path-scoped tenant runtimes still require their own protocol health, authenticated operations,
  webhook-health, and cross-tenant refusal checks through the managed service's exact public HTTPS
  base URL.

## Backup and restore rehearsal

Neon history retention/PITR is the only backup authority; there is no disk to snapshot. Legacy
standalone file backups are not evidence for a managed environment.

1. Freeze writes on every tenant runtime and record the freeze timestamp, source database branch,
   current Render deploy ID, Git commit, and canonical source-tree SHA. For a single-instance development drill,
   suspending the Render service is an acceptable full-cluster freeze.
2. Prove the source is stable before branching: capture the same schema/row-count/checksum evidence
   twice at least five seconds apart and require an exact match. A graceful service suspension can
   finish one last lease or scheduler write, so "suspended" alone is not sufficient evidence.

   ```bash
   LIP_BACKUP_SOURCE_DATABASE_URL='<direct frozen source URL>' \
   npm run cloud:restore-source-stability
   ```

   The command fails closed on any schema, row-count, or checksum drift and prints only the interval
   and counts of compared evidence fields, never connection details or row evidence.

3. Create a Neon branch only after the stability check passes. Use its direct endpoint and a
   restore-only role. Neon Console may visually wrap a hostname; use the endpoint metadata rather
   than copying formatting whitespace, and use `sslmode=verify-full` with current `pg` clients.
4. While source writes remain frozen, compare schema versions and deterministic fingerprints for
   control-plane, ledger, balance, idempotency, accrual, adjustment, member, and state relations:

   ```bash
   LIP_BACKUP_SOURCE_DATABASE_URL='<direct frozen source URL>' \
   LIP_BACKUP_RESTORE_DATABASE_URL='<direct restored branch URL>' \
   npm run cloud:restore-verify
   ```

5. Point a non-production verification service at the restored branch, run
   `cloud:deployment-verify`, and verify one known member balance/order lifecycle through the public
   protocol.
6. Record the source/restore branch IDs, restore timestamp, command result, row counts/checksums, and
   operator. Delete the rehearsal branch only after review. Unfreeze the source last.

The rehearsal fails closed on missing schemas, a pooled endpoint, a reused source URL, row-count
drift, or content-checksum drift.

## Rollback

### Application-only rollback

1. Freeze tenant writes.
2. Select the last reviewed Render deploy whose deploy ID, commit, and source tree are recorded in
   release evidence.
3. Use Render's rollback/redeploy control for that exact deploy; do not deploy the latest mutable
   branch head as a substitute.
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
git fetch --prune origin
npm run cloud:evidence:check -- path/to/evidence.json
```

For development, sandbox, and production, retain: service ID/hostname, Neon project/branch identifiers,
database-directness check, deploy ID, Git commit, canonical source-tree SHA, migration log event, `/health`
response, `/metrics` probe, instance count, backup branch/timestamp, restore verification result,
rollback target, and reviewer sign-off. Never record connection strings or credential values — the
checker refuses a record that contains anything matching a credential.

The evidence file itself is operator-supplied and is not committed. Only the schema, the checker and
a secret-free example live in this repository, so the record can be validated without the repository
ever holding an environment's secrets.

The checker also enforces release and isolation invariants:

- **Each environment must name a different Neon project, and neither database-plane fingerprint may
  appear in another environment.** Each deployment publishes `control_plane_database` and
  `data_plane_database` on `GET /health`, SHA-256 prefixes of `host:port/database` that contain no
  role or password. Control and data may intentionally match inside one environment, but comparing
  all six reported values across environments proves no database was reused.
- **Development, sandbox, and production must run commits with the same canonical Git source tree.**
  Normal merge promotion intentionally gives each protected branch a different commit SHA. Each
  `/health` response must report that environment's declared deployed commit as `release`, while
  the checker first proves the full commit is reachable from that environment's fetched canonical
  history (`origin/dev`, `origin/sandbox`, or `origin/main`), resolves its `gitCommit^{tree}`, binds
  the result to the recorded `sourceTree`, and then requires all three verified trees to match.
  Fetch all three protected refs immediately before running the checker. A stale response, orphaned
  or fork-only commit, fabricated tree, or mixed source tree cannot satisfy the gate.
- **An anonymous `/metrics` scrape must have been refused (401).** The series name tenants and
  environments, and the control plane is on a public URL.
