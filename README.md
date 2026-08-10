# Loyalty Interchange Protocol (LIP) 👋

[![npm](https://img.shields.io/npm/v/%40loyalty-interchange%2Fsdk?logo=npm&label=%40loyalty-interchange)](https://www.npmjs.com/org/loyalty-interchange)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=nodedotjs&logoColor=white)
![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-6BA539?logo=openapiinitiative&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Status](https://img.shields.io/badge/Status-Working_Draft_0.1-orange)

**LIP is an open, vendor-neutral loyalty protocol and reference platform for developers building restaurant, QSR, coffee, convenience, and franchise ordering systems.** It ships everything needed to go from zero to a working loyalty integration: a normative protocol spec, a **deterministic reference engine**, an **HTTP API**, a **TypeScript SDK**, a local **Admin dashboard**, a SQLite sandbox, Docker runtime, runnable examples, and black-box conformance tests.

> [!IMPORTANT]
> Customer authentication is intentionally outside the LIP transaction
> boundary. The app BFF integrates Clerk, Auth0, or another identity provider,
> keeps the merchant API key server-side, and maps authenticated customers to
> opaque LIP `member_id` values. A LIP member is not automatically a platform
> customer. For example, a pilot app's demo guests can exist in that app's
> BFF/customer-data layer without ever being provisioned in a managed customer
> identity platform.

📖 **Documentation: [loyalty-interchange.mintlify.app](https://loyalty-interchange.mintlify.app)** — new here? Start at **[Get started](https://loyalty-interchange.mintlify.app/get-started)**. (The guides in [`docs/`](docs/README.md) are the source.) Building with an AI coding agent? Start with **[Getting started with AI](#getting-started-with-ai-)**.

## Key Features of LIP ⭐

- 🚀 **Effortless Setup**: One command to a seeded local sandbox (`npm start`), or self-host with Docker Compose. The startup screen prints your Admin URL and API key.

- 🔁 **Complete Loyalty Lifecycle**: Member lookup, enrollment, balances, and ledger history. Evaluate orders before checkout, post accrual after payment, and run redemption reserve, capture, reverse, and refund-safe adjustment flows.

- 🍔 **Foodservice-First Order Model**: Restaurant orders with items, modifiers, discounts, fees, taxes, tips, tenders, and totals. Channel-aware rules for counter, drive-thru, kiosk, web, mobile, pickup, delivery, and catering.

- 🏪 **Franchise-Aware Scope**: Brand, merchant, location, and franchisee identifiers, plus product, category, tag, and line-kind earning exclusions.

- 🎯 **Multiple Program Models**: executable **points**, **visits/stamps**,
  **wallet credit**, **paid membership**, and hybrid multi-account programs with
  independent earning, balances, expiration, reward costs, and reservations.
- 📣 **Engagement Platform**: persisted static or dynamic segments, scheduled
  reward campaigns, idempotent wallet issuance, reward draft CRUD, and
  membership lifecycle controls in Admin. Ledger analytics, consent-filtered
  CRM exports, and signed messaging connector jobs include retries and audit.

- 🛡️ **Retry-Safe by Design**: Idempotency keys, request context, RFC 9457 problem details, and partial refund, void, reversal, duplicate-check, and settlement semantics.

- 🧰 **TypeScript SDK**: Idiomatic domain client with request ids, timestamps, idempotency keys, exact-money helpers, a foodservice order builder, and a generated low-level OpenAPI client.

- 🖥️ **Local Admin Dashboard**: Authenticated dashboard at `http://127.0.0.1:3210/admin/` for inspecting members and ledger activity, plus versioned program drafts, validation, live publish, and rollback.

- 🗄️ **Durable Storage**: SQLite-backed local state by default plus normalized,
  tenant-scoped Postgres tables, migrations, optimistic revisions, advisory
  transaction locks, and scheduler leases for multi-instance protocol serving.

- ☁️ **Cloud Control Plane**: A separate Postgres-backed management service for
  organizations, projects, regional environments, plans, subscriptions,
  provisioning jobs, idempotent usage metering, and quotas. The open protocol
  and self-hosted runtime remain independent of this non-normative service.

- 🔐 **External Identity Bridge**: Validate Clerk, Auth0, or generic OIDC access
  tokens in your BFF and map provider identities to stable customer and LIP
  member ids without moving credentials or sessions into the loyalty platform.

- 🧪 **Specs and Conformance**: OpenAPI 3.1 contract, JSON Schema Draft 2020-12 payload schemas, normative lifecycle, account, webhook, and foodservice profile documents, and black-box HTTP conformance tests you can run against any implementation.

- 🔧 **Batteries-Included CLI**: Validation, diagnostics (`doctor`), local serving, schema listing, baseline conformance checks, and checksummed full-state export/import for cloud migration.

- 🤖 **AI-Ready**: Installable agent Skills, an official MCP server, [`llms.txt`](llms.txt), and curated prompts so Cursor, Claude Code, Codex, and similar tools implement LIP correctly.

Want the full picture? Check out the [developer docs](docs/README.md) for a comprehensive overview.

## How to Install 🚀

### Getting started with AI 🤖

LIP is set up for AI coding agents the same way platforms like Clerk are: Skills for specialized knowledge, an MCP server for accurate lookups, and a compact index for agent context.

```bash
# After cloning and installing (see below)
npx skills add .
```

That installs seven Skills (`lip`, `lip-cli`, `lip-sdk`, `lip-checkout`, `lip-webhooks`, `lip-bff`, `lip-conformance`) into your agent environment.

Then enable the MCP server. Cursor can use the repo root [`mcp.json`](mcp.json) (Settings → MCP), or run it directly:

```bash
npm run mcp
```

| Resource | What it is |
| --- | --- |
| [Using LIP with AI](docs/using-lip-with-ai.md) | Full AI getting-started guide |
| [AI prompts](docs/ai-prompts.md) | Copy/paste prompts for checkout, webhooks, refunds, and more |
| [`llms.txt`](llms.txt) | Compact repo index — point your agent here first |
| [`skills/`](skills/README.md) | Installable agent Skills |
| [`packages/mcp/`](packages/mcp/) | Official MCP server (spec lookups, validation, SDK snippets) |

### Quick Start with Docker 🐳

Requirements: Git and Docker.

```bash
git clone https://github.com/craveup/opensource-loyalty.git
cd opensource-loyalty
docker compose up --build
```

The startup log prints the Admin URL and the Admin/API key. With the default Compose environment, the key is:

```text
lip-dev-key
```

Open the Admin dashboard at [http://127.0.0.1:3210/admin/](http://127.0.0.1:3210/admin/) and sign in with that key.

> [!TIP]
> If the terminal is no longer visible, read the same key from Docker logs with `docker compose logs lip`.

Then verify the API in a second terminal:

```bash
curl http://127.0.0.1:3210/health
curl http://127.0.0.1:3210/lip/v1/capabilities \
  -H 'Authorization: Bearer lip-dev-key'
```

### Installation from Source 🛠️

Requirements: Git, Node.js 20.19 or newer, and npm.

> [!NOTE]
> This repo uses npm workspaces with `package-lock.json`. pnpm is not the supported install path. For a clean lockfile-only install, use `npm ci` instead of `npm install`.

```bash
git clone https://github.com/craveup/opensource-loyalty.git
cd opensource-loyalty
npm install
npm start
```

The CLI prints:

```text
Admin: http://127.0.0.1:3210/admin/
Admin/API key: lip-dev-key
```

In a second terminal, check the server and run the baseline conformance suite:

```bash
npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- test http://127.0.0.1:3210 --api-key lip-dev-key
```

Run the full SDK lifecycle — enroll a member, evaluate an order, post accrual, reserve and capture a reward, reverse it, and adjust a refunded order:

```bash
npm run example:sdk
```

### What You Should See ✅

The local server exposes:

- Admin dashboard: `http://127.0.0.1:3210/admin/`
- Protocol API: `http://127.0.0.1:3210/lip/v1`
- Health: `http://127.0.0.1:3210/health`
- Prometheus metrics: `http://127.0.0.1:3210/metrics` (Bearer auth required)
- Discovery: `http://127.0.0.1:3210/.well-known/lip`

### Running the API Separately

Use this when you only need the reference API and Admin app:

```bash
npm run lip -- serve
```

Useful options:

```bash
npm run lip -- serve --reset
npm run lip -- serve --reset --no-seed
npm run lip -- serve --database .lip/another.db
npm run lip -- serve --port 4010 --api-key local-dev-key
npm run lip -- serve --program ./my-program.json
npm run lip -- serve --rate-limit 300 --rate-window-ms 60000
npm run lip -- serve --no-structured-logs
```

`--program` bootstraps an empty database with your own JSON program definition
(same shape as `ProgramDefinition` in `packages/reference/src/config.ts`).
Afterward, use the Admin Configure view to edit, validate, publish, or roll back
persisted revisions without restarting. Demo member seeding is skipped when a
custom program is loaded.

### Self-Hosting Configuration ⚙️

The default Compose service runs the reference server and Admin dashboard on
port `3210` and stores SQLite state in the named `lip-data` volume. Configure
runtime values with environment variables:

```bash
LIP_API_KEY="replace-with-a-long-local-key"
LIP_PORT=3210
LIP_SEED_DEMO=true
LIP_RATE_LIMIT_REQUESTS=120
LIP_RATE_LIMIT_WINDOW_MS=60000
LIP_STRUCTURED_LOGS=true
docker compose up --build
```

For the Postgres-backed profile, run `docker compose --profile postgres up
--build`; its API defaults to port `3211`. See
[PostgreSQL production storage](docs/postgres.md).

To run the managed-service control-plane foundation on port `3220`, set a
`LIP_CLOUD_API_KEY` of at least 16 characters and run `docker compose --profile
cloud up --build`. See [Cloud control plane](docs/cloud.md).

Moving a self-hosted program to another LIP host? Follow
[MIGRATION.md](MIGRATION.md). The migration archive preserves members,
balances, immutable ledger history, open reservations, and idempotency records.

Authenticated protocol requests are limited per remote client. Responses
include `RateLimit-*` headers and return RFC 9457 problem details with HTTP 429
when exhausted. The CLI and container emit one JSON `http_request` record per
response without logging API keys or request bodies. The authenticated
`/metrics` endpoint exports request counts and duration summaries in Prometheus
text format.

> [!NOTE]
> The Postgres protocol runtime coordinates engine mutations across instances,
> and the full Admin service suite runs on tenant-scoped Postgres stores.
> Multi-location deployments get a per-tenant location registry, Admin
> users/API keys scoped with `allowed_location_ids`, and per-location
> reporting at `/admin/api/v1/reports/locations`. Location-scoped principals
> fail closed: tenant-wide admin reads (snapshot, analytics, member exports)
> return 403 for them — location-filtered variants of those views are
> follow-up work. Franchise funding-share settlement math is not
> implemented yet.

### Install from npm 📦

All packages are published to npm with provenance under the
[`@loyalty-interchange`](https://www.npmjs.com/org/loyalty-interchange) scope.
Run the sandbox without cloning:

```bash
npx @loyalty-interchange/cli serve
```

Or add the SDK to your app:

```bash
npm install @loyalty-interchange/sdk
```

See [the release guide](docs/releasing.md) for how releases are cut and verified.

## Project Structure 🗂️

```text
|-- apps/
|   |-- admin/              # Browser Admin dashboard
|   `-- cloud/              # Managed Cloud control plane and management API
|-- docs/                   # Developer guides and API documentation
|-- examples/
|   `-- typescript/         # Runnable SDK lifecycle examples
|-- packages/
|   |-- cli/                # CLI: serve, quickstart, validation, doctor, conformance
|   |-- identity/           # External OIDC validation and customer/member mapping
|   |-- protocol/           # TypeScript types, schemas, validation, protocol contracts
|   |-- reference/          # Deterministic loyalty engine and Admin snapshot model
|   |-- sdk/                # Domain SDK and generated low-level OpenAPI client
|   |-- server/             # Reference HTTP server and non-normative Admin API
|   |-- storage/            # Storage adapter interface
|   |-- storage-postgres/   # Normalized Postgres adapter, migrations, locks, leases
|   `-- storage-sqlite/     # Durable SQLite adapter for local and single-node use
|-- scripts/                # Spec, SDK, examples, and package verification scripts
|-- spec/                   # Normative prose, OpenAPI, generated schemas, and examples
`-- tests/                  # Unit, integration, and black-box conformance tests
```

## Tech Stack 🧱

- **Language:** TypeScript on Node.js 20.19+
- **Frontend:** React, Vite, Tailwind CSS, lucide-react
- **API:** Node HTTP server with OpenAPI 3.1 contract
- **Cloud:** Separate Node management API with PostgreSQL control-plane state
- **Validation:** JSON Schema Draft 2020-12 via TypeBox
- **SDK:** Handwritten domain client plus generated low-level OpenAPI client
- **Storage:** SQLite sandbox or normalized, tenant-scoped PostgreSQL
- **Testing:** Vitest and black-box HTTP conformance tests
- **Packaging:** npm (`@loyalty-interchange/*`, published with provenance) and Docker

## Common Commands 🧑‍💻

```bash
npm start             # Start the local sandbox and Admin dashboard
npm run serve         # Same sandbox path with the public command name
npm run lip -- doctor # Check discovery, health, auth, and capabilities
npm run lip -- test   # Run baseline HTTP conformance checks
npm run lip -- schemas                 # List supported JSON schemas
npm run lip -- validate spec/examples/paid-order.json --schema FoodserviceOrder
npm run example:sdk   # Run the full TypeScript SDK lifecycle
npm run typecheck     # Type-check all packages and Admin app
npm test              # Run the full test suite
npm run build         # Build TypeScript packages and Admin assets
npm run generate      # Regenerate schemas, OpenAPI, and SDK client
npm run verify        # Full local verification pipeline
```

## Documentation 📚

Full docs site: **[loyalty-interchange.mintlify.app](https://loyalty-interchange.mintlify.app)**

Developer guides (rendered on the docs site; sources live in [`docs/`](docs/README.md)):

- [Quickstart](https://loyalty-interchange.mintlify.app/get-started/quickstart) — validation, Docker, reset, seed, and conformance details
- [Essentials](https://loyalty-interchange.mintlify.app/get-started/essentials) — the six things every new integrator needs to know
- [TypeScript SDK](https://loyalty-interchange.mintlify.app/guides/typescript-sdk) — SDK operations, errors, money helpers, and order builder
- [Webhooks](https://loyalty-interchange.mintlify.app/guides/webhooks) — signed CloudEvents after every successful mutation, with a durable retry outbox
- [Customer identity](https://loyalty-interchange.mintlify.app/guides/customer-identity) — connect an already-authenticated customer to a program-scoped LIP member
- [Reference platform](https://loyalty-interchange.mintlify.app/guides/reference-platform) — server, Admin, storage, and implementation boundaries
- [PostgreSQL storage](https://loyalty-interchange.mintlify.app/guides/postgres) — multi-instance engine store, location scoping, and the lock-free report path
- [Cloud control plane](https://loyalty-interchange.mintlify.app/guides/cloud) — organizations, projects, environments, provisioning, operator auth, and metering
- [Punchh migration](https://loyalty-interchange.mintlify.app/guides/punchh-migration) — mapping restaurant loyalty capabilities to vendor-neutral LIP contracts

Repo-only docs (no published page):

- [Getting started](docs/getting-started.md) — shortest path from clone to working request
- [API endpoints](docs/api-endpoints.md) — routes, auth, examples, errors, retries, and webhooks
- [Engagement](docs/engagement.md) — segments, campaigns, exports, and messaging jobs
- [Releasing](docs/releasing.md) — release process for maintainers

Normative specification (canonical when docs and generated artifacts disagree):

- [Spec overview](spec/README.md)
- [Core protocol](spec/core.md)
- [Lifecycle rules](spec/lifecycle.md)
- [Account experience](spec/account-experience.md)
- [Foodservice profile](spec/profiles/foodservice.md)
- [Webhooks](spec/webhooks.md)
- [OpenAPI](spec/openapi.yaml)
- [Generated JSON Schemas](spec/schemas)

## What's Next? 🌟

Current priorities are tracked in [PLAN.md](PLAN.md). Near-term focus:

- Minimal developer onboarding
- Program-as-code configuration drafts with validation, preview, publish, and rollback
- Reward wallet and reward management APIs
- Webhook subscription management
- Cloud provisioning worker, direct OIDC validation, and Stripe billing adapter
- More SDK examples and machine-readable docs

## Contributing 🤝

Contributions are welcome! Start with [CONTRIBUTING.md](CONTRIBUTING.md), run `npm run verify` before opening a pull request, and keep protocol changes backed by schemas, examples, and conformance tests.

## Security 🛡️

If you believe you've found a security vulnerability, please follow the responsible disclosure process in [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License 📜

This project is licensed under [Apache-2.0](LICENSE).

## Support 💬

If you have any questions, suggestions, or need assistance, please [open an issue](https://github.com/craveup/opensource-loyalty/issues) — let's build open loyalty infrastructure together! 💪
