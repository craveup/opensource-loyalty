import { describe, expect, it } from "vitest";
import {
  assertIndependentDeploymentDatabases,
  databaseIdentityFingerprint,
  managedDatabaseConfiguration
} from "./database-configuration.js";

const direct = (name: string) =>
  `postgresql://loyalty:secret@ep-${name}.us-west-2.aws.neon.tech/loyalty?sslmode=require`;

describe("managed database configuration", () => {
  it("requires the managed database URL", () => {
    expect(() => managedDatabaseConfiguration({})).toThrow("LIP_CLOUD_DATABASE_URL");
  });

  it("defaults the data plane to the same database", () => {
    // One managed environment, one Neon database. Making an operator set the
    // same URL twice was a way to get it wrong, not a safeguard.
    expect(managedDatabaseConfiguration({ LIP_CLOUD_DATABASE_URL: direct("sandbox") })).toEqual({
      controlPlaneUrl: direct("sandbox"),
      dataPlaneUrl: direct("sandbox")
    });
  });

  it("still honours an explicitly separate self-hosted data plane", () => {
    expect(managedDatabaseConfiguration({
      LIP_CLOUD_DATABASE_URL: direct("control"),
      LIP_CLOUD_DATA_PLANE_DATABASE_URL: direct("data")
    })).toEqual({
      controlPlaneUrl: direct("control"),
      dataPlaneUrl: direct("data")
    });
  });

  it("rejects a pooled data-plane URL even though it is optional", () => {
    expect(() => managedDatabaseConfiguration({
      LIP_CLOUD_DATABASE_URL: direct("sandbox"),
      LIP_CLOUD_DATA_PLANE_DATABASE_URL:
        "postgresql://loyalty:secret@ep-sandbox-pooler.us-west-2.aws.neon.tech/loyalty"
    })).toThrow("LIP_CLOUD_DATA_PLANE_DATABASE_URL");
  });

  it("rejects pooled URLs without leaking credentials", () => {
    const secret = "never-print-this";
    const pooled = `postgresql://loyalty:${secret}@ep-sandbox-pooler.us-west-2.aws.neon.tech/loyalty`;
    expect(() => managedDatabaseConfiguration({
      LIP_CLOUD_DATABASE_URL: pooled,
      LIP_CLOUD_DATA_PLANE_DATABASE_URL: direct("sandbox")
    })).toThrowError(expect.not.stringContaining(secret));
  });

  it("rejects a database reused across sandbox and production", () => {
    const sandbox = { controlPlaneUrl: direct("shared"), dataPlaneUrl: direct("shared") };
    const production = {
      controlPlaneUrl: direct("shared").replace("loyalty:secret", "other-role:other-secret"),
      dataPlaneUrl: direct("production")
    };
    expect(() => assertIndependentDeploymentDatabases({ production, sandbox }))
      .toThrow(/independent databases and roles/i);
  });

  it("fingerprints a database without exposing its role or password", () => {
    const secret = "never-print-this";
    const url = `postgresql://loyalty:${secret}@ep-sandbox.us-west-2.aws.neon.tech/loyalty`;
    const fingerprint = databaseIdentityFingerprint(url);
    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(fingerprint).not.toContain(secret);
    expect(fingerprint).not.toContain("loyalty");
  });

  it("gives one identity per database and different ones across environments", () => {
    // This is what lets an operator prove sandbox and production are separate:
    // neither process can see the other's URL, only publish its own identity.
    expect(databaseIdentityFingerprint(direct("sandbox"))).toBe(
      databaseIdentityFingerprint(direct("sandbox").replace("loyalty:secret", "other:other"))
    );
    expect(databaseIdentityFingerprint(direct("sandbox"))).not.toBe(
      databaseIdentityFingerprint(direct("production"))
    );
  });

  it("accepts both plane variables addressing one environment database", () => {
    // render.yaml points both at the same direct endpoint on purpose; asserting
    // otherwise would refuse to boot either deployment.
    expect(() =>
      managedDatabaseConfiguration({
        LIP_CLOUD_DATABASE_URL: direct("sandbox"),
        LIP_CLOUD_DATA_PLANE_DATABASE_URL: direct("sandbox")
      })
    ).not.toThrow();
  });

  it("accepts independent direct sandbox and production databases", () => {
    expect(() => assertIndependentDeploymentDatabases({
      sandbox: { controlPlaneUrl: direct("sandbox"), dataPlaneUrl: direct("sandbox") },
      production: { controlPlaneUrl: direct("production"), dataPlaneUrl: direct("production") }
    })).not.toThrow();
  });
});
