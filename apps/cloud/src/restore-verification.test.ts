import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  assertDistinctRestoreDatabases,
  captureRestoreEvidence,
  captureStableRestoreSourceEvidence,
  compareRestoreEvidence,
  type RestoreEvidence,
} from "./restore-verification.js";

const evidence = (): RestoreEvidence => ({
  cloud_schema_versions: [1, 2, 3, 4, 5],
  engine_schema_versions: [1],
  relations: {
    lip_cloud_environments: { checksum: "101", row_count: 2 },
    lip_engine_ledger: { checksum: "202", row_count: 12 },
  },
});

describe("backup restore verification", () => {
  it("captures credential operations as durable restore evidence", async () => {
    const queried: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queried.push(sql);
        if (sql.includes("schema_migrations")) return { rows: [] };
        return { rows: [{ checksum: "0", row_count: "0" }] };
      }
    } as unknown as Pool;

    const captured = await captureRestoreEvidence(pool);
    expect(captured.relations).toHaveProperty("lip_cloud_credential_operations", {
      checksum: "0",
      row_count: 0
    });
    expect(queried.some((sql) => sql.includes("FROM lip_cloud_credential_operations"))).toBe(true);
  });

  it("accepts an exact schema and data fingerprint match", () => {
    expect(() =>
      compareRestoreEvidence(evidence(), structuredClone(evidence())),
    ).not.toThrow();
  });

  it("fails closed on restored ledger drift", () => {
    const restored = evidence();
    restored.relations.lip_engine_ledger = {
      checksum: "different",
      row_count: 12,
    };
    expect(() => compareRestoreEvidence(evidence(), restored)).toThrow(
      /relations\.lip_engine_ledger\.checksum/u,
    );
  });

  it("reports only the safe evidence fields that drifted", () => {
    const restored = evidence();
    restored.cloud_schema_versions = [1, 2, 3, 4];
    restored.relations.lip_engine_ledger = {
      checksum: "different",
      row_count: 11,
    };

    let reported: unknown;
    try {
      compareRestoreEvidence(evidence(), restored);
    } catch (error) {
      reported = error;
    }

    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe(
      "Restored loyalty database does not match the frozen source evidence: " +
        "cloud_schema_versions, relations.lip_engine_ledger.checksum, " +
        "relations.lip_engine_ledger.row_count",
    );
    expect((reported as Error).message).not.toContain("different");
  });

  it("reports missing relations without exposing their evidence", () => {
    const restored = evidence();
    delete restored.relations.lip_engine_ledger;

    expect(() => compareRestoreEvidence(evidence(), restored)).toThrow(
      "Restored loyalty database does not match the frozen source evidence: " +
        "relations.lip_engine_ledger",
    );
  });

  it("captures the source twice after the required stability interval", async () => {
    const captures = [evidence(), structuredClone(evidence())];
    const waits: number[] = [];

    const stable = await captureStableRestoreSourceEvidence(
      async () => captures.shift()!,
      {
        intervalMs: 5_000,
        wait: async (intervalMs) => {
          waits.push(intervalMs);
        },
      },
    );

    expect(stable).toEqual(evidence());
    expect(captures).toHaveLength(0);
    expect(waits).toEqual([5_000]);
  });

  it("rejects an unsafe source stability interval", async () => {
    await expect(
      captureStableRestoreSourceEvidence(async () => evidence(), {
        intervalMs: 4_999,
        wait: async () => {},
      }),
    ).rejects.toThrow(/at least 5000 milliseconds/u);
  });

  it("rejects the source database reused through different credentials or query options", () => {
    const source =
      "postgresql://source:secret@ep-source.neon.tech/loyalty?sslmode=require";
    expect(() =>
      assertDistinctRestoreDatabases(
        source,
        "postgresql://restore:other@ep-source.neon.tech/loyalty?sslmode=verify-full",
      ),
    ).toThrow(/must be distinct/i);
    expect(() =>
      assertDistinctRestoreDatabases(
        source,
        "postgresql://restore:other@ep-restored.neon.tech/loyalty?sslmode=require",
      ),
    ).not.toThrow();
  });
});
