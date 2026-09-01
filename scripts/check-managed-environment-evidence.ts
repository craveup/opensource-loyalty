import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";

/**
 * Validates a managed-environment release evidence record.
 *
 * The runbook lists the evidence activation is gated on but names no
 * destination or format, so "recorded" has never been checkable. This makes the
 * record a validated file while keeping the record itself operator-supplied:
 * the schema and this checker are code, the evidence is not.
 *
 * Two properties are enforced beyond shape:
 *   1. Development, sandbox, and production must report different Neon
 *      projects and database-plane fingerprints. No deployment can see
 *      another's URL, so their self-reported /health identities are the only
 *      proof they are independent.
 *   2. Nothing in the record may look like a credential. Evidence is retained
 *      and shared; a connection string in it is a live secret leak.
 *   3. Each environment may have a different normal-merge commit, but every
 *      commit must resolve to the same canonical Git source tree.
 */

const FINGERPRINT = /^[a-f0-9]{16}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const GIT_TREE = /^[a-f0-9]{40}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Anything that would be a live credential if this file were shared. */
const CREDENTIAL_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "postgres-url", pattern: /postgres(?:ql)?:\/\//i },
  { id: "url-userinfo", pattern: /\/\/[^/\s:]+:[^/\s@]+@/ },
  { id: "lip-access-key", pattern: /\blip_(?:ok|sk|op|cloud)_[A-Za-z0-9_-]{8,}/ },
  { id: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  { id: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "sslmode", pattern: /\bsslmode=/i },
  { id: "password-field", pattern: /"?password"?\s*[:=]/i }
];

const ENVIRONMENTS = ["development", "sandbox", "production"] as const;
export type ManagedEnvironmentName = (typeof ENVIRONMENTS)[number];
type EnvironmentName = ManagedEnvironmentName;
const CANONICAL_REFS: Record<ManagedEnvironmentName, string> = {
  development: "origin/dev",
  sandbox: "origin/sandbox",
  production: "origin/main"
};
type DatabaseFingerprintField = keyof Pick<
  EnvironmentFacts,
  "controlPlaneDatabaseFingerprint" | "dataPlaneDatabaseFingerprint"
>;

interface EnvironmentFacts {
  controlPlaneDatabaseFingerprint: string | null;
  dataPlaneDatabaseFingerprint: string | null;
  gitCommit: string | null;
  neonProjectId: string | null;
  sourceTree: string | null;
}

const evidenceSchema = JSON.parse(
  readFileSync(
    new URL("../docs/releases/managed-environment-evidence.schema.json", import.meta.url),
    "utf8"
  )
) as object;
const schemaValidator = new Ajv2020({
  allErrors: true,
  strict: false
});
const addFormats = addFormatsImport as unknown as FormatsPlugin;
addFormats(schemaValidator, { mode: "full" });
const validateEvidenceSchema = schemaValidator.compile(evidenceSchema);

export interface EvidenceProblem {
  path: string;
  message: string;
}

export type GitCommandRunner = (args: readonly string[]) => string;
export type GitTreeResolver = (
  commit: string,
  environment: ManagedEnvironmentName
) => string | null;

export interface ManagedEnvironmentEvidenceOptions {
  resolveGitTree?: GitTreeResolver;
}

const EVIDENCE_CHECK_USAGE = "Usage: npm run cloud:evidence:check -- <evidence.json>";

export function requireManagedEnvironmentEvidenceTarget(args: readonly string[]): string {
  const [target] = args;
  if (!target || args.length !== 1) throw new Error(EVIDENCE_CHECK_USAGE);
  return target;
}

