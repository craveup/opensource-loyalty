import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Hex } from "./check-release-manifest.js";

type FindingSeverity = "moderate" | "high" | "critical";

interface NpmAuditVulnerability {
  name?: string;
  severity?: string;
  range?: string;
}

interface NpmAuditReport {
  auditReportVersion: number;
  vulnerabilities: Record<string, NpmAuditVulnerability>;
  metadata: {
    vulnerabilities: Record<string, number>;
  };
}

interface DependencyRiskRegister {
  schemaVersion: 1;
  lockfileSha256: string;
  auditReportSha256: string;
  reviewedAt: string;
  expiresAt: string;
  findings: RiskRegisterFinding[];
}

interface RiskRegisterFinding {
  name: string;
  severity: FindingSeverity;
  range: string;
  status: "approved" | "mitigated";
  reviewedBy: string;
  justification: string;
  expiresAt?: string;
}

export interface ReleaseEvidenceSummary {
  auditReportSha256: string;
  sbomSha256: string;
  riskRegisterSha256: string;
  conformanceReportSha256: string;
  findings: {
    moderate: number;
    high: number;
    critical: number;
    unapprovedHigh: 0;
    unapprovedCritical: 0;
  };
}

interface PrepareReleaseEvidenceOptions {
  auditPath: string;
  sbomPath: string;
  riskRegisterPath: string;
  conformanceReportPath: string;
  lockfilePath: string;
  outDir: string;
  now?: Date;
}

export async function prepareReleaseEvidence(options: PrepareReleaseEvidenceOptions): Promise<ReleaseEvidenceSummary> {
  const auditRaw = await readFile(options.auditPath, "utf8");
  const sbomRaw = await readFile(options.sbomPath);
  const riskRaw = await readFile(options.riskRegisterPath, "utf8");
  const conformanceReportRaw = await readFile(options.conformanceReportPath);
  const lockfileRaw = await readFile(options.lockfilePath);
  const auditReportSha256 = sha256Hex(auditRaw);
  const sbomSha256 = sha256Hex(sbomRaw);
  const riskRegisterSha256 = sha256Hex(riskRaw);
  const conformanceReportSha256 = sha256Hex(conformanceReportRaw);
  const lockfileSha256 = sha256Hex(lockfileRaw);
  const audit = validateNpmAuditReport(JSON.parse(auditRaw) as unknown);
  const riskRegister = validateRiskRegister(JSON.parse(riskRaw) as unknown, {
    auditReportSha256,
    lockfileSha256,
    now: options.now ?? new Date()
  });
  const findings = deriveFindings(audit, riskRegister);

  await mkdir(options.outDir, { recursive: true });
  await copyFile(options.riskRegisterPath, join(options.outDir, "risk-register.json"));

  return {
    auditReportSha256,
    sbomSha256,
    riskRegisterSha256,
    conformanceReportSha256,
    findings
  };
}

export function validateNpmAuditReport(value: unknown): NpmAuditReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("npm audit output must be a JSON object");
  }
  const report = value as Record<string, unknown>;
  if ("error" in report) {
    throw new Error("npm audit output is an error response, not a valid npm audit report");
  }
  if (typeof report.auditReportVersion !== "number") {
    throw new Error("npm audit output must include auditReportVersion");
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)) {
    throw new Error("npm audit output must include a vulnerabilities object");
  }
  const metadata = report.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("npm audit output must include metadata");
  }
  const metadataVulnerabilities = (metadata as Record<string, unknown>).vulnerabilities;
  if (
    !metadataVulnerabilities ||
    typeof metadataVulnerabilities !== "object" ||
    Array.isArray(metadataVulnerabilities)
  ) {
    throw new Error("npm audit output must include metadata.vulnerabilities");
  }
  for (const severity of ["moderate", "high", "critical"] as const) {
    if (typeof (metadataVulnerabilities as Record<string, unknown>)[severity] !== "number") {
      throw new Error(`npm audit output must include metadata.vulnerabilities.${severity}`);
    }
  }

  return value as NpmAuditReport;
}

export function validateRiskRegister(
  value: unknown,
  expected: { auditReportSha256: string; lockfileSha256: string; now: Date }
): DependencyRiskRegister {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dependency risk register must be a JSON object");
  }
  const register = value as Record<string, unknown>;
  if (register.schemaVersion !== 1) throw new Error("dependency risk register schemaVersion must be 1");
  if (register.auditReportSha256 !== expected.auditReportSha256) {
    throw new Error("dependency risk register auditReportSha256 does not match the candidate audit report");
  }
  if (register.lockfileSha256 !== expected.lockfileSha256) {
    throw new Error("dependency risk register lockfileSha256 does not match package-lock.json");
  }
  assertActiveDate(register.reviewedAt, "dependency risk register reviewedAt", expected.now);
  assertFutureDate(register.expiresAt, "dependency risk register expiresAt", expected.now);
  if (!Array.isArray(register.findings)) throw new Error("dependency risk register findings must be an array");
  for (const [index, finding] of register.findings.entries()) {
    validateRiskRegisterFinding(finding, `dependency risk register findings[${index}]`, expected.now);
  }

  return value as DependencyRiskRegister;
}

