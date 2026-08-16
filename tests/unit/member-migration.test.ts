import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMemberImportPlan,
  parseMemberImportPlan,
  runMemberImportPlan,
  runMemberImportReconciliation
} from "@loyalty-interchange/cli";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { makeProgram } from "../fixtures.js";

function context(id: string) {
  return {
    protocol_version: "1.0" as const,
    profile: "foodservice/1.0" as const,
    request_id: `request-${id}`,
    idempotency_key: `idempotency-${id}`,
    occurred_at: "2026-08-15T20:00:00.000Z",
    source: { system: "migration-test" }
  };
}

describe("member migration planning", () => {
  it("creates deterministic enrollment and opening-balance operations", () => {
    const rows = [{
      external_member_id: "legacy-7",
      identity_type: "external",
      identity_value: "provider:legacy-7",
      available_balance: 420
    }];
    const first = createMemberImportPlan(
      "demo-foodservice",
      rows,
      () => new Date("2026-08-15T20:00:00.000Z")
    );
    const second = createMemberImportPlan(
      "demo-foodservice",
      rows,
      () => new Date("2026-08-15T20:00:00.000Z")
    );

    expect(first).toEqual(second);
    expect(first.entries[0]).toMatchObject({
      external_member_id: "legacy-7",
      expected_balance: 420,
      opening_balance: {
        amount: 420,
        classification: "migration",
        qualifies_for_tier: false
      }
    });
    expect(parseMemberImportPlan(first)).toEqual(first);
    expect(() => parseMemberImportPlan({ ...first, program_id: "tampered" })).toThrow(
      /checksum/
    );
  });

  it("reads CSV into a private plan and reconciles it against an engine archive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-member-migration-"));
    const sourcePath = join(directory, "members.csv");
    const planPath = join(directory, "plan.json");
    const archivePath = join(directory, "archive.json");
    writeFileSync(
      sourcePath,
      [
        "external_member_id,identity_type,identity_value,member_id,available_balance",
        "legacy-7,external,provider:legacy-7,member-migrated-7,420"
      ].join("\n")
    );
    const plan = await runMemberImportPlan({
      programId: "demo-foodservice",
      input: sourcePath,
      output: planPath
    });
    expect(statSync(planPath).mode & 0o777).toBe(0o600);

    const program = makeProgram();
    const engine = new LoyaltyEngine(program);
    engine.enroll({
      context: context("enroll"),
      program_id: program.program_id,
      identity: plan.entries[0]!.identity,
      member_id: plan.entries[0]!.member_id
    });
    engine.postManualAdjustment({
      context: context("balance"),
      ...plan.entries[0]!.opening_balance!
    });
    const state = engine.exportState();
    const checksum = createHash("sha256")
      .update(JSON.stringify({ program, state }))
      .digest("hex");
    writeFileSync(archivePath, JSON.stringify({
      format: "lip-engine-state",
      format_version: 1,
      exported_at: "2026-08-15T20:01:00.000Z",
      program,
      state,
      summary: {
        members: 1,
        balances: 1,
        ledger_entries: 1,
        reservations: 0,
        open_reservations: 0,
        idempotency_records: 2,
        order_accruals: 0,
        order_adjustments: 0,
        issued_rewards: 0
      },
      checksum: { algorithm: "sha256", value: checksum }
    }));

    const report = await runMemberImportReconciliation(
      { plan: planPath, archive: archivePath },
      () => new Date("2026-08-15T20:02:00.000Z")
    );
    expect(report).toMatchObject({
      passed: true,
      summary: { expected_members: 1, matched: 1, missing: 0, mismatched: 0 }
    });
    expect(JSON.parse(readFileSync(planPath, "utf8"))).toEqual(plan);
  });

  it("rejects duplicate identities before producing a plan", () => {
    expect(() => createMemberImportPlan("demo-foodservice", [
      { external_member_id: "a", identity_value: "same", available_balance: 1 },
      { external_member_id: "b", identity_value: "same", available_balance: 2 }
    ])).toThrow(/Duplicate identity/);
  });

  it("rejects a negative available balance that cannot be applied to a new member", () => {
    expect(() => createMemberImportPlan("demo-foodservice", [{
      external_member_id: "legacy-negative",
      identity_value: "provider:legacy-negative",
      available_balance: -1
    }])).toThrow(/cannot be negative/);
  });
});
