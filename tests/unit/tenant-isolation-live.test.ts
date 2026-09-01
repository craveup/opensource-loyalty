import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  PostgresMigrator,
  TENANT_RUNTIME_ROLE,
  assertTenantIsolationEnforced,
  createPostgresPool,
  withTenantTransaction
} from "@loyalty-interchange/storage-postgres";

/**
 * The isolation guarantee, checked against a real Postgres.
 *
 * Static assertions on the migration SQL cannot answer whether row-level
 * security actually filters. That depends on an attribute of the connecting
 * role, and when it is wrong every query still succeeds -- it just returns
 * other tenants' rows. This suite writes rows as one tenant and tries to read
 * and overwrite them as another, which is the only way the failure shows up.
 *
 * Skipped without LIP_TEST_POSTGRES_URL so the ordinary local run stays
 * database-free; CI provides one.
 */
const postgresUrl = process.env["LIP_TEST_POSTGRES_URL"];
const live = postgresUrl ? describe : describe.skip;

live("tenant isolation against a live Postgres", () => {
  let pool: Pool;
  const alpha = `isolation-alpha-${randomUUID()}`;
  const beta = `isolation-beta-${randomUUID()}`;
  const stateKey = `isolation-${randomUUID()}`;

  /** A transaction that assumes the runtime role but declares no tenant. */
  const withoutTenant = async <T>(run: (client: PoolClient) => Promise<T>): Promise<T> =>
    withTenantTransaction(pool, "placeholder", async (client) => {
      await client.query("SELECT set_config('lip.tenant_id', '', true)");
      return run(client);
    });

  const write = (tenantId: string): Promise<unknown> =>
    withTenantTransaction(pool, tenantId, (client) =>
      client.query(`
        INSERT INTO lip_platform_state (tenant_id, state_key, value, revision, updated_at)
        VALUES ($1, $2, $3::jsonb, 1, now())
      `, [tenantId, stateKey, JSON.stringify({ owner: tenantId })]));

  // Generous: the first connection may also be applying migrations, and a
  // hosted database is a network round trip away rather than a local socket.
  beforeAll(async () => {
    pool = createPostgresPool({ connectionString: postgresUrl! });
    await new PostgresMigrator(pool).migrate();
    await write(alpha);
    await write(beta);
  }, 60_000);

  afterAll(async () => {
    for (const tenant of [alpha, beta]) {
      await withTenantTransaction(pool, tenant, (client) =>
        client.query("DELETE FROM lip_platform_state WHERE tenant_id = $1", [tenant]))
        .catch(() => undefined);
    }
    await pool.end();
  }, 60_000);

  it("applies the migrations repeatably", async () => {
    await new PostgresMigrator(pool).migrate();
    const applied = await pool.query<{ name: string }>(
      "SELECT name FROM lip_schema_migrations ORDER BY version"
    );
    expect(applied.rows.map((row) => row.name)).toEqual([
      "normalized_engine",
      "tenant_isolation",
      "tenant_runtime_role"
    ]);
  });

  it("enables and forces row-level security on every tenant-scoped table", async () => {
    const tables = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      -- relkind 'r': ordinary tables. pg_class also holds this schema's
      -- indexes, which carry relrowsecurity = false and are not the subject.
      WHERE relkind = 'r'
        AND (relname LIKE 'lip_engine_%' OR relname = 'lip_platform_state')
    `);
    expect(tables.rows.length).toBeGreaterThan(0);
    // FORCE is the load-bearing half: the service connects as the table owner.
    expect(tables.rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity)).toEqual([]);
  });

  it("defines a runtime role that cannot bypass row-level security", async () => {
    const role = await pool.query<{ rolbypassrls: boolean; rolcanlogin: boolean }>(
      "SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1",
      [TENANT_RUNTIME_ROLE]
    );
    expect(role.rows[0]).toMatchObject({ rolbypassrls: false, rolcanlogin: false });
  });

  it("reports isolation as enforced from the startup probe", async () => {
    const status = await assertTenantIsolationEnforced(pool);
    expect(status.enforced).toBe(true);
    expect(status.runtime_role_available).toBe(true);
  });

  it("shows a tenant only its own rows, with no tenant predicate at all", async () => {
    const rows = await withTenantTransaction(pool, alpha, (client) =>
      client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM lip_platform_state WHERE state_key = $1",
        [stateKey]
      ));
    expect(rows.rows.map((row) => row.tenant_id)).toEqual([alpha]);
  });

  it("returns nothing for an explicit cross-tenant predicate", async () => {
    // Even naming the other tenant outright does not reach its row.
    const rows = await withTenantTransaction(pool, alpha, (client) =>
      client.query("SELECT 1 FROM lip_platform_state WHERE tenant_id = $1", [beta]));
    expect(rows.rowCount).toBe(0);
  });

  it("returns nothing for a request that declares no tenant", async () => {
    const rows = await withoutTenant((client) =>
      client.query("SELECT 1 FROM lip_platform_state WHERE state_key = $1", [stateKey]));
    expect(rows.rowCount).toBe(0);
  });

  it("refuses a write attributed to another tenant", async () => {
    await expect(
      withTenantTransaction(pool, alpha, (client) =>
        client.query(`
          INSERT INTO lip_platform_state (tenant_id, state_key, value, revision, updated_at)
          VALUES ($1, $2, '{}'::jsonb, 1, now())
        `, [beta, `forged-${randomUUID()}`]))
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a write from a request that declares no tenant", async () => {
    await expect(
      withoutTenant((client) =>
        client.query(`
          INSERT INTO lip_platform_state (tenant_id, state_key, value, revision, updated_at)
          VALUES ($1, $2, '{}'::jsonb, 1, now())
        `, [alpha, `unscoped-${randomUUID()}`]))
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update or delete another tenant's row", async () => {
    const updated = await withTenantTransaction(pool, alpha, (client) =>
      client.query("UPDATE lip_platform_state SET revision = 99 WHERE tenant_id = $1", [beta]));
    expect(updated.rowCount).toBe(0);
    const deleted = await withTenantTransaction(pool, alpha, (client) =>
      client.query("DELETE FROM lip_platform_state WHERE tenant_id = $1", [beta]));
    expect(deleted.rowCount).toBe(0);
    // The row is still there, seen by its owner.
    const survivor = await withTenantTransaction(pool, beta, (client) =>
      client.query("SELECT 1 FROM lip_platform_state WHERE state_key = $1", [stateKey]));
    expect(survivor.rowCount).toBe(1);
  });

  it("does not leak the tenant scope past the transaction that set it", async () => {
    await withTenantTransaction(pool, alpha, async () => undefined);
    const after = await pool.query<{ scope: string | null }>(
      "SELECT current_setting('lip.tenant_id', true) AS scope"
    );
    expect(after.rows[0]?.scope ?? "").toBe("");
  });
});
