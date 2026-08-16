# Loyalty Interchange Protocol docs

LIP is an open, vendor-neutral transaction protocol for loyalty. The current
working draft is foodservice-first: it focuses on member resolution, restaurant
order evaluation, accrual, redemption reservation and capture, reversals,
refund adjustments, program catalogs, balances, tiers, and ledger history.

Use this directory for implementation guides and product-facing documentation.
Use `spec/` for the normative protocol contract.

## Quick start

Fastest path with Docker:

```sh
git clone https://github.com/craveup/opensource-loyalty.git
cd opensource-loyalty
docker compose up --build
```

Developer path from source. Use npm; this repo uses npm workspaces and
`package-lock.json`.

```sh
git clone https://github.com/craveup/opensource-loyalty.git
cd opensource-loyalty
npm install
npm start
```

The startup log prints the Admin URL and Admin/API key:

```text
Admin: http://127.0.0.1:3210/admin/
Admin/API key: lip-dev-key
```

Open the Admin URL and sign in with that key.

The local server exposes:

- Protocol API: `http://127.0.0.1:3210/lip/v1`
- Health: `http://127.0.0.1:3210/health`
- Discovery: `http://127.0.0.1:3210/.well-known/lip`
- Admin dashboard: `http://127.0.0.1:3210/admin/`

Then verify the environment. Source users can run:

```sh
npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- test http://127.0.0.1:3210 --api-key lip-dev-key
```

Docker-only users can run:

```sh
curl http://127.0.0.1:3210/health
curl http://127.0.0.1:3210/lip/v1/capabilities \
  -H 'Authorization: Bearer lip-dev-key'
```

## Using LIP with AI

Guides for building with Cursor, Claude Code, Codex, and other coding agents:

- [Using LIP with AI](using-lip-with-ai.md): CLI, spec/OpenAPI context, SDK,
  webhooks, BFF integration pattern, MCP notes, and agent pitfalls.
- [AI prompts](ai-prompts.md): copy/paste prompts for enroll, checkout preview,
  webhooks, refunds, validation, and e2e tests.
- [`llms.txt`](../llms.txt): compact repo index — point agents here first.

## Agent setup

```bash
npx skills add .
npm run lip -- init    # prints skills + MCP hints
```

Enable MCP: [`mcp.json`](../mcp.json) · Skills: [`skills/README.md`](../skills/README.md)

## Getting started

- [Getting started](getting-started.md): the shortest path from clean clone to a
  working loyalty request.
- [Five-minute quickstart](quickstart.md): start the reference platform,
  validate an order, enroll a member, and run conformance checks.
- [TypeScript SDK](typescript-sdk.md): use the idiomatic client, exact-money
  helpers, order builder, typed errors, and webhook verification.
- [Reference platform](reference-platform.md): understand the local server,
  durable SQLite state, Admin dashboard, and non-normative boundaries.
- [PostgreSQL production storage](postgres.md): normalized tenant tables,
  migrations, transaction locks, multi-instance serving, and scheduler leases.
- [Cloud control plane](cloud.md): organizations, projects, environments,
  plans, subscriptions, provisioning jobs, and usage metering.
- [Shared-cluster provisioning runbook](runbooks/shared-cluster-provisioning.md):
  deploy one Postgres-backed multi-tenant cluster from `render.yaml`, onboard
  brands as tenants, and operate backups, write-freeze, and monitoring.
- [Customer identity integration](customer-identity.md)
- [Cloud customer identity contract](cloud-customer-identity.md): managed Cloud CIAM boundary, consent, and LIP member linking: use Clerk, Auth0, or
  another OIDC provider while mapping stable customers to LIP members.
- [Self-hosted migration](../MIGRATION.md): freeze, checksummed full-state
  export/import, BFF cutover, idempotency, verification, and rollback.
- [Engagement integrations](engagement.md): analytics, consent-safe CRM
  exports, signed messaging connectors, jobs, retry, and adapter contracts.
- [Punchh compatibility](punchh-compatibility.md): map a restaurant loyalty
  migration against current LIP coverage and adapter gaps.
- [Ordering adapters](ordering-adapters.md): certify modifiers, tenders,
  offline replay, void, and refund mappings without unverified vendor claims.
- [Member migration](member-migration.md): create and reconcile checksummed
  member/balance import plans.
- [Architecture](architecture.md), [packaging](packaging.md),
  [security and operations](security-and-operations.md), and
  [design partners](design-partners.md): product and commercial boundaries.
- [Provider selection](provider-selection.md), [comparison](comparison.md), and
  [adoption metrics](metrics.md): evidence-driven evaluation and measurement.
- [Crave integration delivery plan](plans/2026-08-09-crave-integration-delivery.md): keep Crave and
  LIP independently deployed while proving provisioning, lifecycle, reconciliation and joint release.

## API reference

- [API endpoints](api-endpoints.md): current HTTP operations, auth, errors,
  retry behavior, and local curl examples.
- [OpenAPI contract](../spec/openapi.yaml): generated OpenAPI 3.1 binding.
- [Generated JSON Schemas](../spec/schemas): generated payload schemas.
- [SDK lifecycle example](../examples/typescript/full-lifecycle.ts): complete
  enroll, evaluate, earn, reserve, capture, reverse, and refund flow.

## Normative specification

- [Spec overview](../spec/README.md)
- [Core protocol](../spec/core.md)
- [Lifecycle rules](../spec/lifecycle.md)
- [Account experience](../spec/account-experience.md)
- [Foodservice profile](../spec/profiles/foodservice.md)
- [Webhooks](../spec/webhooks.md)
- [References](../spec/references.md)

When docs and spec disagree, treat `spec/` as canonical.

## What to build next

The docs should be organized like a developer portal, not a loose folder of
Markdown files. The next high-value guides are:

- Add loyalty to a restaurant checkout
- Configure a points-and-tiers program
- Configure a visit or stamp-card program
- Configure wallet credit and paid membership programs
- Handle refunds, voids, duplicate checks, and offline queues
- Operate webhooks in production
- Understand error codes and retry rules
- Publish and version provider conformance reports

See [API and documentation gap analysis](api-docs-gap-analysis.md) for the
current comparison against OpenLoyalty and Open WebUI documentation patterns.

## For agents and maintainers

Start with these files before changing behavior:

- `PLAN.md`: roadmap, milestones, and explicit product constraints
- `spec/openapi.yaml`: generated HTTP binding
- `packages/protocol/src`: source of generated schemas and types
- `packages/server/src/server.ts`: reference HTTP routes
- `packages/sdk/src/client.ts`: idiomatic TypeScript client
- `apps/admin/src/App.tsx`: reference Admin dashboard

Useful commands:

```sh
npm run generate
npm run typecheck
npm run test
npm run quickstart
```
