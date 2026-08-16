import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  canonicalJson,
  sha256Hex,
  validateLipReleaseManifest,
  type LipReleaseManifestV1
} from "./check-release-manifest.js";

const exec = promisify(execFile);

const packageWorkspaces = [
  "@loyalty-interchange/protocol",
  "@loyalty-interchange/adapter-kit",
  "@loyalty-interchange/storage",
  "@loyalty-interchange/reference",
  "@loyalty-interchange/storage-sqlite",
  "@loyalty-interchange/storage-postgres",
  "@loyalty-interchange/server",
  "@loyalty-interchange/sdk",
  "@loyalty-interchange/identity",
  "@loyalty-interchange/cli",
  "@loyalty-interchange/mcp"
];
const migrationDirectories = ["apps/cloud/migrations", "packages/storage-postgres/migrations"];

interface NpmPackResult {
  name: string;
  version: string;
  integrity: string;
}

export interface ReleaseArtifactInputs {
  imageReference: string;
  imageDigest: `sha256:${string}`;
  imageProvenanceUrl: string;
  auditReportSha256: string;
  sbomSha256: string;
  riskRegisterSha256: string;
  findings: {
    moderate: number;
    high: number;
    critical: number;
    unapprovedHigh: 0;
    unapprovedCritical: 0;
  };
  verificationRunUrl: string;
  conformanceReportSha256: string;
}

export interface ReleaseCollectors {
  collectPackages(root: string): Promise<LipReleaseManifestV1["packages"]>;
  git(args: string[], root: string): Promise<string>;
  npm(args: string[], root: string): Promise<string>;
}

export interface GenerateManifestOptions {
  root: string;
  artifacts: ReleaseArtifactInputs;
  collectors?: Partial<ReleaseCollectors>;
}

export async function generateLipReleaseManifest(options: GenerateManifestOptions): Promise<LipReleaseManifestV1> {
  const root = options.root;
  const collectors = {
    collectPackages,
    git: gitOutput,
    npm: npmOutput,
    ...options.collectors
  };
  const sourceCommit = (await collectors.git(["rev-parse", "HEAD"], root)).trim();
  const sourceTag = await releaseTagForHead(root, collectors.git);
  const repository = normalizeRepository((await collectors.git(["remote", "get-url", "origin"], root)).trim());
  const npmVersion = (await collectors.npm(["--version"], root)).trim();
  const packages = await collectors.collectPackages(root);

  return validateLipReleaseManifest({
    schemaVersion: 1,
    source: {
      repository,
      commit: sourceCommit,
      tag: sourceTag
    },
    protocol: {
      version: "1.0",
      profile: "foodservice/1.0",
      openapiSha256: await sha256File(resolve(root, "spec/openapi.yaml"))
    },
    packages,
    image: {
      reference: options.artifacts.imageReference,
      digest: options.artifacts.imageDigest,
      provenanceUrl: options.artifacts.imageProvenanceUrl
    },
    database: {
      migrationSetSha256: await migrationSetSha256(root),
      connectionMode: "direct"
    },
    dependencies: {
      lockfileSha256: await sha256File(resolve(root, "package-lock.json")),
      auditReportSha256: options.artifacts.auditReportSha256,
      sbomSha256: options.artifacts.sbomSha256,
      riskRegisterSha256: options.artifacts.riskRegisterSha256,
      toolchain: {
        node: process.versions.node,
        npm: npmVersion
      },
      findings: options.artifacts.findings
    },
    verification: {
      runUrl: options.artifacts.verificationRunUrl,
      conformanceReportSha256: options.artifacts.conformanceReportSha256
    }
  });
}

export async function migrationSetSha256(root: string): Promise<string> {
  const migrations = await deployedMigrationPaths(root);
  const entries = await Promise.all(
    migrations.map(async (path) => ({
      path,
      sha256: await sha256File(resolve(root, path))
    }))
  );
  return sha256Hex(canonicalJson(entries));
}

