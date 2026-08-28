# PostgreSQL production storage

The reference server supports a normalized PostgreSQL engine store in addition
to the default SQLite sandbox.

## Start the Postgres profile

```bash
docker compose --profile postgres up --build
```

The SQLite runtime remains on port `3210`. The Postgres-backed runtime is
available on port `3211` by default. Set `LIP_POSTGRES_PORT` to change it.

To use an existing database:

```bash
LIP_DATABASE_URL=postgres://user:password@host:5432/loyalty \
LIP_TENANT_ID=demo-cafe \
LIP_API_KEY=replace-with-a-secret \
npm run serve
```

The runtime validates PostgreSQL URLs before constructing a pool. Because
`withLease()` holds session-scoped advisory locks, managed and standalone
Postgres runtimes must use a direct endpoint. Neon `-pooler` hostnames and
URLs carrying `pgbouncer=true` are rejected without echoing credentials.
Transaction pooling remains unsupported until a separately reviewed lease
design passes concurrency and failover conformance.

Startup applies numbered migrations from
`@loyalty-interchange/storage-postgres`, which is available on npm.
`LIP_RESET=true` explicitly deletes the selected tenant/program engine state
before seeding.

## Data model

Core engine state is split into tenant-scoped tables for:

- members and identity indexes
- account balances
- redemption reservations
- immutable ledger entries
- expiring balance lots and lot consumption
- idempotency records
- order accrual and adjustment indexes
- issued rewards

Every table includes `tenant_id` and `program_id` in its key. JSONB payloads
preserve forward-compatible protocol fields while indexed columns keep common
operator and reconciliation queries relational.

## Multi-instance behavior

Each protocol request:

1. checks out one database client;
2. starts a transaction;
3. obtains a tenant/program advisory transaction lock;
4. reloads the latest engine revision;
5. performs the operation;
6. replaces all normalized rows atomically and advances the revision;
7. commits before returning the HTTP response.

This prevents lost updates across server instances. Webhook events generated
inside the operation are buffered and released only after commit.

`PostgresEngineRepository.withLease()` exposes session advisory leases for
single-run schedulers and background jobs. `PostgresJsonStateStore` provides
optimistic revisions for tenant-scoped extension state.

The bundled Admin in Postgres mode now runs the complete service suite —
program publishing, campaign scheduling, memberships, engagement, access
directory, the location registry, and durable webhook journals — against
tenant-scoped `PostgresJsonStateStore` rows sharing one pool. Engine-mutating
admin operations (membership grants, campaign runs, program publishes) run
inside `executeEngineOperation`, so they commit through the same transactional
revision flow as protocol traffic. Admin queries and reporting are
location-aware and fail closed: users and API keys created with
`allowed_location_ids` see only their own locations in the registry and in
`/admin/api/v1/reports/locations` (which aggregates accrued balances, order
counts, and reservation outcomes per `location_id` from the location-stamped
ledger, plus an `unattributed_present` flag telling scoped callers that data
exists outside their view), and they are **denied** (403
`location_scoped_forbidden`) on tenant-wide admin reads such as
`/admin/api/v1/snapshot`, `/analytics`, and `/exports/members`.
Location-filtered variants of those tenant-wide views are follow-up work.

`GET /admin/api/v1/reports/locations` is served from a **lock-free read
path**: the platform loads the last committed engine state and hydrates a
throwaway engine (`readEngineSnapshot`), so report polling never takes the
tenant advisory lock and never queues behind accruals or redemptions.
Staleness contract: a report may lag in-flight mutations by one revision, and
expiry side effects computed during a read (e.g. lapsed reservations) are
counted in the report but not persisted until the next real write commits.

> [!IMPORTANT]
> **Run at most one platform instance per tenant.** The engine repository is
> multi-instance-safe, but the Admin extension services cache state with
> per-process revisions (a concurrent writer surfaces as
> `StateRevisionConflictError`) and the webhook journals persist
> last-writer-wins snapshots under a single-dispatcher assumption. Multi-
> instance Admin/webhook serving needs per-delivery revisioned rows or a
> `withLease`-guarded singleton dispatcher — tracked as follow-up work.

The managed Render blueprint enforces this with two independent services,
separate Neon databases/roles, attached environment-specific disks, and
`numInstances: 1`. See
[`docs/runbooks/managed-environment-release.md`](runbooks/managed-environment-release.md).

## Integration test

The default suite does not require a database. To run the live adapter test:

```bash
LIP_TEST_POSTGRES_URL=postgres://user:password@localhost:5432/loyalty \
npx vitest run tests/unit/postgres-storage.test.ts
```
