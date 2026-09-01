import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  checkManagedEnvironmentEvidence as checkManagedEnvironmentEvidenceRaw,
  requireManagedEnvironmentEvidenceTarget,
  resolveGitTreeFromRepository,
  type GitCommandRunner,
  type GitTreeResolver
} from "../../scripts/check-managed-environment-evidence.js";

const examplePath = "docs/releases/managed-environment-evidence.example.json";
const exampleCommit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const exampleSourceTree = "d1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function checkManagedEnvironmentEvidence(
  raw: string,
  resolveGitTree: GitTreeResolver = (commit) =>
    commit === exampleCommit ? exampleSourceTree : null
): ReturnType<typeof checkManagedEnvironmentEvidenceRaw> {
  return checkManagedEnvironmentEvidenceRaw(raw, { resolveGitTree });
}

async function example(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(examplePath, "utf8")) as Record<string, unknown>;
}

const paths = (problems: Array<{ path: string }>) => problems.map((problem) => problem.path);

describe("managed environment release evidence", () => {
  it("requires an explicit operator evidence path", () => {
    expect(() => requireManagedEnvironmentEvidenceTarget([])).toThrow(
      /cloud:evidence:check -- <evidence\.json>/
    );
    expect(requireManagedEnvironmentEvidenceTarget(["evidence.json"])).toBe("evidence.json");
  });

  it("accepts the committed example so the schema cannot rot", async () => {
    expect(checkManagedEnvironmentEvidence(await readFile(examplePath, "utf8"))).toEqual([]);
  });

  it("requires independently verified development evidence", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["development"] = {
      ...environments["sandbox"],
      controlPlaneDatabaseFingerprint: "1122334455667788",
      dataPlaneDatabaseFingerprint: "1122334455667788",
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
    expect(paths(problems)).toContain(
      "environments.sandbox.controlPlaneDatabaseFingerprint"
    );
    expect(problems.some((problem) => /not independent/i.test(problem.message))).toBe(true);
  });

  it("refuses two deployments that report the same database", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["production"]!["controlPlaneDatabaseFingerprint"] =
      environments["sandbox"]!["controlPlaneDatabaseFingerprint"];

    const problems = checkManagedEnvironmentEvidence(JSON.stringify(document));
    expect(paths(problems)).toContain(
      "environments.production.controlPlaneDatabaseFingerprint"
    );
    expect(problems.some((problem) => /not independent/i.test(problem.message))).toBe(true);
  });

  it.each([
    ["a connection string", "postgresql://loyalty:secret@ep-x.neon.tech/loyalty"],
    ["a current operator key", "lip_ok_ABCDEFGH12345678"],
    ["a current merchant key", "lip_sk_ABCDEFGH12345678"],
    ["a legacy operator key", "lip_op_ABCDEFGH12345678"],
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

  it("refuses a Neon project reused by another environment", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["production"]!["neonProjectId"] = environments["sandbox"]!["neonProjectId"];

    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.production.neonProjectId"
    );
  });

  it("refuses either database plane reused across environments", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["production"]!["dataPlaneDatabaseFingerprint"] =
      environments["sandbox"]!["controlPlaneDatabaseFingerprint"];

    const problems = checkManagedEnvironmentEvidence(JSON.stringify(document));
    expect(paths(problems)).toContain(
      "environments.production.dataPlaneDatabaseFingerprint"
    );
    expect(problems.some((problem) => /not independent/i.test(problem.message))).toBe(true);
  });

  it("accepts normal-merge promotion commits when every environment runs the same source tree", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    const promotedCommits = {
      development: exampleCommit,
      sandbox: "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      production: "c1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    };
    const promotedTrees = new Map(
      Object.values(promotedCommits).map((commit) => [commit, exampleSourceTree])
    );

    for (const [name, environment] of Object.entries(environments)) {
      environment["gitCommit"] = promotedCommits[name as keyof typeof promotedCommits];
      environment["sourceTree"] = exampleSourceTree;
      (environment["health"] as Record<string, unknown>)["release"] =
        promotedCommits[name as keyof typeof promotedCommits];
    }

    expect(
      checkManagedEnvironmentEvidence(
        JSON.stringify(document),
        (commit) => promotedTrees.get(commit) ?? null
      )
    ).toEqual([]);
  });

  it("refuses a recorded source tree that does not match its deployed commit", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    const productionCommit = "c1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    environments["production"]!["gitCommit"] = productionCommit;
    (environments["production"]!["health"] as Record<string, unknown>)["release"] =
      productionCommit;

    const problems = checkManagedEnvironmentEvidence(JSON.stringify(document), (commit) =>
      commit === productionCommit
        ? "e1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
        : exampleSourceTree
    );
    expect(paths(problems)).toContain("environments.production.sourceTree");
    expect(problems.some((problem) => /does not match.*gitCommit/i.test(problem.message))).toBe(
      true
    );
  });

  it("refuses internally valid deployments that resolve to different source trees", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    const promotedCommits = {
      development: exampleCommit,
      sandbox: "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      production: "c1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    };
    const productionTree = "e1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const promotedTrees = new Map<string, string>([
      [promotedCommits.development, exampleSourceTree],
      [promotedCommits.sandbox, exampleSourceTree],
      [promotedCommits.production, productionTree]
    ]);

    for (const [name, environment] of Object.entries(environments)) {
      const commit = promotedCommits[name as keyof typeof promotedCommits];
      const sourceTree = promotedTrees.get(commit)!;
      environment["gitCommit"] = commit;
      environment["sourceTree"] = sourceTree;
      (environment["health"] as Record<string, unknown>)["release"] = commit;
    }

    const problems = checkManagedEnvironmentEvidence(
      JSON.stringify(document),
      (commit) => promotedTrees.get(commit) ?? null
    );
    expect(paths(problems)).toContain("environments.production.sourceTree");
    expect(
      problems.some((problem) =>
        /canonical source tree used by every environment/i.test(problem.message)
      )
    ).toBe(true);
  });

  it("refuses a deployed commit that is unavailable in the canonical repository", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    const unknownCommit = "f1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    environments["production"]!["gitCommit"] = unknownCommit;
    (environments["production"]!["health"] as Record<string, unknown>)["release"] = unknownCommit;

    const problems = checkManagedEnvironmentEvidence(JSON.stringify(document));
    expect(paths(problems)).toContain("environments.production.gitCommit");
    expect(problems.some((problem) => /canonical origin\/main history/i.test(problem.message))).toBe(
      true
    );
  });

  it("requires full commit SHAs so abbreviated revisions cannot resolve ambiguously", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    environments["production"]!["gitCommit"] = "a1b2c3d";
    (environments["production"]!["health"] as Record<string, unknown>)["release"] = "a1b2c3d";

    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.production.gitCommit"
    );
  });

  it("requires the deployed commit to be reachable from its environment's canonical ref", () => {
    const commit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const tree = "d1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const calls: string[][] = [];
    const runGit: GitCommandRunner = (args) => {
      calls.push([...args]);
      if (args[0] === "merge-base") return "";
      return args[2]?.endsWith("^{tree}") ? tree : commit;
    };

    expect(resolveGitTreeFromRepository(commit, "sandbox", runGit)).toBe(tree);
    expect(calls).toContainEqual([
      "merge-base",
      "--is-ancestor",
      commit,
      "origin/sandbox"
    ]);
  });

  it("refuses an existing commit object outside the canonical environment history", () => {
    const commit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const tree = "d1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const runGit: GitCommandRunner = (args) => {
      if (args[0] === "merge-base") throw new Error("not an ancestor");
      return args[2]?.endsWith("^{tree}") ? tree : commit;
    };

    expect(resolveGitTreeFromRepository(commit, "production", runGit)).toBeNull();
  });

  it("binds each health response to its declared release", async () => {
    const document = await example();
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    const productionHealth = environments["production"]!["health"] as Record<string, unknown>;
    productionHealth["release"] = "deadbee";

    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.production.health.release"
    );

    delete productionHealth["release"];
    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toContain(
      "environments.production.health.release"
    );
  });

  it("rejects fields excluded by the committed JSON Schema", async () => {
    const document = await example();
    document["unexpected"] = true;

    const problems = checkManagedEnvironmentEvidence(JSON.stringify(document));
    expect(problems.some((problem) => /additional properties/i.test(problem.message))).toBe(true);
  });

  it("rejects impossible timestamps in every schema date-time field", async () => {
    const document = await example();
    document["recordedAt"] = "2026-99-99T09:00:00Z";
    const environments = document["environments"] as Record<string, Record<string, unknown>>;
    const productionAlert = environments["production"]!["alertTest"] as Record<string, unknown>;
    productionAlert["firedAt"] = "not-a-timestamp";

    expect(paths(checkManagedEnvironmentEvidence(JSON.stringify(document)))).toEqual(
      expect.arrayContaining(["recordedAt", "environments.production.alertTest.firedAt"])
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
