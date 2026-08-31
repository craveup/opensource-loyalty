import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import {
  PostgresEngineRepository,
  PostgresJsonStateStore,
  withTenantTransaction
} from "./index.js";

const SCOPED_TABLES = [
  "lip_platform_state",
  "lip_engine_states",
  "lip_engine_members",
  "lip_engine_identities",
  "lip_engine_balances",
  "lip_engine_reservations",
  "lip_engine_ledger",
  "lip_engine_balance_lots",
  "lip_engine_lot_consumptions",
  "lip_engine_idempotency",
  "lip_engine_accruals",
  "lip_engine_adjustments",
  "lip_engine_redemptions",
  "lip_engine_issued_rewards"
] as const;

interface RecordedQuery {
  text: string;
  values: readonly unknown[];
}

/**
 * A pool that records what was asked of it and answers nothing.
 *
 * The point is not to simulate Postgres; it is to observe the *shape* of every
 * conversation the stores have with it. A query that reaches the socket outside
 * a tenant-scoped transaction would read past row-level security in production,
 * and this is where that regression shows up.
 */
function recordingPool(): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client = {
    query: (text: string, values: readonly unknown[] = []) => {
      queries.push({ text: typeof text === "string" ? text.trim() : String(text), values });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => undefined,
    on: () => undefined,
    removeListener: () => undefined
  } as unknown as PoolClient;
  const pool = {
    connect: () => Promise.resolve(client),
    query: (text: string, values: readonly unknown[] = []) => {
      queries.push({ text: `UNSCOPED ${String(text).trim()}`, values });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    end: () => Promise.resolve()
  } as unknown as Pool;
  return { pool, queries };
}

/** Every transaction in the recording, each as its ordered list of statements. */
function transactions(queries: RecordedQuery[]): RecordedQuery[][] {
  const groups: RecordedQuery[][] = [];
  let current: RecordedQuery[] | undefined;
  for (const query of queries) {
    if (query.text === "BEGIN") {
      current = [];
      groups.push(current);
      continue;
    }
    if (query.text === "COMMIT" || query.text === "ROLLBACK") {
      current = undefined;
      continue;
    }
    current?.push(query);
  }
  return groups;
}

function expectEveryStatementScoped(queries: RecordedQuery[], tenantId: string): void {
  // Nothing may bypass a transaction: an unscoped pool.query carries no
  // transaction-local setting and would therefore carry no tenant.
  expect(queries.filter((query) => query.text.startsWith("UNSCOPED"))).toEqual([]);
  const opened = transactions(queries);
  expect(opened.length).toBeGreaterThan(0);
  for (const statements of opened) {
    const first = statements[0];
    // The literal `true` is the transaction-local flag; it is inline SQL rather
    // than a parameter, so both halves have to be checked.
    expect(first?.text).toContain("set_config('lip.tenant_id', $1, true)");
    expect(first?.values).toEqual([tenantId]);
  }
}

describe("tenant isolation migration", () => {
  const sql = readFileSync(
    new URL("../migrations/002_tenant_isolation.sql", import.meta.url),
    "utf8"
  );

  it("forces row-level security on every tenant-scoped table", () => {
    for (const table of SCOPED_TABLES) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    // Without FORCE the owning role -- which is the role the service connects
    // as -- bypasses every policy and the isolation is decorative.
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("binds the policy to a transaction-local setting in both directions", () => {
    expect(sql).toContain("USING (tenant_id = lip_current_tenant())");
    expect(sql).toContain("WITH CHECK (tenant_id = lip_current_tenant())");
    // NULLIF makes an empty GUC indistinguishable from an unset one, and
    // `tenant_id = NULL` filters every row rather than matching any.
    expect(sql).toContain("NULLIF(current_setting('lip.tenant_id', true), '')");
  });

  it("leaves the control-plane and migration tables unscoped", () => {
    expect(sql).not.toContain("lip_cloud_");
    expect(sql).not.toContain("lip_schema_migrations");
  });
});

describe("withTenantTransaction", () => {
  it("sets the tenant for the transaction only, before any other statement", async () => {
    const { pool, queries } = recordingPool();
    await withTenantTransaction(pool, "tenant-alpha", async (client) => {
      await client.query("SELECT 1");
    });
    expect(queries.map((query) => query.text)).toEqual([
      "BEGIN",
      "SELECT set_config('lip.tenant_id', $1, true)",
      "SELECT 1",
      "COMMIT"
    ]);
    expect(queries[1]?.values).toEqual(["tenant-alpha"]);
  });

  it("rolls back rather than leaving the scope set on a pooled connection", async () => {
    const { pool, queries } = recordingPool();
    await expect(
      withTenantTransaction(pool, "tenant-alpha", async () => {
        throw new Error("operation failed");
      })
    ).rejects.toThrow("operation failed");
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses an empty tenant instead of opening an unscoped transaction", async () => {
    const { pool, queries } = recordingPool();
    await expect(withTenantTransaction(pool, "  ", async () => undefined)).rejects.toThrow(
      /tenant id is required/i
    );
    expect(queries).toEqual([]);
  });
});

describe("tenant-scoped stores", () => {
  it("scopes every JSON state read, write and clear", async () => {
    const { pool, queries } = recordingPool();
    const store = new PostgresJsonStateStore<{ value: number }>({
      pool,
      tenantId: "tenant-alpha",
      key: "campaigns"
    });
    await store.load();
    await store.save({ value: 1 });
    await store.clear();
    expectEveryStatementScoped(queries, "tenant-alpha");
  });

  it("scopes every engine read, write and clear", async () => {
    const { pool, queries } = recordingPool();
    const repository = new PostgresEngineRepository({
      pool,
      tenantId: "tenant-alpha",
      programId: "program-alpha"
    });
    await repository.load();
    await repository.save(
      new LoyaltyEngine({
        program_id: "program-alpha",
        currency: "USD",
        earn_rate: { points: 0, spend_minor_units: 100 },
        evaluation_ttl_seconds: 300,
        reservation_ttl_seconds: 120,
        rewards: []
      }).exportState()
    );
    await repository.clear();
    expectEveryStatementScoped(queries, "tenant-alpha");
  });
});
