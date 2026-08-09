# Crave Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Crave with LIP as an independently deployed loyalty service through versioned
HTTP/SDK contracts, with exact release compatibility, recoverable order lifecycle behavior, and no
shared database or client-visible loyalty credentials.

**Architecture:** Crave remains the system of record for identity, carts, pricing, payments, orders,
public promotions, and customer UX. LIP remains the system of record for programs, members, balances,
rewards, reservations, and the loyalty ledger. Crave provisions and calls LIP through supported
control-plane and `/lip/v1` HTTP surfaces only; each product retains its own repository, release,
deployment, Postgres projects, roles, migrations, backups, and rollback.

**Tech Stack:** TypeScript, Node.js 20+, LIP OpenAPI and TypeBox contracts,
`@loyalty-interchange/sdk`, Vitest conformance tests, `pg`, direct Neon Postgres endpoints for
session-lease paths, GitHub Actions/npm provenance, OCI images, and Crave's Express modular monolith.

---

**Status:** Approved integration boundary; Crave-specific delivery not started

**Date:** 2026-08-09

**LIP baseline:** `origin/main` `7cd6a6a18d1bc7f0091c824fb711864f37780ba9`, repository version
`0.1.2`

**Implementation owner:** Umair owns every LIP and Crave code change, schema/contract change,
conformance fixture, migration, and rollout command in this plan.

**Release/runbook reviewer:** Ali reviews operator and developer experience, release automation,
runbooks, compatibility evidence, and rollback evidence. Ali does not replace Umair as implementation
owner. Each shared production gate requires both reviews on the exact candidate commits.

## Truth and status rules

- This document is a plan, not implementation, merge, package, deployment, or live-smoke evidence.
- A task is complete only when its exact reviewed commit and fresh command output are recorded.
- A published package/image is not deployed evidence. A healthy URL is not exact-version evidence.
- The LIP release manifest is generated from release artifacts. Crave's ecosystem compatibility
  record references its digest; neither file is hand-edited to manufacture compatibility.
- Implementation uses separate PRs in the LIP and Crave repositories. No cross-repository commit
  combines their histories.

## Current evidence

At the recorded baseline, LIP already provides:

- the vendor-neutral `/lip/v1` protocol, generated OpenAPI/schemas, TypeScript SDK and conformance;
- deterministic evaluation, enrollment, balances, tiers, ledger, reservations, capture, reversal and
  refund adjustment behavior;
- SQLite for local/single-node use and normalized tenant-scoped Postgres storage;
- transaction advisory locks plus session advisory leases for multi-instance scheduling;
- a Cloud control plane with organizations/projects/environments, operator/OIDC authentication,
  provisioning/attach, credential rotation, quotas and audit behavior;
- Admin, CLI, MCP, import/export, health, metrics, webhooks and release tooling; and
- documentation warning that session-lease paths need direct/unpooled Postgres connections.

Crave currently owns its customer identity, carts, pricing, payments, orders, public promotions and
customer-facing loyalty UI. The integration gap is not a second loyalty engine. It is the hardened
mapping, provisioning, shared Crave-side credential encryption, native adjustment, lifecycle,
reconciliation, and joint-release contract between the products.

## Non-negotiable boundary

- LIP remains a separate repository, release, service, database, roles, migrations, backups and
  on-call surface.
- A GitHub organization or repository-ownership transfer is an administrative option only. It is not
  a launch prerequisite and no task in this plan waits for one.
- Crave never imports LIP storage, reference-engine, Cloud implementation, or database packages; reads
  LIP tables; joins across databases; or applies LIP migrations.
- LIP never imports Crave packages or owns Crave customer authentication, carts, authoritative
  pricing, payments, orders, public promotion rules, or support truth.
- Runtime integration uses the published LIP SDK or raw versioned HTTP. Tests enforce the package
  boundary and reject storage/database imports from the Crave adapter or consumer harness.
- Web and Expo clients call Crave's public Storefront API only. They never receive a LIP API key,
  operator key, member ID, reservation credential, internal LIP URL, or database URL.
- Crave maps verified organization customers to opaque LIP member IDs server-side. Guest claim
  eligibility remains a Crave order/customer workflow.
- Crave public promotions and LIP-issued member rewards retain distinct source and ledger semantics.
  A loyalty effect becomes a typed Crave cart adjustment, not a hidden public promo code.