export function deriveFindings(
  audit: NpmAuditReport,
  riskRegister: DependencyRiskRegister
): ReleaseEvidenceSummary["findings"] {
  const totals = { moderate: 0, high: 0, critical: 0 };
  const triageKeys = new Set(riskRegister.findings.map((finding) => triageKey(finding)));
  let untriagedModerate = 0;
  let unapprovedHigh = 0;
  let unapprovedCritical = 0;

  for (const [key, vulnerability] of Object.entries(audit.vulnerabilities)) {
    const severity = vulnerability.severity;
    if (!isFindingSeverity(severity)) continue;
    totals[severity] += 1;
    const findingKey = triageKey({
      name: vulnerability.name ?? key,
      severity,
      range: vulnerability.range ?? ""
    });
    if (!triageKeys.has(findingKey)) {
      if (severity === "moderate") untriagedModerate += 1;
      if (severity === "high") unapprovedHigh += 1;
      if (severity === "critical") unapprovedCritical += 1;
    }
  }

  if (untriagedModerate > 0 || unapprovedHigh > 0 || unapprovedCritical > 0) {
    throw new Error(
      `Untriaged dependency findings: moderate=${untriagedModerate}, high=${unapprovedHigh}, critical=${unapprovedCritical}`
    );
  }

  return {
    moderate: totals.moderate,
    high: totals.high,
    critical: totals.critical,
    unapprovedHigh: 0,
    unapprovedCritical: 0
  };
}

function validateRiskRegisterFinding(value: unknown, path: string, now: Date): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const finding = value as Record<string, unknown>;
  requireNonEmptyString(finding.name, `${path}.name`);
  if (!isFindingSeverity(finding.severity as string | undefined)) {
    throw new Error(`${path}.severity must be moderate, high, or critical`);
  }
  requireNonEmptyString(finding.range, `${path}.range`);
  if (finding.status !== "approved" && finding.status !== "mitigated") {
    throw new Error(`${path}.status must be approved or mitigated`);
  }
  requireNonEmptyString(finding.reviewedBy, `${path}.reviewedBy`);
  requireNonEmptyString(finding.justification, `${path}.justification`);
  if (finding.expiresAt !== undefined) assertFutureDate(finding.expiresAt, `${path}.expiresAt`, now);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function assertActiveDate(value: unknown, path: string, now: Date): void {
  const timestamp = Date.parse(requireNonEmptyString(value, path));
  if (!Number.isFinite(timestamp) || timestamp > now.getTime()) {
    throw new Error(`${path} must be a valid past or current timestamp`);
  }
}

function assertFutureDate(value: unknown, path: string, now: Date): void {
  const timestamp = Date.parse(requireNonEmptyString(value, path));
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    throw new Error(`${path} must be a valid future timestamp`);
  }
}

function isFindingSeverity(value: string | undefined): value is FindingSeverity {
  return value === "moderate" || value === "high" || value === "critical";
}

function triageKey(finding: { name: string; severity: FindingSeverity; range: string }): string {
  return `${finding.name}\0${finding.severity}\0${finding.range}`;
}

function requiredOption(args: Map<string, string>, name: string, fallback?: string): string {
  const value = args.get(name) ?? fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --name value at argument ${index + 1}`);
    }
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}

function appendGitHubOutputs(summary: ReleaseEvidenceSummary): string {
  return [
    `audit_report_sha256=${summary.auditReportSha256}`,
    `sbom_sha256=${summary.sbomSha256}`,
    `risk_register_sha256=${summary.riskRegisterSha256}`,
    `conformance_report_sha256=${summary.conformanceReportSha256}`,
    `moderate=${summary.findings.moderate}`,
    `high=${summary.findings.high}`,
    `critical=${summary.findings.critical}`,
    `unapproved_high=${summary.findings.unapprovedHigh}`,
    `unapproved_critical=${summary.findings.unapprovedCritical}`
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(requiredOption(args, "--out-dir", ".lip"));
  const summary = await prepareReleaseEvidence({
    auditPath: resolve(requiredOption(args, "--audit")),
    sbomPath: resolve(requiredOption(args, "--sbom")),
    riskRegisterPath: resolve(requiredOption(args, "--risk-register", process.env.LIP_RELEASE_RISK_REGISTER_PATH)),
    conformanceReportPath: resolve(requiredOption(args, "--conformance-report")),
    lockfilePath: resolve(requiredOption(args, "--lockfile", "package-lock.json")),
    outDir
  });
  const outputs = appendGitHubOutputs(summary);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_OUTPUT, `${outputs}\n`);
  }
  console.log(JSON.stringify({ ok: true, outDir, ...summary }, null, 2));
}
