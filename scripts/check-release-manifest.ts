import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const NPM_SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const TAG = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REFERENCE = /^[^\s]+@sha256:[0-9a-f]{64}$/;
const PACKAGE_NAME = /^@loyalty-interchange\/[a-z0-9-]+$/;

export interface LipReleaseManifestV1 {
  schemaVersion: 1;
  source: {
    repository: string;
    commit: string;
    tag: string;
  };
  protocol: {
    version: "1.0";
    profile: "foodservice/1.0";
    openapiSha256: string;
  };
  packages: Array<{
    name: string;
    version: string;
    integrity: string;
  }>;
  image: {
    reference: string;
    digest: `sha256:${string}`;
    provenanceUrl: string;
  };
  database: {
    migrationSetSha256: string;
    connectionMode: "direct";
  };
  dependencies: {
    lockfileSha256: string;
    auditReportSha256: string;
    sbomSha256: string;
    riskRegisterSha256: string;
    toolchain: {
      node: string;
      npm: string;
    };
    findings: {
      moderate: number;
      high: number;
      critical: number;
      unapprovedHigh: 0;
      unapprovedCritical: 0;
    };
  };
  verification: {
    runUrl: string;
    conformanceReportSha256: string;
  };
}

type JsonRecord = Record<string, unknown>;

export class ManifestValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid LIP release manifest:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "ManifestValidationError";
    this.errors = errors;
  }
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function manifestDigest(value: LipReleaseManifestV1): string {
  return sha256Hex(canonicalJson(value));
}

export function validateLipReleaseManifest(value: unknown): LipReleaseManifestV1 {
  const errors: string[] = [];
  const root = objectAt(value, "manifest", errors);

  if (!root) throw new ManifestValidationError(errors);
  expectExact(root.schemaVersion, 1, "schemaVersion", errors);

  const source = objectAt(root.source, "source", errors);
  if (source) {
    expectPattern(source.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "source.repository", errors);
    expectPattern(source.commit, GIT_SHA, "source.commit", errors);
    expectPattern(source.tag, TAG, "source.tag", errors);
    rejectMutable(source.commit, "source.commit", errors);
    rejectMutable(source.tag, "source.tag", errors);
  }

  const protocol = objectAt(root.protocol, "protocol", errors);
  if (protocol) {
    expectExact(protocol.version, "1.0", "protocol.version", errors);
    expectExact(protocol.profile, "foodservice/1.0", "protocol.profile", errors);
    expectPattern(protocol.openapiSha256, SHA256_HEX, "protocol.openapiSha256", errors);
  }

  const packages = arrayAt(root.packages, "packages", errors);
  if (packages) {
    if (packages.length === 0) errors.push("packages must contain at least one package");
    const seen = new Set<string>();
    packages.forEach((entry, index) => {
      const item = objectAt(entry, `packages[${index}]`, errors);
      if (!item) return;
      const name = stringAt(item.name, `packages[${index}].name`, errors);
      if (name) {
        if (!PACKAGE_NAME.test(name)) errors.push(`packages[${index}].name must be an @loyalty-interchange package`);
        if (seen.has(name)) errors.push(`packages contains duplicate package ${name}`);
        seen.add(name);
      }
      expectPattern(item.version, SEMVER, `packages[${index}].version`, errors);
      expectPattern(item.integrity, NPM_SRI, `packages[${index}].integrity`, errors);
    });
  }

  const image = objectAt(root.image, "image", errors);
  if (image) {
    expectPattern(image.reference, IMAGE_REFERENCE, "image.reference", errors);
    expectPattern(image.digest, IMAGE_DIGEST, "image.digest", errors);
    expectHttpsUrl(image.provenanceUrl, "image.provenanceUrl", errors);
    if (
      typeof image.reference === "string" &&
      typeof image.digest === "string" &&
      !image.reference.endsWith(image.digest)
    ) {
      errors.push("image.reference must be pinned to image.digest");
    }
  }

  const database = objectAt(root.database, "database", errors);
  if (database) {
    expectPattern(database.migrationSetSha256, SHA256_HEX, "database.migrationSetSha256", errors);
    expectExact(database.connectionMode, "direct", "database.connectionMode", errors);
  }

  const dependencies = objectAt(root.dependencies, "dependencies", errors);
  if (dependencies) {
    expectPattern(dependencies.lockfileSha256, SHA256_HEX, "dependencies.lockfileSha256", errors);
    expectPattern(dependencies.auditReportSha256, SHA256_HEX, "dependencies.auditReportSha256", errors);
    expectPattern(dependencies.sbomSha256, SHA256_HEX, "dependencies.sbomSha256", errors);
    expectPattern(dependencies.riskRegisterSha256, SHA256_HEX, "dependencies.riskRegisterSha256", errors);

    const toolchain = objectAt(dependencies.toolchain, "dependencies.toolchain", errors);
    if (toolchain) {
      expectPattern(toolchain.node, SEMVER, "dependencies.toolchain.node", errors);
      expectPattern(toolchain.npm, SEMVER, "dependencies.toolchain.npm", errors);
    }

    const findings = objectAt(dependencies.findings, "dependencies.findings", errors);
    if (findings) {
      expectNonNegativeInteger(findings.moderate, "dependencies.findings.moderate", errors);
      expectNonNegativeInteger(findings.high, "dependencies.findings.high", errors);
      expectNonNegativeInteger(findings.critical, "dependencies.findings.critical", errors);
      expectExact(findings.unapprovedHigh, 0, "dependencies.findings.unapprovedHigh", errors);
      expectExact(findings.unapprovedCritical, 0, "dependencies.findings.unapprovedCritical", errors);
    }
  }

  const verification = objectAt(root.verification, "verification", errors);
  if (verification) {
    expectHttpsUrl(verification.runUrl, "verification.runUrl", errors);
    expectPattern(verification.conformanceReportSha256, SHA256_HEX, "verification.conformanceReportSha256", errors);
  }

  rejectPlaceholders(value, "manifest", errors);

  if (errors.length > 0) {
    throw new ManifestValidationError(errors);
  }

  return value as LipReleaseManifestV1;
}

