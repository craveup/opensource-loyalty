#!/usr/bin/env node

import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { runCloudVerification } from "./cloud-verify.js";
import { defaultConfig, initializeConfig, readConfig } from "./config.js";
import { formatReport, runBaselineConformance, runDoctor } from "./diagnostics.js";
import { runStateExport, runStateImport, type StateExportOptions, type StateImportOptions } from "./migration.js";
import { runMockServer } from "./mock.js";
import {
  runMemberImportPlan,
  runMemberImportReconciliation
} from "./member-migration.js";
import { schemaNames, validateFile } from "./validate.js";

interface ConnectionFlags {
  apiKey?: string;
}

async function connection(url: string | undefined, flags: ConnectionFlags) {
  const config = await readConfig();
  const apiKeyEnvironment = config?.api_key_env ?? defaultConfig.api_key_env;
  return {
    baseUrl: url ?? config?.base_url ?? defaultConfig.base_url,
    apiKey: flags.apiKey ?? process.env[apiKeyEnvironment] ?? "lip-dev-key"
  };
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new InvalidArgumentError("port must be an integer between 1 and 65535");
  }
  return parsed;
}

function positiveCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1_000_000) {
    throw new InvalidArgumentError("value must be an integer between 1 and 1000000");
  }
  return parsed;
}

const program = new Command()
  .name("lip")
  .description("Build, validate, and test Loyalty Interchange Protocol integrations")
  .version("0.2.0")
  .showSuggestionAfterError();

program
  .command("init [directory]")
  .description("Create a minimal lip.config.json")
  .option("-f, --force", "replace an existing configuration")
  .action(async (directory = ".", options: { force?: boolean }) => {
    const target = await initializeConfig(
      resolve(directory),
      options.force ? { force: true } : {}
    );
    console.log(`Created ${target}`);
    console.log("");
    console.log("Agent setup (recommended for Cursor, Claude Code, Codex):");
    console.log("  npx skills add .");
    console.log("  Enable MCP: add mcp.json from this repo to your Cursor MCP settings");
    console.log("  Docs: docs/using-lip-with-ai.md");
  });

program
  .command("schemas")
  .description("List schemas accepted by lip validate")
  .action(() => {
    console.log(schemaNames().join("\n"));
  });

program
  .command("validate <file>")
  .description("Validate a JSON payload against a LIP schema")
  .requiredOption("-s, --schema <name>", "schema name, for example FoodserviceOrder")
  .action(async (file: string, options: { schema: string }) => {
    const result = await validateFile(file, options.schema);
    if (result.ok) {
      console.log(`[pass] ${result.file} is valid ${result.schema}`);
      return;
    }
    for (const issue of result.issues) {
      console.error(`[fail] ${issue.path} ${issue.message} (${issue.keyword})`);
    }
    process.exitCode = 1;
  });

function addMockCommand(name: "mock" | "quickstart" | "serve", description: string): void {
  program
    .command(name)
    .description(description)
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("-p, --port <port>", "listen port", positiveInteger, 3210)
    .option("-k, --api-key <key>", "Admin/API key for dashboard sign-in and Bearer auth", "lip-dev-key")
    .option("-d, --database <path>", "SQLite state path", process.env.LIP_DATABASE_PATH ?? ".lip/reference.db")
    .option("--reset", "clear persisted state before starting")
    .option("--no-seed", "start without synthetic members and activity")
    .option("--program <path>", "JSON program definition replacing the built-in demo program")
    .option("--rate-limit <requests>", "requests allowed per client window", positiveCount, 120)
    .option("--rate-window-ms <milliseconds>", "rate-limit window in milliseconds", positiveCount, 60_000)
    .option("--no-structured-logs", "disable JSON request logs")
    .option("--write-freeze", "start with /lip/v1 writes frozen (maintenance mode)")
    .action(async (options: {
      host: string;
      port: number;
      apiKey: string;
      database: string;
      reset?: boolean;
      seed: boolean;
      program?: string;
      rateLimit: number;
      rateWindowMs: number;
      structuredLogs: boolean;
      writeFreeze?: boolean;
    }) => {
      if (options.apiKey.length < 8) throw new Error("API key must contain at least 8 characters");
      await runMockServer({
        host: options.host,
        port: options.port,
        apiKey: options.apiKey,
        databasePath: resolve(options.database),
        ...(options.reset ? { reset: true } : {}),
        seed: options.seed,
        rateLimit: {
          maxRequests: options.rateLimit,
          windowMs: options.rateWindowMs
        },
        structuredLogs: options.structuredLogs,
        ...(options.program ? { programPath: resolve(options.program) } : {}),
        writeFrozen: options.writeFreeze || process.env.LIP_WRITE_FREEZE === "true" || process.env.LIP_WRITE_FREEZE === "1"
      });
    });
}

addMockCommand("mock", "Start the stateful LIP reference server");
addMockCommand("quickstart", "Start the local environment and print connection details");
addMockCommand("serve", "Start the local reference API and Admin dashboard");

const state = program
  .command("state")
  .description("Export or import complete loyalty engine state for migration");

