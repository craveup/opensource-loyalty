import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../scripts/check-release-manifest.js";
import {
  deriveFindings,
  prepareReleaseEvidence,
  validateNpmAuditReport,
  validateRiskRegister
} from "../../scripts/prepare-release-evidence.js";

const now = new Date("2026-08-10T00:00:00.000Z");
const audit = validateNpmAuditReport({
  auditReportVersion: 2,
  vulnerabilities: {
    "moderate-package": {
      name: "moderate-package",
      severity: "moderate",
      range: "<1.0.1"
    },
    "high-package": {
      name: "high-package",
      severity: "high",
      range: "<2.0.1"
    },
    "critical-package": {
      name: "critical-package",
      severity: "critical",
      range: "<3.0.1"
    }
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 1,
      high: 1,
      critical: 1,
      total: 3
    }
  }
});

function approvedRiskRegister() {
  return validateRiskRegister({
    schemaVersion: 1,
    lockfileSha256: "b".repeat(64),
    auditReportSha256: "a".repeat(64),
    reviewedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-09-09T00:00:00.000Z",
    findings: [
      {
        name: "moderate-package",
        severity: "moderate",
        range: "<1.0.1",
        status: "approved",
        reviewedBy: "security@example.com",
        justification: "Reviewed and accepted for this release candidate."
      },
      {
        name: "high-package",
        severity: "high",
        range: "<2.0.1",
        status: "approved",
        reviewedBy: "security@example.com",
        justification: "No reachable runtime path in the release candidate."
      },
      {
        name: "critical-package",
        severity: "critical",
        range: "<3.0.1",
        status: "mitigated",
        reviewedBy: "security@example.com",
        justification: "Blocked by compensating control before exposure."
      }
    ]
  }, {
    auditReportSha256: "a".repeat(64),
    lockfileSha256: "b".repeat(64),
    now
  });
}

