import { describe, expect, it } from "vitest";
import { runSharedClusterMigrations } from "./migrate.js";

const postgresUrl = process.env["LIP_TEST_POSTGRES_URL"];

describe("runSharedClusterMigrations input validation", () => {
  it("rejects an empty control-plane connection string", async () => {
    await expect(runSharedClusterMigrations({ controlPlaneUrl: "  " }))
      .rejects.toThrow("control-plane connection string is required");
  });

  it("rejects non-postgres connection strings", async () => {
    await expect(runSharedClusterMigrations({ controlPlaneUrl: "mysql://nope" }))
      .rejects.toThrow(/PostgreSQL/);
    await expect(runSharedClusterMigrations({
      controlPlaneUrl: "postgres://ok@localhost/db",
      dataPlaneUrl: "file:///tmp/nope"
    })).rejects.toThrow("dataPlaneUrl");
  });
});

describe.skipIf(!postgresUrl)("runSharedClusterMigrations against Postgres", () => {
  it("applies engine and control-plane schemas idempotently", async () => {
    const first = await runSharedClusterMigrations({ controlPlaneUrl: postgresUrl! });
    expect(first).toEqual({
      shared_database: true,
      engine_schema: "applied",
      control_plane_schema: "applied"
    });

    // Second run must be a no-op, not a failure.
    const second = await runSharedClusterMigrations({ controlPlaneUrl: postgresUrl! });
    expect(second.shared_database).toBe(true);

    const { Client } = await import("pg");
    const client = new Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name IN
           ('lip_schema_migrations', 'lip_cloud_schema_migrations',
            'lip_engine_members', 'lip_cloud_environments')`
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        "lip_cloud_environments",
        "lip_cloud_schema_migrations",
        "lip_engine_members",
        "lip_schema_migrations"
      ]);
      const engineVersions = await client.query<{ version: number }>(
        "SELECT version FROM lip_schema_migrations"
      );
      expect(engineVersions.rows.length).toBeGreaterThanOrEqual(1);
      const cloudVersions = await client.query<{ version: number }>(
        "SELECT version FROM lip_cloud_schema_migrations"
      );
      expect(cloudVersions.rows.length).toBeGreaterThanOrEqual(4);
    } finally {
      await client.end();
    }
  }, 90_000);
});
