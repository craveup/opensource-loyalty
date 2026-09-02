# Versions, support, and release checklist

## Version matrix

| Surface | Current release | Stability |
| --- | --- | --- |
| GitHub source and evidence | `v0.2.0` | Immutable tag and release evidence |
| npm packages | `0.1.2` for 10 packages; `adapter-kit` unpublished | Pre-1.0; live registry is authoritative |
| GHCR reference platform | `v0.2.0` built, anonymous pull unavailable | Not a public distribution surface |
| Protocol working draft | `0.1.0` | Draft; changes require a protocol proposal |
| Foodservice profile | `foodservice/1.0` request profile | Implemented contract identifier; governed with protocol compatibility |
| Cloud API | `/cloud/v1` | Non-normative preview |
| Adapter certification report | `lip.adapter-certification/1` | Versioned report format |

Before 1.0, a minor package release may add behavior or make a documented
breaking correction. Patch releases fix compatible defects. Protocol draft and
package versions do not advance in lockstep. Public packages use exact internal
versions so one release is tested as a unit.

Community support covers the latest minor release. Security fixes may be
backported when practical, but there is no standing backport promise. Managed
support is contractual and separate.

## Release checklist

1. Confirm a clean branch based on protected `main` and update `CHANGELOG.md`.
2. Run Node 22 `npm ci`, `npm run verify`, `npm run spec:check`,
   `npm run docs:check`, and `npm run release:manifest:check`.
3. Generate audit, SBOM, conformance, image digest, provenance, and immutable
   release-manifest evidence; resolve or explicitly approve dependency risk.
4. Start local landing and Admin listeners, run `npm run test:visual`, and
   inspect the desktop/390px screenshots and lifecycle report it writes under
   `.lip/visual-verification`.

   ```bash
   python3 -m http.server 4187 --bind 127.0.0.1 --directory landing
   npm run quickstart -- --host 127.0.0.1 --port 4188
   npm run test:visual
   ```
5. Merge only after the remote verify check passes.
6. Confirm npm authorization in the protected `npm` environment before creating
   a release. Choose a new unused version, bump every changed package and exact
   internal dependency together, then tag that version at the reviewed merge
   commit and publish the GitHub release. The release workflow publishes packages
   in dependency order and attaches evidence.
7. Confirm npm package versions, docs, landing, image digest, release assets,
   and an anonymous `docker manifest inspect` of the versioned GHCR tag.
8. If any confirmation fails, stop distribution and document the rollback or
   corrective release; never retag a published version. In particular, do not
   move or recreate the existing `v0.2.0` tag to repair its incomplete npm
   publication.

The release job validates `NPM_TOKEN` with `npm whoami` and confirms read-write
access to the existing protocol package before installing dependencies or
building artifacts. Store the token only in the GitHub `npm` environment. A
missing, expired, or incorrectly scoped token must fail this preflight; rotate
it rather than bypassing the gate or moving an existing tag.
