import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";

/**
 * Validates a managed-environment release evidence record (PLA-417).
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
 */

const FINGERPRINT = /^[a-f0-9]{16}$/;
const GIT_COMMIT = /^[a-f0-9]{7,40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
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
type EnvironmentName = (typeof ENVIRONMENTS)[number];
type DatabaseFingerprintField = keyof Pick<
  EnvironmentFacts,
  "controlPlaneDatabaseFingerprint" | "dataPlaneDatabaseFingerprint"
>;

interface EnvironmentFacts {
  controlPlaneDatabaseFingerprint: string | null;
  dataPlaneDatabaseFingerprint: string | null;
  gitCommit: string | null;
  imageDigest: string | null;
  neonProjectId: string | null;
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
  const imageDigest = requireString(
    value["imageDigest"],
    `${path}.imageDigest`,
    problems,
    IMAGE_DIGEST
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
    imageDigest,
    neonProjectId
  };
}

export function checkManagedEnvironmentEvidence(raw: string): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];

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
  let expectedGitCommit: string | null = null;
  let expectedImageDigest: string | null = null;
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

    if (facts.gitCommit) {
      if (expectedGitCommit && facts.gitCommit !== expectedGitCommit) {
        problems.push({
          path: `environments.${name}.gitCommit`,
          message: "must match the release commit used by every environment"
        });
      } else {
        expectedGitCommit ??= facts.gitCommit;
      }
    }
    if (facts.imageDigest) {
      if (expectedImageDigest && facts.imageDigest !== expectedImageDigest) {
        problems.push({
          path: `environments.${name}.imageDigest`,
          message: "must match the image digest used by every environment"
        });
      } else {
        expectedImageDigest ??= facts.imageDigest;
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
  const target = process.argv[2] ?? "docs/releases/managed-environment-evidence.example.json";
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
