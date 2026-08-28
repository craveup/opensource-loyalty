import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import {
  PostgresEngineRepository,
  PostgresJsonStateStore,
  assertSessionLeaseCompatibleUrl
} from "@loyalty-interchange/storage-postgres";
import { StateRevisionConflictError } from "@loyalty-interchange/storage";
import { makeEnroll, makeProgram, sequentialIds } from "../fixtures.js";

describe("Postgres storage contract", () => {
  it("ships tenant-scoped normalized migrations", () => {
    const sql = readFileSync(
      new URL("../../packages/storage-postgres/migrations/001_normalized_engine.sql", import.meta.url),
      "utf8"
    );
    for (const table of [
      "lip_engine_members",
      "lip_engine_identities",
      "lip_engine_balances",
      "lip_engine_reservations",
      "lip_engine_ledger",
      "lip_engine_balance_lots",
      "lip_engine_idempotency",
      "lip_engine_issued_rewards",
      "lip_platform_state"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("tenant_id TEXT NOT NULL");
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("validates tenant and state identifiers before connecting", () => {
    expect(() => new PostgresEngineRepository({
      connectionString: "postgres://localhost/lip",
      tenantId: "",
      programId: "program"
    })).toThrowError(/tenant id and program id/);
    expect(() => new PostgresJsonStateStore({
      connectionString: "postgres://localhost/lip",
      tenantId: "tenant",
      key: ""
    })).toThrowError(/tenant id and state key/);
  });

  it("exposes optimistic revision conflict details", () => {
    const error = new StateRevisionConflictError(4, 5);
    expect(error).toMatchObject({
      name: "StateRevisionConflictError",
      expectedRevision: 4,
      actualRevision: 5
    });
  });

  it("rejects transaction-pooler URLs before constructing a repository", () => {
    const secret = "must-not-leak";
    const pooled =
      `postgresql://loyalty:${secret}@ep-example-pooler.us-east-2.aws.neon.tech/loyalty`;
    expect(() => assertSessionLeaseCompatibleUrl(pooled, "LIP_DATABASE_URL"))
      .toThrow(/direct endpoint.*session advisory lease/i);
    try {
      assertSessionLeaseCompatibleUrl(pooled, "LIP_DATABASE_URL");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

const postgresUrl = process.env["LIP_TEST_POSTGRES_URL"];
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("Postgres storage integration", () => {
  it("migrates, round-trips normalized engine state, coordinates mutations, and leases", async () => {
    const tenantId = `test-${randomUUID()}`;
    const options = {
      connectionString: postgresUrl!,
      tenantId,
      programId: "demo-foodservice"
    };
    const first = new PostgresEngineRepository(options);
    const second = new PostgresEngineRepository(options);
    try {
      await first.migrate();
      const engine = new LoyaltyEngine(makeProgram(), { ids: sequentialIds() });
      engine.enroll(makeEnroll("postgres-enroll"));
      expect(await first.save(engine.exportState(), 0)).toBe(1);
      const loaded = await second.load();
      expect(loaded).toMatchObject({
        revision: 1,
        state: { program_id: "demo-foodservice" }
      });
      expect(() => engine.replaceState(loaded!.state)).not.toThrow();
      await expect(first.save(engine.exportState(), 0)).rejects.toBeInstanceOf(
        StateRevisionConflictError
      );

      const lease = await first.withLease("scheduler", async () =>
        second.withLease("scheduler", () => "unexpected")
      );
      expect(lease).toEqual({
        acquired: true,
        result: { acquired: false }
      });
    } finally {
      await first.clear();
      await Promise.all([first.close(), second.close()]);
    }
  });
});