export async function deployedMigrationPaths(root: string): Promise<string[]> {
  const migrations = (
    await Promise.all(
      migrationDirectories.map(async (directory) => {
        const entries = await readdir(resolve(root, directory), { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
          .map((entry) => `${directory}/${entry.name}`);
      })
    )
  ).flat().sort();

  if (migrations.length === 0) {
    throw new Error("No deployed SQL migrations found");
  }

  return migrations;
}

export function normalizeRepository(remoteUrl: string): string {
  const gitHubMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (gitHubMatch?.[1]) return gitHubMatch[1];
  throw new Error(`Unable to derive GitHub repository from origin remote: ${remoteUrl}`);
}

export async function collectPackages(root: string): Promise<LipReleaseManifestV1["packages"]> {
  const packages: LipReleaseManifestV1["packages"] = [];
  for (const workspace of packageWorkspaces) {
    const { stdout } = await exec("npm", [
      "pack",
      "--dry-run",
      "--workspace",
      workspace,
      "--json",
      "--ignore-scripts"
    ], { cwd: root, maxBuffer: 1024 * 1024 * 10 });
    const result = parseNpmPack(stdout, workspace);
    packages.push({
      name: result.name,
      version: result.version,
      integrity: result.integrity
    });
  }
  return packages;
}

export function parseNpmPack(stdout: string, workspace: string): NpmPackResult {
  const jsonStart = stdout.lastIndexOf("\n[");
  const json = jsonStart >= 0 ? stdout.slice(jsonStart + 1) : stdout;
  const result = (JSON.parse(json) as NpmPackResult[])[0];
  if (!result) throw new Error(`npm pack returned no result for ${workspace}`);
  if (result.name !== workspace) {
    throw new Error(`npm pack returned ${result.name}, expected ${workspace}`);
  }
  if (!result.integrity) {
    throw new Error(`npm pack returned no integrity for ${workspace}`);
  }
  return result;
}

async function releaseTagForHead(root: string, git: ReleaseCollectors["git"]): Promise<string> {
  const tags = (await git(["tag", "--points-at", "HEAD"], root))
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => /^v?[0-9]+\.[0-9]+\.[0-9]+/.test(tag));
  if (tags.length === 1 && tags[0]) return tags[0];

  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  throw new Error(`Expected exactly one release tag at HEAD, found ${tags.length}`);
}

async function sha256File(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

async function gitOutput(args: string[], root: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: root });
  return stdout;
}

async function npmOutput(args: string[], root: string): Promise<string> {
  const { stdout } = await exec("npm", args, { cwd: root });
  return stdout;
}

function requiredOption(args: Map<string, string>, name: string, envName: string): string {
  const value = args.get(name) ?? process.env[envName];
  if (!value) throw new Error(`Missing ${name} or ${envName}`);
  return value;
}

function requiredCount(args: Map<string, string>, name: string, envName: string): number {
  const value = Number.parseInt(requiredOption(args, name, envName), 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
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

function artifactsFromArgs(args: Map<string, string>): ReleaseArtifactInputs {
  return {
    imageReference: requiredOption(args, "--image-reference", "LIP_RELEASE_IMAGE_REFERENCE"),
    imageDigest: requiredOption(args, "--image-digest", "LIP_RELEASE_IMAGE_DIGEST") as `sha256:${string}`,
    imageProvenanceUrl: requiredOption(args, "--image-provenance-url", "LIP_RELEASE_IMAGE_PROVENANCE_URL"),
    auditReportSha256: requiredOption(args, "--audit-report-sha256", "LIP_RELEASE_AUDIT_REPORT_SHA256"),
    sbomSha256: requiredOption(args, "--sbom-sha256", "LIP_RELEASE_SBOM_SHA256"),
    riskRegisterSha256: requiredOption(args, "--risk-register-sha256", "LIP_RELEASE_RISK_REGISTER_SHA256"),
    findings: {
      moderate: requiredCount(args, "--moderate", "LIP_RELEASE_FINDINGS_MODERATE"),
      high: requiredCount(args, "--high", "LIP_RELEASE_FINDINGS_HIGH"),
      critical: requiredCount(args, "--critical", "LIP_RELEASE_FINDINGS_CRITICAL"),
      unapprovedHigh: requiredCount(args, "--unapproved-high", "LIP_RELEASE_UNAPPROVED_HIGH") as 0,
      unapprovedCritical: requiredCount(args, "--unapproved-critical", "LIP_RELEASE_UNAPPROVED_CRITICAL") as 0
    },
    verificationRunUrl: requiredOption(args, "--verification-run-url", "LIP_RELEASE_VERIFICATION_RUN_URL"),
    conformanceReportSha256: requiredOption(
      args,
      "--conformance-report-sha256",
      "LIP_RELEASE_CONFORMANCE_REPORT_SHA256"
    )
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const out = args.get("--out") ?? "docs/releases/lip-release-manifest.generated.json";
  args.delete("--out");
  const root = resolve(import.meta.dirname, "..");
  const manifest = await generateLipReleaseManifest({ root, artifacts: artifactsFromArgs(args) });
  const outputPath = resolve(root, out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, canonicalJson(manifest));
  console.log(JSON.stringify({ ok: true, path: relative(root, outputPath) }, null, 2));
}
