import { describe, expect, it } from "vitest";
import {
  assertDistinctRestoreDatabases,
  compareRestoreEvidence,
  type RestoreEvidence
} from "./restore-verification.js";

const evidence = (): RestoreEvidence => ({
  cloud_schema_versions: [1, 2, 3, 4, 5],
  engine_schema_versions: [1],
  relations: {
    lip_cloud_environments: { checksum: "101", row_count: 2 },
    lip_engine_ledger: { checksum: "202", row_count: 12 }
  }
});

describe("backup restore verification", () => {
  it("accepts an exact schema and data fingerprint match", () => {
    expect(() => compareRestoreEvidence(evidence(), structuredClone(evidence()))).not.toThrow();
  });

  it("fails closed on restored ledger drift", () => {
    const restored = evidence();
    restored.relations.lip_engine_ledger = { checksum: "different", row_count: 12 };
    expect(() => compareRestoreEvidence(evidence(), restored)).toThrow(/does not match/i);
  });

  it("rejects the source database reused through different credentials or query options", () => {
    const source = "postgresql://source:secret@ep-source.neon.tech/loyalty?sslmode=require";
    expect(() => assertDistinctRestoreDatabases(
      source,
      "postgresql://restore:other@ep-source.neon.tech/loyalty?sslmode=verify-full"
    )).toThrow(/must be distinct/i);
    expect(() => assertDistinctRestoreDatabases(
      source,
      "postgresql://restore:other@ep-restored.neon.tech/loyalty?sslmode=require"
    )).not.toThrow();
  });
});