- Customer-time loyalty mutation is not an MCP responsibility. Crave's guarded merchant MCP may call
  Crave setup/diagnostic APIs; it does not call LIP or mutate the loyalty ledger directly.

## Deployment and database topology

```text
Crave sandbox API     -> LIP sandbox control/data plane     -> LIP sandbox Neon project
Crave production API  -> LIP production control/data plane  -> LIP production Neon project
```

The two LIP tiers use different services, projects, branches/databases, runtime roles, migration
roles, credentials, backups, restore drills, and monitoring. Neither tier reuses a Crave Neon project,
database, schema, role, connection string, migration history, or backup.

`PostgresEngineRepository.withLease()` currently acquires a session-scoped
`pg_try_advisory_lock` and releases it on the same checked-out client. Neon pooling uses PgBouncer in
transaction mode, which does not support session-level advisory locks. Therefore
`LIP_DATABASE_URL`, `LIP_CLOUD_DATA_PLANE_DATABASE_URL`, and the current Cloud startup/migration URL
must use direct, non-`-pooler` Neon endpoints while this implementation remains. See Neon's official
[connection pooling guidance](https://neon.com/docs/connect/connection-pooling).

A future pooler change is a separate design: replace session leases with transaction-scoped or
durable row leases, then pass multi-instance contention, connection-loss, crash, failover, and
recovery conformance before changing the production connection policy.

## Shared Crave encryption prerequisite

LIP must not create a Crave-specific crypto package. Before Task 4 can persist any LIP credential,
the Crave production-foundation work must provide the shared AES-256-GCM envelope-encryption service
used by loyalty, Square, and webhook secrets.

**Crave prerequisite files (separate Crave PR):**

- Create: `packages/security/package.json`
- Create: `packages/security/src/field-encryption.ts`
- Create: `packages/security/src/__tests__/field-encryption.test.ts`
- Create: `apps/express-admin-and-storefront-api/src/scripts/migrate-provider-secrets.ts`
- Create: `apps/express-admin-and-storefront-api/src/scripts/__tests__/migrate-provider-secrets.test.ts`
- Modify: `packages/env/src/env-configuration/index.ts`
- Modify: `apps/express-admin-and-storefront-api/src/services/loyalty/config.ts`
- Modify: the existing Square and webhook credential stores to consume the same service

The shared contract is:

```ts
export interface EncryptedField {
  algorithm: "AES-256-GCM";
  keyId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface FieldEncryptionService {
  encrypt(plaintext: string): Promise<EncryptedField>;
  decrypt(value: EncryptedField): Promise<string>;
  reencrypt(value: EncryptedField): Promise<EncryptedField>;
}
```

The prerequisite gate proves encrypt/decrypt, tamper rejection, wrong-key rejection, rotation,
re-encryption, safe logging, and a resumable dry-run/apply/verify/rollback migration of existing
plaintext loyalty and Square credentials. LIP returns a new environment credential once through TLS;
Crave immediately encrypts it with `@workspace/security` and never writes it to a plan, fixture, log,
job payload, or client response.

## Compatibility and provenance model

Each LIP release publishes one immutable, generated manifest and SHA-256 digest:

```ts
export interface LipReleaseManifestV1 {
  schemaVersion: 1;
  source: { repository: string; commit: string; tag: string };
  protocol: {
    version: "1.0";
    profile: "foodservice/1.0";
    openapiSha256: string;
  };
  packages: Array<{ name: string; version: string; integrity: string }>;
  image: { reference: string; digest: `sha256:${string}`; provenanceUrl: string };
  database: { migrationSetSha256: string; connectionMode: "direct" };
  verification: { runUrl: string; conformanceReportSha256: string };
}
```

Crave's independently reviewed ecosystem compatibility record stores the exact Crave API/adapter
commit, Storefront SDK version, LIP manifest URL/digest, LIP release/profile, sandbox deployment
revision, production deployment revision, and rollback targets. Compatible ranges may aid planning,
but promotion always pins exact artifacts.

## Dependency order

1. Task 1 freezes the generated release/provenance format.
2. Task 2 proves independent direct-connection deployments and lease safety.
3. The shared Crave encryption prerequisite merges before Task 4 persists credentials.
4. Task 3 freezes the HTTP/SDK consumer contract and may run alongside the Crave encryption work.
5. Task 4 implements provisioning only after Tasks 1-3 and the encryption prerequisite.
6. Tasks 5-6 implement lifecycle and recovery on top of the pinned contract.
7. Task 7 publishes, deploys, soaks, and promotes the exact compatible release set.

## Task 1: Generate the immutable LIP release manifest

**Owner:** Umair

**Reviewer:** Ali reviews release clarity and evidence usability

**Files:**

- Create: `docs/releases/lip-release-manifest.schema.json`
- Create: `docs/releases/lip-release-manifest.example.json`
- Create: `scripts/generate-release-manifest.ts`
- Create: `scripts/check-release-manifest.ts`
- Create: `tests/unit/release-manifest.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/releasing.md`

- [ ] **Step 1: Write the failing manifest tests**

Test deterministic key ordering/digest, exact Git SHA/tag, OpenAPI and migration digests, every
published package version/integrity, OCI digest/provenance URL, direct connection mode, and rejection
of placeholders or missing evidence.

```ts
expect(validateLipReleaseManifest(validFixture)).toEqual({ ok: true });
expect(() => validateLipReleaseManifest({ ...validFixture, source: { ...validFixture.source, commit: "main" } }))
  .toThrow(/40-character commit/);
expect(() => validateLipReleaseManifest({ ...validFixture, database: { ...validFixture.database, connectionMode: "pooled" } }))
  .toThrow(/direct/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/unit/release-manifest.test.ts`

Expected: FAIL because the schema and generator do not exist.

- [ ] **Step 3: Implement generation and validation**

Generate source values from the checked-out tag/SHA, protocol values from generated OpenAPI,
migration digest from every ordered SQL migration, package integrities from registry/pack output, and
image digest/provenance from workflow outputs. Canonicalize JSON before hashing. Never accept manual
CLI overrides for commit, package integrity, or image digest.

- [ ] **Step 4: Wire release checks**

Add `release:manifest` and `release:manifest:check` scripts. The release workflow runs full verify,
publishes with provenance, builds/pushes the OCI image, generates the manifest from resulting
artifacts, validates it, uploads it to the GitHub release, and records its digest as a workflow
artifact.

- [ ] **Step 5: Run GREEN gates**

```bash
npx vitest run tests/unit/release-manifest.test.ts
npm run spec:check
npm run release:manifest:check
git diff --check
```

Expected: all commands exit `0`; the example validates and contains no mutable branch/image tag.

- [ ] **Step 6: Commit**

```bash
git add docs/releases scripts/generate-release-manifest.ts scripts/check-release-manifest.ts tests/unit/release-manifest.test.ts package.json .github/workflows/release.yml docs/releasing.md
git commit -m "release: generate immutable compatibility manifest"
```

**Gate:** the manifest is reproducible from exact artifacts and Crave can reference its immutable
digest without copying or editing LIP release facts.

## Task 2: Enforce direct connections and independent deployments

**Owner:** Umair

**Reviewer:** Ali reviews configuration errors and operations documentation

**Files:**

- Create: `packages/storage-postgres/src/connection-policy.ts`
- Create: `apps/cloud/src/database-configuration.ts`
- Create: `apps/cloud/src/database-configuration.test.ts`
- Create: `tests/conformance/postgres-lease-conformance.test.ts`
- Modify: `packages/storage-postgres/src/index.ts`
- Modify: `packages/server/src/platform.ts`
- Modify: `packages/server/src/cli.ts`
- Modify: `apps/cloud/src/cli.ts`
- Modify: `apps/cloud/src/migrate-cli.ts`
- Modify: `tests/unit/postgres-storage.test.ts`
- Modify: `.env.example`
- Modify: `render.yaml`
- Modify: `docs/postgres.md`
- Modify: `docs/runbooks/shared-cluster-provisioning.md`

- [ ] **Step 1: Write failing connection-policy tests**

```ts
expect(() => assertSessionLeaseCompatibleUrl(
  "postgresql://user:pass@ep-demo-pooler.us-east-2.aws.neon.tech/loyalty",
  "LIP_CLOUD_DATA_PLANE_DATABASE_URL"
)).toThrow(/direct.*session advisory lease/i);

expect(() => assertSessionLeaseCompatibleUrl(
  "postgresql://user:pass@ep-demo.us-east-2.aws.neon.tech/loyalty",
  "LIP_CLOUD_DATA_PLANE_DATABASE_URL"
)).not.toThrow();
```

Also assert that missing URLs, identical sandbox/production URLs in deployment validation, malformed
URLs, and credentials embedded in errors are rejected safely.

- [ ] **Step 2: Write failing lease ownership tests**

Use two repositories against `LIP_TEST_POSTGRES_URL`. Assert acquire/work/unlock use one checked-out
client; a contender cannot acquire the same lease; thrown/aborted work unlocks; client release occurs;
and a subsequent worker can acquire after connection loss/recovery. Skip only when the explicit test
database variable is absent.

- [ ] **Step 3: Run RED gates**

```bash
npx vitest run apps/cloud/src/database-configuration.test.ts tests/unit/postgres-storage.test.ts tests/conformance/postgres-lease-conformance.test.ts
npm run typecheck
```

Expected: FAIL because the connection policy/configuration module and expanded conformance do not
exist.

- [ ] **Step 4: Implement fail-fast connection policy**

Export `assertSessionLeaseCompatibleUrl(connectionString, variableName)` from
`connection-policy.ts`. Call it before constructing any data-plane repository that exposes
`withLease()`, and before current startup migration paths. Error output names the variable and direct
endpoint requirement but never echoes the URL.

- [ ] **Step 5: Separate sandbox and production deployment inputs**

Make `render.yaml` consume server-only direct URLs rather than creating/reusing a Crave database.
Document two separately provisioned LIP Neon projects and roles. Keep `autoDeploy: false`; pin the
candidate image digest/revision; run migrations through a direct migration role; and record distinct
backup/restore evidence for both tiers.

- [ ] **Step 6: Run GREEN gates**

```bash
npx vitest run apps/cloud/src/database-configuration.test.ts tests/unit/postgres-storage.test.ts tests/conformance/postgres-lease-conformance.test.ts
npm run conformance
npm run typecheck
git diff --check
```

Expected: all commands exit `0` when `LIP_TEST_POSTGRES_URL` is a direct test database; pooled Neon
URLs fail before any schema or runtime query.

- [ ] **Step 7: Commit**

```bash
git add packages/storage-postgres packages/server apps/cloud tests render.yaml .env.example docs/postgres.md docs/runbooks/shared-cluster-provisioning.md
git commit -m "postgres: require direct connections for session leases"
```

**Gate:** LIP sandbox and production are independently deployable/restorable, and every current
lease-holding or startup-migration path refuses a Neon transaction-pooler URL.

## Task 3: Freeze the Crave consumer contract at the HTTP/SDK boundary

**Owner:** Umair

**Reviewer:** Ali reviews fixture clarity and developer documentation

**Files:**

- Create: `tests/consumers/crave/fixtures.ts`
- Create: `tests/consumers/crave/http-contract.test.ts`
- Create: `tests/consumers/crave/import-boundary.test.ts`
- Modify: `spec/profiles/foodservice.md`
- Modify: `spec/lifecycle.md`
- Modify: `spec/webhooks.md`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/src/errors.ts`
- Modify: `tests/unit/sdk.test.ts`
- Modify: `scripts/generate-spec.ts`
- Modify: `scripts/generate-sdk.ts`

- [ ] **Step 1: Write the import-boundary test**

Scan the consumer harness and the separately supplied Crave adapter source list. Allow the published
`@loyalty-interchange/sdk` or the adapter's own raw HTTP client only. Reject every other
`@loyalty-interchange/*` package, including direct protocol imports, plus `storage-postgres`,
`storage-sqlite`, `reference`, `apps/cloud`, `pg`, Prisma, and raw migration files.

```ts
expect(forbiddenImports("tests/consumers/crave")).toEqual([]);
```

- [ ] **Step 2: Write failing black-box contract tests**

Against an HTTP server fixture, cover discovery/capabilities, lookup/enroll, account, ledger cursor,
evaluate, reserve/capture/reverse, accrual, full/partial refund adjustment, request-ID echo,
idempotency replay, wrong tenant/location, timeout, `409`, retryable `429/5xx`, and unknown result
recovery. Use sanitized Crave-shaped IDs only; do not add Crave-specific fields to normative schemas.

- [ ] **Step 3: Run RED gates**

```bash
npx vitest run tests/consumers/crave tests/unit/sdk.test.ts
npm run spec:check
```

Expected: FAIL on the new explicit lifecycle/error assertions and boundary harness.

- [ ] **Step 4: Tighten the vendor-neutral profile and SDK**

Document the required foodservice lifecycle and stable problem codes in normative LIP terms. Generate
OpenAPI and SDK output. The SDK remains the retry/validation boundary and exposes request IDs and
typed ambiguous/terminal errors without leaking the API key.

- [ ] **Step 5: Run GREEN gates**

```bash
npm run spec:check
npx vitest run tests/consumers/crave tests/unit/sdk.test.ts tests/conformance/http-lifecycle.test.ts
npm run test:packages
git diff --check
```

Expected: all commands exit `0`; generated files are clean; the consumer harness has no implementation
or database import.

- [ ] **Step 6: Commit**

```bash
git add tests/consumers/crave spec packages/sdk scripts/generate-spec.ts scripts/generate-sdk.ts tests/unit/sdk.test.ts
git commit -m "conformance: freeze Crave foodservice consumer contract"
```

**Gate:** a Crave adapter can be implemented from the published OpenAPI/SDK alone, with no repository
checkout, storage code, undocumented field, or shared database.

## Task 4: Implement idempotent provisioning and credential rotation

**Owner:** Umair

**Reviewer:** Ali reviews operator recovery and runbook usability

**Dependencies:** Tasks 1-3 and the merged shared Crave encryption prerequisite

**LIP files:**

- Modify: `apps/cloud/src/types.ts`
- Modify: `apps/cloud/src/service.ts`
- Modify: `apps/cloud/src/server.ts`
- Modify: `apps/cloud/src/tenant-onboarding.ts`
- Modify: `apps/cloud/src/tenant-onboarding.test.ts`
- Modify: `apps/cloud/src/cloud.test.ts`
- Modify: `tests/conformance/cloud-attach-conformance.test.ts`
- Modify: `docs/cloud.md`
- Modify: `docs/runbooks/shared-cluster-provisioning.md`

**Crave files in a separate Crave PR:**

- Create: `apps/express-admin-and-storefront-api/src/application/loyalty/provisioning.ts`
- Create: `apps/express-admin-and-storefront-api/src/application/loyalty/provisioning.test.ts`
- Modify: `apps/express-admin-and-storefront-api/src/services/loyalty/lip-client.ts`
- Modify: `apps/express-admin-and-storefront-api/src/services/loyalty/config.ts`
- Modify: `packages/db/prisma/schema.prisma`

The Crave persistence contract is:

```ts
export interface CraveLoyaltyProvisioningRecord {
  organizationId: string;
  lipReleaseManifestSha256: string;
  lipOrganizationId: string;
  lipProjectId: string;
  lipEnvironmentId: string;
  lipProgramId: string;
  status: "pending" | "ready" | "failed" | "suspended";
  encryptedCredential: EncryptedField;
  credentialFingerprint: string;
  credentialVersion: number;
  idempotencyKey: string;
  attempts: number;
  lastRequestId?: string;
}
```

- [ ] **Step 1: Write failing LIP provisioning tests**

Prove one stable organization/project/environment for repeated slugs/idempotency, org-scoped operator
authorization, shared-bootstrap-key rejection, pending-to-ready polling, attach, partial failure,
rotation overlap, emergency rotation, revocation, suspension, signed webhook subscription, and audit
attribution. The one-time merchant credential appears only in the rotation response.

- [ ] **Step 2: Write failing Crave provisioning tests**

Mock only the LIP HTTP boundary. Assert repeated enablement converges; no database/container call exists;
the exact LIP manifest digest is stored; the returned key is encrypted by the shared service before
commit; plaintext is absent from logs/jobs/responses; and a failed transaction leaves a retryable
journal rather than an orphaned second tenant.

- [ ] **Step 3: Run RED gates in each repository**

LIP:

```bash
npx vitest run apps/cloud/src/tenant-onboarding.test.ts apps/cloud/src/cloud.test.ts tests/conformance/cloud-attach-conformance.test.ts
```

Crave:

```bash
pnpm --filter './packages/*' build
pnpm --filter express-admin-and-storefront-api test -- --runInBand src/application/loyalty/provisioning.test.ts
pnpm --filter @workspace/security test
```

Expected: FAIL on the new exact compatibility/encryption/idempotency assertions.

- [ ] **Step 4: Implement through supported APIs only**

Crave uses an org-scoped `lip_ok_...` operator credential to call existing Cloud organization,
project, environment, status, attach, and credential-rotation endpoints. It never uses
`LIP_CLOUD_API_KEY` after bootstrap, reads credentials files, invokes a container, or opens a LIP
database connection. Store only stable IDs, status, fingerprints, encrypted credentials, attempts,
request IDs, and the release-manifest digest.

- [ ] **Step 5: Run GREEN gates**

Run the commands from Step 3 again, plus:

```bash
npm run conformance
pnpm --filter express-admin-and-storefront-api test -- --runInBand src/services/loyalty src/application/loyalty
```

Expected: all commands exit `0`; retry produces one environment and plaintext secret scans return no
matches.

- [ ] **Step 6: Commit separate PR heads**

LIP:

```bash
git add apps/cloud tests/conformance docs/cloud.md docs/runbooks/shared-cluster-provisioning.md
git commit -m "cloud: harden Crave tenant provisioning"
```

Crave:

```bash
git add apps/express-admin-and-storefront-api/src/application/loyalty apps/express-admin-and-storefront-api/src/services/loyalty packages/db/prisma/schema.prisma
git commit -m "loyalty: add encrypted LIP provisioning"
```

**Gate:** enable/retry/rotate/revoke converges through HTTP to one audited environment and one intended
credential lineage, with no plaintext or client-visible secret.

## Task 5: Implement verified identity and native loyalty adjustments

**Owner:** Umair

**Reviewer:** Ali reviews customer/operator-visible denial and degraded states

**LIP files:**

- Modify: `tests/consumers/crave/fixtures.ts`
- Create: `tests/consumers/crave/order-lifecycle.test.ts`
- Modify: `tests/conformance/http-lifecycle.test.ts`
- Modify: `spec/profiles/foodservice.md`

**Crave files in a separate Crave PR:**

- Create: `apps/express-admin-and-storefront-api/src/application/loyalty/native-adjustment.ts`
- Create: `apps/express-admin-and-storefront-api/src/application/loyalty/native-adjustment.test.ts`
- Modify: `apps/express-admin-and-storefront-api/src/services/loyalty/order-hooks.ts`
- Modify: `apps/express-admin-and-storefront-api/src/controllers/loyalty/**`
- Modify: `packages/storefront-sdk/src/**`

- [ ] **Step 1: Write failing identity and adjustment tests**

Cover verified-only enroll/earn/redeem, cross-organization denial, no automatic guest enrollment,
OTP-bound guest claim, exact cart revision/value, one loyalty reward, no public-promo stacking,
reserve/release/re-reserve, checkout conflict, capture, completion accrual, cancellation, full refund,
partial refund, and pre-completion netting.

- [ ] **Step 2: Define stable idempotency identities**

Use these canonical inputs:

```text
enroll:        crave:customer:<organizationId>:<customerId>:enroll
evaluate:      crave:cart:<cartId>:revision:<revision>:evaluate
reserve:       crave:cart:<cartId>:revision:<revision>:reward:<rewardId>:reserve
capture:       crave:order:<orderId>:reservation:<reservationId>:capture
accrual:       crave:order:<orderId>:completion:<completionRevision>:accrue
adjustment:    crave:order:<orderId>:adjustment:<adjustmentId>
guest-claim:   crave:order:<orderId>:claim:<verifiedCustomerId>
```

Store fingerprints rather than raw keys in diagnostic output.

- [ ] **Step 3: Run RED gates in both repositories**

```bash
npx vitest run tests/consumers/crave/order-lifecycle.test.ts tests/conformance/http-lifecycle.test.ts
pnpm --filter express-admin-and-storefront-api test -- --runInBand src/application/loyalty/native-adjustment.test.ts src/services/loyalty
pnpm --filter @craveup/storefront-sdk test
```

Expected: FAIL because the native Crave adjustment and complete joint fixtures are absent.

- [ ] **Step 4: Implement the native boundary**

Map LIP discount/free-item effects to a typed Crave `loyalty_reward` adjustment distinct from
`public_promo`. Crave validates the effect against its authoritative cart and totals; LIP never
recomputes or writes Crave totals. Keep the current reward-to-discount mapping during parity and remove
it only in a later cleanup PR after rollback expires.

- [ ] **Step 5: Run GREEN gates and commit separate heads**

```bash
npm run spec:check
npx vitest run tests/consumers/crave/order-lifecycle.test.ts tests/conformance/http-lifecycle.test.ts
pnpm --filter express-admin-and-storefront-api test -- --runInBand src/application/loyalty src/services/loyalty src/controllers/loyalty
pnpm --filter @craveup/storefront-sdk test
```

Expected: all commands exit `0`; balances, reservations, ledger entries, Crave adjustment state, and
order totals reconcile for every path.

LIP commit:

```bash
git add tests/consumers/crave tests/conformance/http-lifecycle.test.ts spec/profiles/foodservice.md
git commit -m "conformance: prove Crave loyalty lifecycle"
```

Crave commit:

```bash
git add apps/express-admin-and-storefront-api packages/storefront-sdk
git commit -m "loyalty: add native reward adjustments"
```

**Gate:** only verified identities earn/redeem, guest claim cannot replay or cross customers, and all
Crave/LIP financial identities reconcile.

## Task 6: Add reconciliation, observability, and recovery

**Owner:** Umair

**Reviewer:** Ali reviews dashboards, runbooks, and safe operator actions

**LIP files:**

- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/webhook-outbox.ts`
- Modify: `packages/server/src/webhook-history.ts`
- Modify: `packages/sdk/src/webhooks.ts`
- Create: `tests/consumers/crave/recovery.test.ts`
- Modify: `docs/webhook-delivery.md`
- Create: `docs/runbooks/crave-integration-recovery.md`

**Crave files in a separate Crave PR:**

- Create: `apps/express-admin-and-storefront-api/src/application/loyalty/reconciliation.ts`
- Create: `apps/express-admin-and-storefront-api/src/application/loyalty/reconciliation.test.ts`
- Modify: `apps/express-admin-and-storefront-api/src/services/loyalty/tasks.ts`
- Modify: `apps/express-admin-and-storefront-api/src/services/loyalty/order-hooks.ts`

- [ ] **Step 1: Write failing recovery tests**

Cover lost response after commit, timeout before commit, retryable outage, duplicate signed webhook,
invalid signature, credential rotation during retry, retry exhaustion, inspect, safe replay, manual
resolution with reason, escalation, LIP rollback, and restore. Reject arbitrary raw-request replay.

- [ ] **Step 2: Define the safe operation journal**

```ts
export interface CraveLoyaltyOperationJournal {
  operationId: string;
  organizationHash: string;
  locationHash?: string;
  lipRequestId?: string;
  idempotencyFingerprint: string;
  operation: "enroll" | "evaluate" | "reserve" | "capture" | "accrue" | "adjust" | "claim";
  state: "pending" | "succeeded" | "ambiguous" | "exhausted" | "resolved";
  attempts: number;
  nextAttemptAt?: string;
  resolution?: { outcome: string; reason: string; actorId: string; resolvedAt: string };
}
```

No request body, contact, member ID, token, credential, capability, or raw webhook payload is stored in
operator-facing diagnostics.

- [ ] **Step 3: Run RED, implement, and run GREEN**

```bash
npx vitest run tests/consumers/crave/recovery.test.ts tests/unit/webhooks.test.ts tests/unit/webhook-stores.test.ts
pnpm --filter express-admin-and-storefront-api test -- --runInBand src/application/loyalty/reconciliation.test.ts src/services/loyalty
```

Expected before implementation: FAIL on the new recovery assertions. Implement bounded retry,
lookup-before-retry for ambiguous mutations, signed webhook dedupe, sanitized metrics/logs, and
audited resolution. Re-run the same commands; expected after implementation: all exit `0`.

- [ ] **Step 4: Rehearse runbook scenarios**

Record sanitized request IDs and timestamps for dependency outage, credential compromise, degraded
Storefront API response, queue exhaustion, rollback, backup restore, and post-restore reconciliation.
An operator must resolve the scenario without editing either database.

- [ ] **Step 5: Commit separate heads**

```bash
git add packages/server packages/sdk/src/webhooks.ts tests/consumers/crave docs/webhook-delivery.md docs/runbooks/crave-integration-recovery.md
git commit -m "operations: add Crave loyalty recovery contract"
```

```bash
git add apps/express-admin-and-storefront-api/src/application/loyalty apps/express-admin-and-storefront-api/src/services/loyalty
git commit -m "loyalty: add reconciliation operations"
```

**Gate:** an operator can determine and recover every ambiguous outcome from safe IDs without raw
replay, plaintext secrets, or database edits.

## Task 7: Publish and promote one exact compatible release set

**Owner:** Umair owns release implementation and promotion commands

**Reviewer:** Ali reviews package/image/docs/runbook evidence and co-signs rollback readiness

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `Dockerfile`
- Modify: `render.yaml`
- Modify: `docs/releasing.md`
- Modify: `docs/runbooks/shared-cluster-provisioning.md`
- Modify: `docs/runbooks/crave-integration-recovery.md`
- Update through automation: `docs/releases/lip-release-manifest.example.json`
- Update in the separate Crave release-evidence PR: `docs/releases/ecosystem-compatibility.json`

- [ ] **Step 1: Add release-path tests and protected ordering**

CI must prove source/spec/SDK/package/image/migration consistency, direct connection policy,
consumer conformance, secret scans, and immutable provenance. Release order is: migrations, compatible
LIP service, LIP manifest, Crave adapter/API, sandbox joint smoke, then production promotion. No
workflow depends on repository transfer.

- [ ] **Step 2: Run the complete LIP candidate matrix**

```bash
npm ci
npm run spec:check
npm run typecheck
npm run conformance
npm run verify
npm run release:manifest:check
git diff --check
```

Expected: every command exits `0`; generated sources are clean; package and image identities match the
manifest; direct-connection and consumer suites pass.

- [ ] **Step 3: Run the complete Crave candidate matrix**

```bash
pnpm --filter './packages/*' build
pnpm --filter express-admin-and-storefront-api test -- --runInBand src/application/loyalty src/services/loyalty src/controllers/loyalty
pnpm --filter @craveup/storefront-sdk test
pnpm lint
pnpm check-types
git diff --check
```

Expected: every command exits `0`; the adapter imports only the published SDK or uses raw versioned
HTTP, and it consumes `@workspace/security` rather than a loyalty-specific crypto module.

- [ ] **Step 4: Publish exact LIP artifacts**

Publish npm packages with provenance and the OCI image by digest from the exact reviewed tag. Verify
registry integrity and provenance, generate/attach the LIP manifest, and deploy that image digest to
LIP sandbox using its direct database roles.

- [ ] **Step 5: Execute sandbox joint conformance and soak**

Run provisioning, rotation, verified enroll, earn, reserve/capture/reverse, cancellation, full/partial
refund, guest claim, cross-tenant denial, outage, replay, reconciliation, backup/restore, and rollback.
Record exact LIP/Crave revisions, deployment IDs, manifest digest, migration digest, request IDs, test
run URLs, and rollback targets. No credentials or customer data enter the record.

- [ ] **Step 6: Promote and verify production**

After both owners approve the sandbox record, deploy the same LIP image digest and compatible Crave
release to production. Run bounded live success/denial/recovery smoke, verify live revisions against
the compatibility record, and monitor the agreed soak window before declaring production-approved.

- [ ] **Step 7: Rehearse rollback before cleanup**

Roll back Crave and LIP independently, restore service without destructive schema contraction, and
reconcile admitted operations. Keep old credential overlap and transitional reward mapping until the
approved rollback window closes. Cleanup ships as a later PR.

**Gate:** running LIP and Crave revisions, packages, image digest, protocol/profile, migrations,
manifest, live request IDs, and rollback targets all match the reviewed compatibility record.

## Definition of done

- [ ] Crave provisions and connects a LIP environment through HTTP without database, filesystem,
      container, or repository intervention.
- [ ] The shared Crave field-encryption service protects LIP, Square, and webhook credentials; no
      loyalty-only Crave crypto implementation exists.
- [ ] LIP sandbox and production have independent services, Neon projects, roles, migrations,
      backups, restores, releases, and rollback targets; none are shared with Crave.
- [ ] Current session-advisory-lease paths use validated direct/unpooled connections.
- [ ] Verified identity, earn, redeem, cancel, refund, guest claim, ambiguous-result recovery, and
      cross-tenant denial pass the joint black-box suite.
- [ ] Web/mobile clients use only Crave public contracts and render truthful unavailable, pending,
      conflict, and reconciled states without receiving LIP identifiers or secrets.
- [ ] Exact Crave API/adapter, Storefront SDK, LIP packages/image, protocol/profile, migration, release
      manifest, deployment, and rollback identities match the running environments.
- [ ] Repository transfer remains optional administration and did not gate implementation or launch.

## Deferred

- GitHub organization or repository transfer.
- Transaction-pooled LIP runtime until a separately approved lease redesign passes concurrency and
  failover conformance.
- Crave-specific concepts in the normative LIP protocol.
- A shared Crave/LIP database, role, schema, migration, backup, or direct query.
- Direct client-to-LIP calls or client-visible LIP credentials/member IDs.
- Customer self-service paid membership billing, gift cards, multiple loyalty rewards per order, and
  configurable public-promo/reward stacking.
- Replacing Crave public promotions with LIP campaigns.
