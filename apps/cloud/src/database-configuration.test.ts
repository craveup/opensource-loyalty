import { describe, expect, it } from "vitest";
import {
  assertIndependentDeploymentDatabases,
  managedDatabaseConfiguration
} from "./database-configuration.js";

const direct = (name: string) =>
  `postgresql://loyalty:secret@ep-${name}.us-west-2.aws.neon.tech/loyalty?sslmode=require`;

describe("managed database configuration", () => {
  it("requires both control-plane and data-plane URLs", () => {
    expect(() => managedDatabaseConfiguration({})).toThrow("LIP_CLOUD_DATABASE_URL");
    expect(() => managedDatabaseConfiguration({ LIP_CLOUD_DATABASE_URL: direct("sandbox") }))
      .toThrow("LIP_CLOUD_DATA_PLANE_DATABASE_URL");
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

  it("accepts independent direct sandbox and production databases", () => {
    expect(() => assertIndependentDeploymentDatabases({
      sandbox: { controlPlaneUrl: direct("sandbox"), dataPlaneUrl: direct("sandbox") },
      production: { controlPlaneUrl: direct("production"), dataPlaneUrl: direct("production") }
    })).not.toThrow();
  });
});
