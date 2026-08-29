import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkManagedEnvironmentEvidence } from "../../scripts/check-managed-environment-evidence.js";

const examplePath = "docs/releases/managed-environment-evidence.example.json";

async function example(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(examplePath, "utf8")) as Record<string, unknown>;
}

const paths = (problems: Array<{ path: string }>) => problems.map((problem) => problem.path);

describe("managed environment release evidence", () => {
  it("accepts the committed example so the schema cannot rot", async () => {
    expect(checkManagedEnvironmentEvidence(await readFile(examplePath, "utf8"))).toEqual([]);
  });

  it("requires independently verified development evidence", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["development"] = {
      ...environments["sandbox"],
      databaseFingerprint: "1122334455667788",
      hostname: "crave-loyalty-development.onrender.com",
      neonBranchId: "br-development-main",
      neonProjectId: "neon-development-project",
      serviceId: "srv-crave-loyalty-development"
    };
    expect(checkManagedEnvironmentEvidence(JSON.stringify(document))).toEqual([]);

    delete environments["development"];
    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.development"
    );
  });

  it("refuses a development database reused by sandbox", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["development"] = {
      ...environments["sandbox"],
      hostname: "crave-loyalty-development.onrender.com",
      neonBranchId: "br-development-main",
      neonProjectId: "neon-development-project",
      serviceId: "srv-crave-loyalty-development"
    };

    const problems = checkManagedEnvironmentEvidence(JSON.stringify(document));
    expect(paths(problems)).toContain("environments.sandbox.databaseFingerprint");
    expect(problems.some((problem) => /not independent/i.test(problem.message))).toBe(true);
  });

  it("refuses two deployments that report the same database", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["production"]!["databaseFingerprint"] =
      environments["sandbox"]!["databaseFingerprint"];

    const problems = checkManagedEnvironmentEvidence(JSON.stringify(document));
    expect(paths(problems)).toContain("environments.production.databaseFingerprint");
    expect(problems[0]?.message).toMatch(/not independent/i);
  });

  it.each([
    ["a connection string", "postgresql://loyalty:secret@ep-x.neon.tech/loyalty"],
    ["an operator key", "lip_op_ABCDEFGH12345678"],
    ["a bearer token", "Bearer abcdefghijklmnopqrstuvwxyz"],
    ["an sslmode parameter", "sslmode=require"]
  ])("refuses evidence containing %s", async (_label, secret) => {
    const document = await example();
    (document["signOff"] as Record<string, unknown>)["notes"] = secret;

    const problems = checkManagedEnvironmentEvidence(JSON.stringify(document));
    expect(paths(problems)).toContain("<document>");
    expect(problems.some((problem) => /credential pattern/i.test(problem.message))).toBe(true);
  });

  it("refuses a pooled connection mode", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["sandbox"]!["connectionMode"] = "pooled";

    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.sandbox.connectionMode"
    );
  });

  it("refuses an anonymous metrics probe that was not rejected", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    (environments["production"]!["metricsProbe"] as Record<string, unknown>)["anonymousStatus"] =
      200;

    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.production.metricsProbe.anonymousStatus"
    );
  });

  it("refuses a restore drill with no verified row counts", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    (environments["sandbox"]!["restoreDrill"] as Record<string, unknown>)["verifiedRowCounts"] = {};

    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.sandbox.restoreDrill.verifiedRowCounts"
    );
  });

  it("refuses a scaled-out instance count", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["production"]!["instanceCount"] = 2;

    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.production.instanceCount"
    );
  });

  it("names every missing environment rather than stopping at the first", () => {
    const problems = checkManagedEnvironmentEvidence(JSON.stringify({}));
    expect(paths(problems)).toEqual(
      expect.arrayContaining([
        "environments",
        "environments.development",
        "environments.sandbox",
        "environments.production"
      ])
    );
  });

  it("reports malformed JSON without throwing", () => {
    expect(checkManagedEnvironmentEvidence("{ not json")).toEqual([
      { path: "<document>", message: "is not valid JSON" }
    ]);
  });
});
