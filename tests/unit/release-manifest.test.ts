import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  manifestDigest,
  validateLipReleaseManifest,
  type LipReleaseManifestV1
} from "../../scripts/check-release-manifest.js";
import {
  deployedMigrationPaths,
  generateLipReleaseManifest,
  migrationSetSha256,
  normalizeRepository,
  parseNpmPack,
  type ReleaseArtifactInputs
} from "../../scripts/generate-release-manifest.js";

const root = resolve(import.meta.dirname, "../..");
const examplePath = resolve(root, "docs/releases/lip-release-manifest.example.json");
const schemaPath = resolve(root, "docs/releases/lip-release-manifest.schema.json");

function exampleManifest(): LipReleaseManifestV1 {
  return validateLipReleaseManifest(JSON.parse(readFileSync(examplePath, "utf8")) as unknown);
}

describe("LIP release manifest", () => {
  it("validates the checked-in example and produces a deterministic digest", () => {
    const manifest = exampleManifest();
    const reversed = Object.fromEntries(Object.entries(manifest).reverse()) as unknown;

    expect(validateLipReleaseManifest(manifest)).toEqual(manifest);
    expect(manifestDigest(validateLipReleaseManifest(reversed))).toBe(manifestDigest(manifest));
    expect(canonicalJson(manifest)).toMatch(/"schemaVersion": 1/);
  });

  it("rejects mutable source references", () => {
    const manifest = exampleManifest();

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        source: { ...manifest.source, commit: "main" }
      })
    ).toThrow(/source\.commit/);

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        source: { ...manifest.source, tag: "latest" }
      })
    ).toThrow(/source\.tag/);
  });

  it("requires direct database connection mode for current session leases", () => {
    const manifest = exampleManifest();

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        database: { ...manifest.database, connectionMode: "pooled" }
      })
    ).toThrow(/database\.connectionMode/);
  });

  it("rejects unapproved high or critical dependency findings", () => {
    const manifest = exampleManifest();

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          findings: { ...manifest.dependencies.findings, unapprovedHigh: 1 }
        }
      })
    ).toThrow(/unapprovedHigh/);

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          findings: { ...manifest.dependencies.findings, unapprovedCritical: 1 }
        }
      })
    ).toThrow(/unapprovedCritical/);
  });

  it("requires package integrities and digest-pinned image provenance", () => {
    const manifest = exampleManifest();

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        packages: [{ ...manifest.packages[0], integrity: "" }]
      })
    ).toThrow(/packages\[0\]\.integrity/);

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        packages: [{ ...manifest.packages[0], integrity: "sha512-abc=" }]
      })
    ).toThrow(/canonical SHA-512 digest/);

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        image: { ...manifest.image, reference: "ghcr.io/craveup/opensource-loyalty:latest" }
      })
    ).toThrow(/image\.reference/);

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        image: {
          ...manifest.image,
          digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
        }
      })
    ).toThrow(/image\.reference must be pinned to image\.digest/);
  });

  it("rejects placeholders in release evidence", () => {
    const manifest = exampleManifest();

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        verification: { ...manifest.verification, runUrl: "https://github.com/TODO/run" }
      })
    ).toThrow(/placeholder/);
  });

  it("rejects unknown manifest fields", () => {
    const manifest = exampleManifest();

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        extra: true
      })
    ).toThrow(/manifest\.extra/);

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          findings: { ...manifest.dependencies.findings, note: "approved later" }
        }
      })
    ).toThrow(/dependencies\.findings\.note/);
  });

  it("requires the complete published package set", () => {
    const manifest = exampleManifest();

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        packages: manifest.packages.slice(0, -1)
      })
    ).toThrow(/packages must include @loyalty-interchange\/mcp/);

    expect(() =>
      validateLipReleaseManifest({
        ...manifest,
        packages: [
          ...manifest.packages.slice(1),
          { ...manifest.packages[0], name: "@loyalty-interchange/admin" }
        ]
      })
    ).toThrow(/published package names/);
  });

  it("binds the canonical repository, tag, and every package version", () => {
    const manifest = exampleManifest();

    expect(() => validateLipReleaseManifest({
      ...manifest,
      source: { ...manifest.source, repository: "someone/fork" }
    })).toThrow(/source\.repository/);
    expect(() => validateLipReleaseManifest({
      ...manifest,
      source: { ...manifest.source, tag: "v0.2.1" }
    })).toThrow(/must match release tag 0\.2\.1/);
    expect(() => validateLipReleaseManifest({
      ...manifest,
      packages: [
        { ...manifest.packages[0], version: "0.2.1" },
        ...manifest.packages.slice(1)
      ]
    })).toThrow(/must match release tag 0\.2\.0/);
  });

  it("publishes the semantic validator requirement with the JSON Schema", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      $comment?: string;
      properties?: { image?: { description?: string } };
    };

    expect(schema.$comment).toMatch(/semantic validator/);
    expect(schema.properties?.image?.description).toMatch(/image\.reference is pinned to image\.digest/);
  });

  it("normalizes supported GitHub remote URLs", () => {
    expect(normalizeRepository("https://github.com/craveup/opensource-loyalty.git")).toBe(
      "craveup/opensource-loyalty"
    );
    expect(normalizeRepository("git@github.com:craveup/opensource-loyalty.git")).toBe(
      "craveup/opensource-loyalty"
    );
  });

  it("parses npm pack integrity evidence", () => {
    expect(parseNpmPack(JSON.stringify([
      {
        name: "@loyalty-interchange/sdk",
        version: "0.1.2",
        integrity: "sha512-abc="
      }
    ]), "@loyalty-interchange/sdk")).toEqual({
      name: "@loyalty-interchange/sdk",
      version: "0.1.2",
      integrity: "sha512-abc="
    });
  });

  it("includes every deployed SQL migration in the migration-set digest", async () => {
    await expect(deployedMigrationPaths(root)).resolves.toEqual([
      "apps/cloud/migrations/001_control_plane.sql",
      "apps/cloud/migrations/002_identity_memberships.sql",
      "apps/cloud/migrations/003_customer_identity.sql",
      "apps/cloud/migrations/004_environment_key_fingerprint.sql",
      "apps/cloud/migrations/005_operators.sql",
      "packages/storage-postgres/migrations/001_normalized_engine.sql"
    ]);
  });

  it("generates a valid manifest from collected release evidence", async () => {
    const manifest = exampleManifest();
    const artifacts: ReleaseArtifactInputs = {
      imageReference: manifest.image.reference,
      imageDigest: manifest.image.digest,
      imageProvenanceUrl: manifest.image.provenanceUrl,
      auditReportSha256: manifest.dependencies.auditReportSha256,
      sbomSha256: manifest.dependencies.sbomSha256,
      riskRegisterSha256: manifest.dependencies.riskRegisterSha256,
      findings: manifest.dependencies.findings,
      verificationRunUrl: manifest.verification.runUrl,
      conformanceReportSha256: manifest.verification.conformanceReportSha256
    };

    const generated = await generateLipReleaseManifest({
      root,
      artifacts,
      collectors: {
        collectPackages: async () => manifest.packages,
        git: async (args) => {
          if (args.join(" ") === "rev-parse HEAD") return `${manifest.source.commit}\n`;
          if (args.join(" ") === "tag --points-at HEAD") return `${manifest.source.tag}\n`;
          if (args.join(" ") === "remote get-url origin") return "https://github.com/craveup/opensource-loyalty.git\n";
          throw new Error(`unexpected git args ${args.join(" ")}`);
        },
        npm: async (args) => {
          if (args.join(" ") === "--version") return `${manifest.dependencies.toolchain.npm}\n`;
          throw new Error(`unexpected npm args ${args.join(" ")}`);
        }
      }
    });

    expect(generated.source).toEqual(manifest.source);
    expect(generated.database.migrationSetSha256).toBe(await migrationSetSha256(root));
    expect(generated.protocol.openapiSha256).toBe(manifest.protocol.openapiSha256);
  });
});
