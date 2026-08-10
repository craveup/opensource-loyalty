import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  manifestDigest,
  validateLipReleaseManifest,
  type LipReleaseManifestV1
} from "../../scripts/check-release-manifest.js";

const root = resolve(import.meta.dirname, "../..");
const examplePath = resolve(root, "docs/releases/lip-release-manifest.example.json");

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
        image: { ...manifest.image, reference: "ghcr.io/craveup/opensource-loyalty:latest" }
      })
    ).toThrow(/image\.reference/);
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
});