state
  .command("export")
  .description("Export members, balances, ledger, reservations, and idempotency records")
  .requiredOption("--program <path>", "active JSON program definition")
  .requiredOption("-o, --output <path>", "destination archive path")
  .option("-d, --database <path>", "SQLite state path (defaults to LIP_DATABASE_PATH)")
  .option("--database-url <url>", "Postgres URL (defaults to LIP_DATABASE_URL)")
  .option("--tenant-id <id>", "Postgres tenant id (defaults to LIP_TENANT_ID or program id)")
  .option("--force", "replace an existing archive file")
  .action(async (options: StateExportOptions) => {
    await runStateExport(options);
  });

const migration = program
  .command("migration")
  .description("Plan and reconcile a member/balance migration without writing to a live host");

migration
  .command("plan")
  .description("Create a checksummed LIP enrollment and opening-balance plan from JSON or CSV")
  .requiredOption("--program-id <id>", "target LIP program id")
  .requiredOption("-i, --input <path>", "JSON array or CSV source")
  .requiredOption("-o, --output <path>", "private plan output path")
  .option("--force", "replace an existing plan")
  .action(async (options: { programId: string; input: string; output: string; force?: boolean }) => {
    const plan = await runMemberImportPlan(options);
    console.log(
      `Planned ${plan.summary.members} members and ${plan.summary.nonzero_balances} opening balances`
    );
    console.log(`Plan: ${resolve(options.output)}`);
  });

migration
  .command("reconcile")
  .description("Compare a member import plan with a checksummed LIP state archive")
  .requiredOption("--plan <path>", "member import plan")
  .requiredOption("--archive <path>", "LIP state archive exported after migration")
  .option("-o, --output <path>", "optional private reconciliation report")
  .option("--force", "replace an existing report")
  .action(async (options: { plan: string; archive: string; output?: string; force?: boolean }) => {
    const report = await runMemberImportReconciliation(options);
    console.log(
      `${report.passed ? "[pass]" : "[fail]"} ${report.summary.matched}/${report.summary.expected_members} members reconciled`
    );
    if (!report.passed) process.exitCode = 1;
  });

state
  .command("import")
  .description("Import a complete state archive into an offline or frozen target")
  .requiredOption("--program <path>", "target JSON program definition")
  .requiredOption("-i, --input <path>", "source archive path")
  .option("-d, --database <path>", "SQLite state path (defaults to LIP_DATABASE_PATH)")
  .option("--database-url <url>", "Postgres URL (defaults to LIP_DATABASE_URL)")
  .option("--tenant-id <id>", "Postgres tenant id (defaults to LIP_TENANT_ID or program id)")
  .option("--force", "replace existing target engine state")
  .action(async (options: StateImportOptions) => {
    await runStateImport(options);
  });

program
  .command("doctor [url]")
  .description("Check discovery, health, authentication, and capabilities")
  .option("-k, --api-key <key>", "Admin/API key for Bearer auth")
  .action(async (url: string | undefined, options: ConnectionFlags) => {
    const report = await runDoctor(await connection(url, options));
    console.log(formatReport(report));
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("test [url]")
  .description("Run baseline non-destructive HTTP conformance checks")
  .option("-k, --api-key <key>", "Admin/API key for Bearer auth")
  .action(async (url: string | undefined, options: ConnectionFlags) => {
    const report = await runBaselineConformance(await connection(url, options));
    console.log(formatReport(report));
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("cloud-verify [url]")
  .description("Run doctor + baseline conformance and optional member checks against a provisioned host")
  .option("-k, --api-key <key>", "Admin/API key for Bearer auth")
  .option("--program-id <id>", "Program id (required for --expect-member)")
  .option("--expect-member <identity>", "Known member token identity to verify")
  .option("--expect-available <n>", "Expected available balance for --expect-member")
  .option("--expect-members <n>", "Expected total member count (uses the non-normative admin snapshot)")
  .action(async (url: string | undefined, options: ConnectionFlags & {
    programId?: string; expectMember?: string; expectAvailable?: string; expectMembers?: string;
  }) => {
    const conn = await connection(url, options);
    const expectations: Parameters<typeof runCloudVerification>[1] = {};
    if (options.programId) expectations.programId = options.programId;
    if (options.expectMember !== undefined) {
      if (options.expectAvailable === undefined) throw new Error("--expect-available is required with --expect-member");
      expectations.expectMember = {
        identity: { type: "token", value: options.expectMember },
        available: Number(options.expectAvailable)
      };
    }
    if (options.expectMembers !== undefined) expectations.expectMembers = Number(options.expectMembers);
    const report = await runCloudVerification(conn, expectations);
    console.log(formatReport(report.doctor));
    console.log(formatReport(report.conformance));
    if (report.knownMember) {
      console.log(`[${report.knownMember.ok ? "pass" : "fail"}] known member available: expected ${report.knownMember.expected}, got ${report.knownMember.actual}`);
    }
    if (report.memberCount) {
      console.log(`[${report.memberCount.ok ? "pass" : "fail"}] member count: expected ${report.memberCount.expected}, got ${report.memberCount.actual}`);
    }
    if (!report.ok) process.exitCode = 1;
  });

await program.parseAsync();
