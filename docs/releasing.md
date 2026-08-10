# Releasing npm packages

All ten `@loyalty-interchange/*` workspaces are configured as public packages
with provenance, repository metadata, Node.js requirements, and restricted
`dist` package contents. The first release (v0.1.0) shipped through this
pipeline with provenance attestations.

## One-time npm setup

1. Create or claim the `@loyalty-interchange` npm organization.
2. For each package, configure npm trusted publishing for this GitHub
   repository and `.github/workflows/release.yml`.
3. Protect the GitHub `npm` environment with required reviewers.

No long-lived npm token is required. The workflow uses GitHub OIDC and npm
provenance.

## Verify without publishing

Run the **Publish npm packages** workflow manually with `dry_run` enabled, or:

```sh
npm ci
npm run verify
npm run spec:check
npm run release:manifest:check
npm run test:packages
```

## Release manifest evidence

Every release candidate carries a LIP release manifest. The manifest pins the
source commit and tag, OpenAPI digest, ordered Postgres migration-set digest,
package versions and npm SRI values, OCI image digest and provenance URL,
dependency evidence hashes, direct database connection mode, and conformance
run evidence.

The checked-in example must always validate:

```sh
npm run release:manifest:check
```

Generate a release manifest only from release artifacts. The generator derives
Git commit, release tag, repository, OpenAPI SHA-256, migration-set SHA-256,
package integrities, lockfile hash, Node version, and npm version from the
checkout and toolchain. The remaining values come from release artifacts through
flags or matching environment variables:

```sh
npm run release:manifest -- \
  --out docs/releases/lip-release-manifest.generated.json \
  --image-reference ghcr.io/craveup/opensource-loyalty@sha256:<digest> \
  --image-digest sha256:<digest> \
  --image-provenance-url https://github.com/craveup/opensource-loyalty/actions/runs/<run>/attestations/sha256:<digest> \
  --audit-report-sha256 <64 lowercase hex> \
  --sbom-sha256 <64 lowercase hex> \
  --risk-register-sha256 <64 lowercase hex> \
  --moderate <count> \
  --high <count> \
  --critical <count> \
  --unapproved-high 0 \
  --unapproved-critical 0 \
  --verification-run-url https://github.com/craveup/opensource-loyalty/actions/runs/<run> \
  --conformance-report-sha256 <64 lowercase hex>
```

Do not hand-edit generated manifests to make evidence line up. If the generator
cannot derive an exact source tag, package integrity, image digest, dependency
hash, or conformance digest, the release is missing evidence and must stop.

Current session-advisory-lease paths require direct database connections, so
`database.connectionMode` is intentionally fixed to `direct`. A transaction
pooler release requires a separately approved lease redesign and conformance
proof before this manifest contract changes.

## Publish

Bump changed package versions and internal dependency ranges together, then
publish a GitHub release. The release workflow verifies the repository and
publishes packages in dependency order.

Publishing is intentionally not performed from a developer laptop. A failed
package stops the workflow to avoid silently producing a partially ordered
release.
