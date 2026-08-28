import { describe, expect, it } from "vitest";
import { compareRestoreEvidence, type RestoreEvidence } from "./restore-verification.js";

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
});
