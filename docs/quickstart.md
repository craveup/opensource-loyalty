# Five-minute quickstart

This guide starts the stateful foodservice reference environment, validates a
restaurant order, creates a member, and runs baseline conformance checks.

If this is your first time in the repo, start with
[Getting started](getting-started.md). This page adds validation, Docker, reset,
and conformance details.

Canonical source: [`craveup/opensource-loyalty`](https://github.com/craveup/opensource-loyalty).

## 1. Install and start

Use npm for source installs. This repo uses npm workspaces and
`package-lock.json`; pnpm is not the supported package manager unless the repo
is intentionally migrated later.

```sh
npm install
npm start
```

Keep that terminal open. It prints the Admin URL and `Admin/API key`. The
default server is `http://127.0.0.1:3210`, and the default development key is
`lip-dev-key`. Quickstart creates
`.lip/reference.db`, seeds six synthetic members, and preserves all subsequent
activity across restarts.

Open `http://127.0.0.1:3210/admin/` and sign in with the printed Admin/API key
to inspect account balances, tiers, expiring points, ledger history, program
configuration, and storage status.

The same runtime serves the non-normative customer engagement API at
`http://127.0.0.1:3210/platform/v1`. Docker also starts a visibly synthetic
reference guest wallet at `http://127.0.0.1:3230/`.

Docker is an equivalent start path:

```sh
docker compose up --build
```

The Compose service stores its SQLite database in the named `lip-data` volume.
Use `docker compose logs lip` to see the Admin/API key after the container is
running.

## 2. Check the environment

In a second terminal:

```sh
npm run lip -- doctor
```

All discovery, health, authentication, and capability checks should pass.

## 3. Validate a restaurant order

```sh
npm run lip -- validate spec/examples/paid-order.json --schema FoodserviceOrder
```

Validation errors include a JSON path and the failed rule. Run
`npm run lip -- schemas` to list every available schema.

## 4. Enroll a member

```sh
curl --fail-with-body \
  -X POST http://127.0.0.1:3210/lip/v1/members/enroll \
  -H 'Authorization: Bearer lip-dev-key' \
  -H 'Content-Type: application/json' \
  --data-binary @spec/examples/enroll-request.json
```

The response contains `member-001` and an initial points balance.

## 5. Run baseline conformance

```sh
npm run lip -- test
```

The command checks discovery, health, authenticated capabilities, unauthenticated
mutation rejection, and RFC 9457 validation errors. It exits nonzero when any
check fails, so the same command can run in CI.

## Configuration

Create a project-local configuration with:

```sh
npm run lip -- init
```

`lip.config.json` stores the base URL, profile, program id, and the environment
variable name that contains the API key. It does not store a production secret.

## Reset and seed controls

State is durable by default. Start from a new seeded database with:

```sh
npm run lip -- quickstart --reset
```

Start with no synthetic members or activity with:

```sh
npm run lip -- quickstart --reset --no-seed
```

Use `--database <path>` to select another SQLite file. `LIP_DATABASE_PATH`
provides the default path for CLI and container starts.

The Admin API and application are reference-platform conveniences, not part of
the normative LIP HTTP contract. See [Reference platform](reference-platform.md)
for the package and security boundaries.