function runGitCommand(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

export function resolveGitTreeFromRepository(
  commit: string,
  environment: ManagedEnvironmentName,
  runGit: GitCommandRunner = runGitCommand
): string | null {
  if (!GIT_COMMIT.test(commit)) return null;
  try {
    const resolvedCommit = runGit(["rev-parse", "--verify", `${commit}^{commit}`]);
    if (resolvedCommit !== commit) return null;
    runGit(["merge-base", "--is-ancestor", commit, CANONICAL_REFS[environment]]);
    const tree = runGit(["rev-parse", "--verify", `${commit}^{tree}`]);
    return GIT_TREE.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(
  value: unknown,
  path: string,
  problems: EvidenceProblem[],
  pattern?: RegExp
): string | null {
  if (typeof value !== "string" || !value.trim()) {
    problems.push({ path, message: "is required and must be a non-empty string" });
    return null;
  }
  if (pattern && !pattern.test(value)) {
    problems.push({ path, message: `does not match ${String(pattern)}` });
    return null;
  }
  return value;
}

function requireTimestamp(value: unknown, path: string, problems: EvidenceProblem[]): void {
  requireString(value, path, problems, ISO_TIMESTAMP);
}

function requireLiteral(
  value: unknown,
  expected: unknown,
  path: string,
  problems: EvidenceProblem[]
): void {
  if (value !== expected) {
    problems.push({ path, message: `must be ${JSON.stringify(expected)}` });
  }
}

function schemaErrorPath(error: ErrorObject): string {
  const base = error.instancePath
    .split("/")
    .filter(Boolean)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
  const additionalProperty =
    error.keyword === "additionalProperties"
      ? String(error.params["additionalProperty"] ?? "")
      : "";
  return [base, additionalProperty].filter(Boolean).join(".") || "<document>";
}

function checkEnvironment(
  value: unknown,
  path: string,
  problems: EvidenceProblem[]
): EnvironmentFacts | null {
  if (!isRecord(value)) {
    problems.push({ path, message: "is required" });
    return null;
  }
  for (const field of ["serviceId", "hostname", "neonBranchId", "deployId"]) {
    requireString(value[field], `${path}.${field}`, problems);
  }
  const neonProjectId = requireString(value["neonProjectId"], `${path}.neonProjectId`, problems);
  requireLiteral(value["connectionMode"], "direct", `${path}.connectionMode`, problems);
  requireLiteral(value["instanceCount"], 1, `${path}.instanceCount`, problems);
  const gitCommit = requireString(value["gitCommit"], `${path}.gitCommit`, problems, GIT_COMMIT);
  const sourceTree = requireString(
    value["sourceTree"],
    `${path}.sourceTree`,
    problems,
    GIT_TREE
  );
  const controlPlaneDatabaseFingerprint = requireString(
    value["controlPlaneDatabaseFingerprint"],
    `${path}.controlPlaneDatabaseFingerprint`,
    problems,
    FINGERPRINT
  );
  const dataPlaneDatabaseFingerprint = requireString(
    value["dataPlaneDatabaseFingerprint"],
    `${path}.dataPlaneDatabaseFingerprint`,
    problems,
    FINGERPRINT
  );

  const migration = isRecord(value["migration"]) ? value["migration"] : {};
  requireTimestamp(migration["appliedAt"], `${path}.migration.appliedAt`, problems);
  requireLiteral(migration["outcome"], "succeeded", `${path}.migration.outcome`, problems);

  const health = isRecord(value["health"]) ? value["health"] : {};
  requireTimestamp(health["checkedAt"], `${path}.health.checkedAt`, problems);
  requireLiteral(health["status"], "ok", `${path}.health.status`, problems);
  requireLiteral(health["instancePolicy"], "single", `${path}.health.instancePolicy`, problems);
  const healthRelease = requireString(
    health["release"],
    `${path}.health.release`,
    problems,
    GIT_COMMIT
  );
  if (healthRelease && gitCommit && healthRelease !== gitCommit) {
    problems.push({
      path: `${path}.health.release`,
      message: "must equal the environment gitCommit"
    });
  }

  const metrics = isRecord(value["metricsProbe"]) ? value["metricsProbe"] : {};
  requireTimestamp(metrics["checkedAt"], `${path}.metricsProbe.checkedAt`, problems);
  requireLiteral(metrics["authenticatedStatus"], 200, `${path}.metricsProbe.authenticatedStatus`, problems);
  requireLiteral(metrics["anonymousStatus"], 401, `${path}.metricsProbe.anonymousStatus`, problems);

  const backup = isRecord(value["backup"]) ? value["backup"] : {};
  requireString(backup["branchId"], `${path}.backup.branchId`, problems);
  requireTimestamp(backup["capturedAt"], `${path}.backup.capturedAt`, problems);

  const restore = isRecord(value["restoreDrill"]) ? value["restoreDrill"] : {};
  requireTimestamp(restore["performedAt"], `${path}.restoreDrill.performedAt`, problems);
  requireLiteral(restore["outcome"], "succeeded", `${path}.restoreDrill.outcome`, problems);
  const counts = restore["verifiedRowCounts"];
  if (!isRecord(counts) || Object.keys(counts).length === 0) {
    problems.push({
      path: `${path}.restoreDrill.verifiedRowCounts`,
      message: "must record at least one verified table row count"
    });
  } else if (
    Object.values(counts).some(
      (count) => typeof count !== "number" || !Number.isInteger(count) || count < 0
    )
  ) {
    problems.push({
      path: `${path}.restoreDrill.verifiedRowCounts`,
      message: "row counts must be non-negative integers"
    });
  }
  return {
    controlPlaneDatabaseFingerprint,
    dataPlaneDatabaseFingerprint,
    gitCommit,
    neonProjectId,
    sourceTree
  };
}

export function checkManagedEnvironmentEvidence(
  raw: string,
  options: ManagedEnvironmentEvidenceOptions = {}
): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  const resolveGitTree = options.resolveGitTree ?? resolveGitTreeFromRepository;

  for (const { id, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(raw)) {
      problems.push({
        path: "<document>",
        message: `contains something matching a credential pattern (${id}); evidence must never hold secrets`
      });
    }
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    problems.push({ path: "<document>", message: "is not valid JSON" });
    return problems;
  }
  if (!isRecord(document)) {
    problems.push({ path: "<document>", message: "must be a JSON object" });
    return problems;
  }

  if (!validateEvidenceSchema(document)) {
    for (const error of validateEvidenceSchema.errors ?? []) {
      problems.push({
        path: schemaErrorPath(error),
        message: error.message ?? `does not satisfy schema rule ${error.keyword}`
      });
    }
  }

  requireTimestamp(document["recordedAt"], "recordedAt", problems);
  requireString(document["recordedBy"], "recordedBy", problems);

  const environments = isRecord(document["environments"]) ? document["environments"] : null;
  if (!environments) {
    problems.push({ path: "environments", message: "is required" });
  }
  const fingerprints = new Map<
    string,
    { environment: EnvironmentName; field: DatabaseFingerprintField }
  >();
  const neonProjects = new Map<string, EnvironmentName>();
  let expectedSourceTree: string | null = null;
  for (const name of ENVIRONMENTS) {
    const facts = checkEnvironment(
      environments?.[name],
      `environments.${name}`,
      problems
    );
    if (!facts) continue;

    if (facts.neonProjectId) {
      const owner = neonProjects.get(facts.neonProjectId);
      if (owner && owner !== name) {
        problems.push({
          path: `environments.${name}.neonProjectId`,
          message: `matches ${owner}; each environment requires an independent Neon project`
        });
      } else {
        neonProjects.set(facts.neonProjectId, name);
      }
    }

    for (const field of [
      "controlPlaneDatabaseFingerprint",
      "dataPlaneDatabaseFingerprint"
    ] as const) {
      const fingerprint = facts[field];
      if (!fingerprint) continue;
      const owner = fingerprints.get(fingerprint);
      if (owner && owner.environment !== name) {
        problems.push({
          path: `environments.${name}.${field}`,
          message:
            `matches ${owner.environment}.${owner.field}; the deployments are addressing one database and are not independent`
        });
      } else if (!owner) {
        fingerprints.set(fingerprint, { environment: name, field });
      }
    }

    let verifiedSourceTree: string | null = null;
    if (facts.gitCommit) {
      let resolvedSourceTree: string | null = null;
      try {
        resolvedSourceTree = resolveGitTree(facts.gitCommit, name);
      } catch {
        resolvedSourceTree = null;
      }
      if (!resolvedSourceTree) {
        problems.push({
          path: `environments.${name}.gitCommit`,
          message:
            `must resolve to a full commit reachable from the canonical ` +
            `${CANONICAL_REFS[name]} history`
        });
      } else if (facts.sourceTree && facts.sourceTree !== resolvedSourceTree) {
        problems.push({
          path: `environments.${name}.sourceTree`,
          message: "does not match the canonical tree resolved from gitCommit"
        });
      } else if (facts.sourceTree) {
        verifiedSourceTree = resolvedSourceTree;
      }
    }

    if (verifiedSourceTree) {
      if (expectedSourceTree && verifiedSourceTree !== expectedSourceTree) {
        problems.push({
          path: `environments.${name}.sourceTree`,
          message: "must match the canonical source tree used by every environment"
        });
      } else {
        expectedSourceTree ??= verifiedSourceTree;
      }
    }
  }

  const rollback = isRecord(document["rollback"]) ? document["rollback"] : {};
  requireTimestamp(rollback["rehearsedAt"], "rollback.rehearsedAt", problems);
  requireString(rollback["targetDeployId"], "rollback.targetDeployId", problems);
  requireLiteral(rollback["outcome"], "succeeded", "rollback.outcome", problems);

  const signOff = isRecord(document["signOff"]) ? document["signOff"] : {};
  requireString(signOff["reviewer"], "signOff.reviewer", problems);
  requireTimestamp(signOff["reviewedAt"], "signOff.reviewedAt", problems);

  return problems;
}

async function main(): Promise<void> {
  let target: string;
  try {
    target = requireManagedEnvironmentEvidenceTarget(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : EVIDENCE_CHECK_USAGE);
    process.exitCode = 2;
    return;
  }
  const path = resolve(process.cwd(), target);
  const raw = await readFile(path, "utf8");
  const problems = checkManagedEnvironmentEvidence(raw);
  if (problems.length > 0) {
    console.error(`Managed environment evidence is incomplete: ${target}`);
    for (const problem of problems) console.error(`  ${problem.path} ${problem.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Managed environment evidence is complete: ${target}`);
}

if (process.argv[1]?.endsWith("check-managed-environment-evidence.ts")) {
  await main();
}