describe("release evidence preparation", () => {
  it("hashes and retains evidence from the current candidate files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lip-release-evidence-"));
    const auditPath = join(directory, "npm-audit.json");
    const sbomPath = join(directory, "sbom.cdx.json");
    const riskRegisterPath = join(directory, "risk-register.reviewed.json");
    const conformanceReportPath = join(directory, "conformance-report.json");
    const lockfilePath = join(directory, "package-lock.json");
    const outDir = join(directory, "out");
    const auditRaw = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0
        }
      }
    });
    const lockfileRaw = JSON.stringify({ lockfileVersion: 3 });
    const riskRegisterRaw = JSON.stringify({
      schemaVersion: 1,
      lockfileSha256: sha256Hex(lockfileRaw),
      auditReportSha256: sha256Hex(auditRaw),
      reviewedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-09-09T00:00:00.000Z",
      findings: []
    });
    const sbomRaw = JSON.stringify({ bomFormat: "CycloneDX" });
    const conformanceReportRaw = JSON.stringify({ numTotalTests: 2, success: true });

    await writeFile(auditPath, auditRaw);
    await writeFile(sbomPath, sbomRaw);
    await writeFile(riskRegisterPath, riskRegisterRaw);
    await writeFile(conformanceReportPath, conformanceReportRaw);
    await writeFile(lockfilePath, lockfileRaw);

    const summary = await prepareReleaseEvidence({
      auditPath,
      sbomPath,
      riskRegisterPath,
      conformanceReportPath,
      lockfilePath,
      outDir,
      now
    });

    expect(summary).toMatchObject({
      auditReportSha256: sha256Hex(auditRaw),
      sbomSha256: sha256Hex(sbomRaw),
      riskRegisterSha256: sha256Hex(riskRegisterRaw),
      conformanceReportSha256: sha256Hex(conformanceReportRaw),
      findings: {
        moderate: 0,
        high: 0,
        critical: 0,
        unapprovedHigh: 0,
        unapprovedCritical: 0
      }
    });
    await expect(readFile(join(outDir, "risk-register.json"), "utf8")).resolves.toBe(riskRegisterRaw);
  });

  it("generates a checksummed zero-finding register when the live audit is clean", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lip-zero-risk-evidence-"));
    const auditPath = join(directory, "npm-audit.json");
    const sbomPath = join(directory, "sbom.cdx.json");
    const conformanceReportPath = join(directory, "conformance-report.json");
    const lockfilePath = join(directory, "package-lock.json");
    const outDir = join(directory, "out");
    const auditRaw = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }
      }
    });
    const lockfileRaw = JSON.stringify({ lockfileVersion: 3 });

    await writeFile(auditPath, auditRaw);
    await writeFile(sbomPath, JSON.stringify({ bomFormat: "CycloneDX" }));
    await writeFile(conformanceReportPath, JSON.stringify({ numTotalTests: 2, success: true }));
    await writeFile(lockfilePath, lockfileRaw);

    const summary = await prepareReleaseEvidence({
      auditPath,
      sbomPath,
      conformanceReportPath,
      lockfilePath,
      outDir,
      now
    });
    const retained = JSON.parse(await readFile(join(outDir, "risk-register.json"), "utf8"));

    expect(retained).toEqual({
      schemaVersion: 1,
      lockfileSha256: sha256Hex(lockfileRaw),
      auditReportSha256: sha256Hex(auditRaw),
      reviewedAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-09-09T00:00:00.000Z",
      findings: []
    });
    expect(summary.riskRegisterSha256).toBe(
      sha256Hex(`${JSON.stringify(retained, null, 2)}\n`)
    );
  });

  it("requires an explicit reviewed register when the live audit has actionable findings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lip-reviewed-risk-evidence-"));
    const auditPath = join(directory, "npm-audit.json");
    const sbomPath = join(directory, "sbom.cdx.json");
    const conformanceReportPath = join(directory, "conformance-report.json");
    const lockfilePath = join(directory, "package-lock.json");

    await writeFile(auditPath, JSON.stringify(audit));
    await writeFile(sbomPath, JSON.stringify({ bomFormat: "CycloneDX" }));
    await writeFile(conformanceReportPath, JSON.stringify({ numTotalTests: 2, success: true }));
    await writeFile(lockfilePath, JSON.stringify({ lockfileVersion: 3 }));

    await expect(prepareReleaseEvidence({
      auditPath,
      sbomPath,
      conformanceReportPath,
      lockfilePath,
      outDir: join(directory, "out"),
      now
    })).rejects.toThrow(/explicit reviewed risk register/);
  });

  it("rejects npm audit error responses", () => {
    expect(() =>
      validateNpmAuditReport({
        error: {
          code: "EAUDITNOPJSON",
          summary: "audit endpoint rejected the request"
        }
      })
    ).toThrow(/error response/);
  });

  it("derives zero unapproved high and critical findings from the risk register", () => {
    expect(deriveFindings(audit, approvedRiskRegister())).toEqual({
      moderate: 1,
      high: 1,
      critical: 1,
      unapprovedHigh: 0,
      unapprovedCritical: 0
    });
  });

  it("rejects stale risk registers and missing triage records", () => {
    expect(() =>
      validateRiskRegister({
        schemaVersion: 1,
        lockfileSha256: "b".repeat(64),
        auditReportSha256: "c".repeat(64),
        reviewedAt: "2026-08-09T00:00:00.000Z",
        expiresAt: "2026-09-09T00:00:00.000Z",
        findings: []
      }, {
        auditReportSha256: "a".repeat(64),
        lockfileSha256: "b".repeat(64),
        now
      })
    ).toThrow(/auditReportSha256/);

    expect(() =>
      deriveFindings(audit, {
        ...approvedRiskRegister(),
        findings: []
      })
    ).toThrow(/Untriaged dependency findings: moderate=1, high=1, critical=1/);

    expect(() =>
      deriveFindings(audit, {
        ...approvedRiskRegister(),
        findings: approvedRiskRegister().findings.filter((finding) => finding.severity !== "moderate")
      })
    ).toThrow(/moderate=1/);
  });
});