export async function readManifestFile(path: string): Promise<LipReleaseManifestV1> {
  const raw = await readFile(path, "utf8");
  return validateLipReleaseManifest(JSON.parse(raw) as unknown);
}

export async function checkManifestFile(path: string): Promise<{ manifest: LipReleaseManifestV1; digest: string }> {
  const manifest = await readManifestFile(path);
  return { manifest, digest: manifestDigest(manifest) };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
  }
  return value;
}

function objectAt(value: unknown, path: string, errors: string[]): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  return value as JsonRecord;
}

function arrayAt(value: unknown, path: string, errors: string[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  return value;
}

function stringAt(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return undefined;
  }
  if (value.trim() !== value || value.length === 0) {
    errors.push(`${path} must be non-empty and trimmed`);
    return undefined;
  }
  return value;
}

function expectPattern(value: unknown, pattern: RegExp, path: string, errors: string[]): void {
  const text = stringAt(value, path, errors);
  if (text && !pattern.test(text)) {
    errors.push(`${path} has invalid format`);
  }
}

function expectHttpsUrl(value: unknown, path: string, errors: string[]): void {
  const text = stringAt(value, path, errors);
  if (!text) return;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") errors.push(`${path} must be an HTTPS URL`);
  } catch {
    errors.push(`${path} must be a valid URL`);
  }
}

function expectExact(value: unknown, expected: unknown, path: string, errors: string[]): void {
  if (value !== expected) {
    errors.push(`${path} must be ${JSON.stringify(expected)}`);
  }
}

function expectNonNegativeInteger(value: unknown, path: string, errors: string[]): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    errors.push(`${path} must be a non-negative integer`);
  }
}

function rejectMutable(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string" && ["main", "master", "dev", "latest"].includes(value.toLowerCase())) {
    errors.push(`${path} must be immutable release evidence, not ${value}`);
  }
}

function rejectPlaceholders(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    if (/TODO|TBD|REPLACE_ME|CHANGE_ME/i.test(value)) {
      errors.push(`${path} contains placeholder value ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPlaceholders(item, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    for (const [key, item] of Object.entries(record)) {
      rejectPlaceholders(item, `${path}.${key}`, errors);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? resolve(import.meta.dirname, "../docs/releases/lip-release-manifest.example.json");
  const result = await checkManifestFile(path);
  console.log(JSON.stringify({ ok: true, path, digest: result.digest }, null, 2));
}
