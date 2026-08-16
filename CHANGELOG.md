# Changelog

## 0.2.0 - 2026-08-15

- Add executable points, visit/stamp, wallet-credit, paid-membership, and hybrid
  programs; versioned program draft/publish/rollback; reward wallets,
  engagement jobs, location scope, funding reports, and the expanded Admin.
- Add normalized tenant-scoped Postgres storage, multi-instance mutation locks,
  scheduler leases, Cloud provisioning/attachment, OIDC and operator auth,
  credential rotation, managed-customer contracts, usage control, and release
  evidence with SBOM, provenance, audit, conformance, and immutable manifests.
- Add `@loyalty-interchange/adapter-kit`, a foodservice edge-case fixture corpus,
  and a runnable server-side ordering BFF.
- Add checksummed member/balance import planning and reconciliation commands.
- Encrypt local Cloud credentials with AES-256-GCM and add atomic local
  suspend, resume, backup, and restore operations.
- Add signed Stripe subscription webhooks and authenticated managed-customer
  HTTP routes outside the normative `/lip/v1` boundary.
- Add a browser-only lifecycle walkthrough, launch/SEO assets, community
  governance, design-partner materials, and explicit product/security metrics.
- Standardize source, CI, and release verification on Node 22.

## 0.1.2 - 2026-07-19

- Add a server-side write-freeze / maintenance switch: freeze all `/lip/v1`
  writes during a cutover window while reads and `/health` stay available.
  Frozen writes return a stable `503 write_frozen` (RFC 9457) with a
  `Retry-After` header. Set it at startup (`lip serve --write-freeze` /
  `LIP_WRITE_FREEZE`) or at runtime via the admin
  `POST /admin/api/v1/maintenance` endpoint; `GET /health` now reports
  `write_frozen`.
- Add `lip cloud-verify`: run doctor and conformance (plus optional member
  expectations) against a deployed Cloud/staging LIP host to gate a cutover.

## 0.1.1 - 2026-07-18

- Fix idempotent replay: a retry that reuses the idempotency key with a
  regenerated `request_id`/`occurred_at` now returns the original result
  (echoing the retry's `request_id`) instead of a false `409` or an SDK
  validation error. Entries stored before this release still match a pinned
  replay (dual-check).

## 0.1.0 - 2026-07-18

- Initial LIP core and foodservice profile.
- TypeScript schema package and deterministic reference engine.
- HTTP reference server and conformance suite.
- Program, tier, reward, account-summary, and cursor-based ledger read models.
- Generated and idiomatic TypeScript clients for the account experience operations.
- Configurable earning policies for minimum spend, channels, exclusions, and rounding.
- Annual tier qualification windows, tier multipliers, and original-rate refund attribution.
- Earned-date point lots with FIFO consumption, reversal restoration, expiring
  balance buckets, and source-linked expiration ledger entries.
- Versioned reference-engine snapshots with program-fingerprint validation.
- Pluggable state-store contract and a durable SQLite implementation.
- Seeded foodservice reference platform with restart-safe local and Docker state.
- Authenticated read-only Admin API and responsive Admin application for program,
  member, tier, expiration, ledger, and developer inspection.
