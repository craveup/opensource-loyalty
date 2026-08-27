# Self-hosted deployment

The default deployment path is a one-command local evaluation:

```bash
docker compose up --build
```

It starts the API and Admin on port `3210`, a visibly synthetic guest wallet on
`3230`, and durable SQLite state in `lip-data`. This is an evaluation profile,
not a production security posture: replace the development API key, disable
demo seeding, disable wallet demo mode, and configure real identity before any
customer traffic.

## Production checklist

1. Use Node 22 and a pinned image digest built from a reviewed commit.
2. Use a strong secret manager for API, webhook, OIDC, database, and encryption
   credentials. Never put them in Compose files, Git history, build arguments,
   screenshots, or support tickets.
3. Run the Postgres profile for multi-instance serving. Apply migrations before
   traffic and use tenant-scoped credentials.
4. Terminate TLS at a trusted proxy, allow only expected hosts/origins, and keep
   Admin and operator surfaces behind appropriate network controls.
5. Set `LIP_SEED_DEMO=false`, `WALLET_DEMO=false`, and leave
   `LIP_TELEMETRY_ENABLED=false` unless the operator explicitly opts in.
6. Configure OIDC Authorization Code + PKCE for the wallet and replace its
   in-memory session store when multi-instance persistence is required.
7. Back up Postgres and test restore, write-freeze, webhook replay, and rollback
   against a non-production environment.
8. Run `npm run verify`, black-box conformance, adapter certification, and a
   refund/void rehearsal for the exact ordering source before cutover.

See [PostgreSQL storage](postgres.md), [Security and operations](security-and-operations.md),
[Reference wallet](wallet.md), and [self-hosted migration](../MIGRATION.md).
