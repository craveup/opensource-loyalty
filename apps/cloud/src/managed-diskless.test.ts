import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The managed runtime's whole point is that a container is disposable. That is
 * a property of what the code *does not do*, which no behavioural test can
 * observe once a disk happens to be present: everything passes on a machine
 * with a writable filesystem, and the deployment breaks on the one without.
 *
 * These are source-level assertions instead. They fail the moment a managed
 * module reaches for the filesystem, whether or not the machine running the
 * tests would have tolerated it.
 */
const MANAGED_MODULES = [
  "managed-data-plane.ts",
  "credential-operations.ts",
  "credential-operation-store.ts",
  "bootstrap-program.ts"
] as const;

/** Everything the disk-backed provisioner needed and the managed one must not. */
const RETIRED_CONFIGURATION = [
  "LIP_CLOUD_PROGRAM_DIR",
  "LIP_CLOUD_DATA_DIR",
  "LIP_CLOUD_BACKUP_DIR",
  "LIP_CLOUD_ALLOW_LEGACY_CREDENTIAL_MIGRATION",
  "LIP_CLOUD_DATA_PLANE_HOST",
  "LIP_CLOUD_DATA_PLANE_PUBLIC_HOST",
  "LIP_CLOUD_DATA_PLANE_BASE_PORT"
] as const;

function source(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("managed runtime storage boundary", () => {
  it("imports no filesystem module", () => {
    for (const name of MANAGED_MODULES) {
      expect(source(name), name).not.toMatch(/from "node:fs(?:\/promises)?"/u);
    }
  });

  it("names no program file, credential file, port registry or backup path", () => {
    for (const name of MANAGED_MODULES) {
      const text = source(name);
      expect(text, name).not.toContain("ports.json");
      expect(text, name).not.toContain(".credentials.json");
      expect(text, name).not.toContain("/data");
      // A SQLite database is a file by construction; the managed runtime's
      // tenant state is rows in the shared Postgres.
      expect(text, name).not.toContain("storage-sqlite");
    }
  });

  it("keeps the file-backed provisioner out of the managed path", () => {
    const managed = source("managed-data-plane.ts");
    expect(managed).not.toContain("LocalDataPlaneProvisioner");
    expect(managed).not.toContain("createDemoPlatform");
  });
});

describe("managed startup configuration", () => {
  const cli = source("cli.ts");

  it("selects the managed runtime on the public base URL and refuses ambiguity", () => {
    expect(cli).toContain("LIP_CLOUD_PUBLIC_BASE_URL");
    // Falling back to the file-backed provisioner would write tenant
    // credentials to a filesystem that does not survive a redeploy, so the
    // ambiguous configuration is refused rather than resolved by precedence.
    expect(cli).toMatch(/if \(publicBaseUrl && programDirectory\) \{[\s\S]*?throw new Error/u);
  });

  it("reads no retired filesystem or port configuration in the managed branch", () => {
    // The variables still appear in the standalone branch, which is the point:
    // they are scoped to the deployment mode that actually has a filesystem.
    const managedBranch = cli.slice(
      cli.indexOf("if (publicBaseUrl) {"),
      cli.indexOf("let provisioner: LocalDataPlaneProvisioner")
    );
    expect(managedBranch.length).toBeGreaterThan(0);
    for (const key of RETIRED_CONFIGURATION) {
      expect(managedBranch, key).not.toContain(key);
    }
  });

  it("applies engine migrations at startup rather than relying on a pre-deploy hook", () => {
    // Render Free has no preDeployCommand. A service that depended on one
    // could not run there, and a service that assumed one had run could boot
    // against a schema that does not exist yet.
    expect(cli).toMatch(/await new PostgresMigrator\(managedPool\)\.migrate\(\)/u);
    expect(cli).toMatch(/await controlPlane\.migrate\(\)/u);
  });

  it("restores runtimes before serving and closes them before the listener", () => {
    expect(cli).toContain("await managed.restore()");
    const shutdown = cli.slice(cli.indexOf('for (const signal of ["SIGINT"'));
    expect(shutdown.indexOf("managed?.close()")).toBeLessThan(
      shutdown.indexOf("running.close()")
    );
  });

  it("runs and closes the credential-handoff retention lifecycle", () => {
    expect(cli).toContain("credentials.startHandoffRetentionSweep()");
    const shutdown = cli.slice(cli.indexOf('for (const signal of ["SIGINT"'));
    expect(shutdown.indexOf("credentials?.close()")).toBeGreaterThanOrEqual(0);
    expect(shutdown.indexOf("credentials?.close()")).toBeLessThan(
      shutdown.indexOf("managedPool?.end()")
    );
  });

  it("wires customer enrollment to the selected managed or file-backed runtime", () => {
    expect(cli).toContain("managed!.enrollCustomer");
    expect(cli).not.toMatch(/if \(customerConfigured && !provisioner\) \{/u);
  });
});
