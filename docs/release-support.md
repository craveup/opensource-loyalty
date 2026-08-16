# Versions, support, and release checklist

## Version matrix

| Surface | Current release | Stability |
| --- | --- | --- |
| npm packages and reference platform | `0.2.0` | Pre-1.0; exact package pins |
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
6. Tag `v0.2.0` at the merge commit and publish the GitHub release. The release
   workflow publishes packages in dependency order and attaches evidence.
7. Confirm npm package versions, docs, landing, image digest, and release assets.
8. If any confirmation fails, stop distribution and document the rollback or
   corrective release; never retag a published version.
