import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { startReferenceServer } from "@loyalty-interchange/server";
import {
  defaultConfig,
  formatReport,
  formatServerReady,
  initializeConfig,
  readConfig,
  runBaselineConformance,
  runDoctor,
  schemaNames,
  startMockServer,
  validateFile
} from "@loyalty-interchange/cli";
import { makeProgram } from "../fixtures.js";

const execFileAsync = promisify(execFile);
const cliEntry = resolve(import.meta.dirname, "../../packages/cli/dist/cli.js");

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "lip-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("lip CLI configuration", () => {
  it("initializes, reads, protects, and force-replaces configuration", async () => {
    const directory = await temporaryDirectory();
    const target = await initializeConfig(directory);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(defaultConfig);
    expect(await readConfig(directory)).toEqual(defaultConfig);

    await expect(initializeConfig(directory)).rejects.toThrow(/Refusing to overwrite/);
    await writeFile(target, "{}\n", "utf8");
    await initializeConfig(directory, { force: true });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(defaultConfig);
  });

  it("returns undefined when no local configuration exists", async () => {
    expect(await readConfig(await temporaryDirectory())).toBeUndefined();
  });
});

describe("lip validate", () => {
  it("validates a checked-in order and lists the schema", async () => {
    const file = resolve(import.meta.dirname, "../../spec/examples/paid-order.json");
    const result = await validateFile(file, "FoodserviceOrder");
    expect(result).toMatchObject({ ok: true, schema: "FoodserviceOrder", issues: [] });
    expect(schemaNames()).toContain("FoodserviceOrder");
  });

  it("reports malformed JSON, schema violations, and unknown schemas", async () => {
    const directory = await temporaryDirectory();
    const malformed = resolve(directory, "malformed.json");
    const invalid = resolve(directory, "invalid.json");
    await writeFile(malformed, "{not-json", "utf8");
    await writeFile(invalid, "{}\n", "utf8");

    expect(await validateFile(malformed, "FoodserviceOrder")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ keyword: "json" })]
    });
    expect(await validateFile(invalid, "FoodserviceOrder")).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: "required" })])
    });
    await expect(validateFile(invalid, "MissingSchema")).rejects.toThrow(/Unknown schema/);
  });
});

describe("lip diagnostics", () => {
  it("passes doctor and baseline conformance against the mock server", async () => {
    const running = await startMockServer({ host: "127.0.0.1", port: 0, apiKey: "cli-test-key" });
    try {
      const doctor = await runDoctor({ baseUrl: `${running.url}/`, apiKey: "cli-test-key" });
      expect(doctor.ok).toBe(true);
      expect(doctor.checks).toHaveLength(3);
      expect(formatReport(doctor)).toContain("PASS");

      const conformance = await runBaselineConformance({
        baseUrl: running.url,
        apiKey: "cli-test-key"
      });
      expect(conformance.ok).toBe(true);
      expect(conformance.checks).toHaveLength(5);
    } finally {
      await running.close();
    }
  });

  it("serves the location registry admin surface from the mock server", async () => {
    const running = await startMockServer({ host: "127.0.0.1", port: 0, apiKey: "cli-loc-key" });
    try {
      const listed = await fetch(`${running.url}/admin/api/v1/locations`, {
        headers: { authorization: "Bearer cli-loc-key" }
      });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        locations: [expect.objectContaining({ location_id: "location-014" })]
      });
      const report = await fetch(`${running.url}/admin/api/v1/reports/locations`, {
        headers: { authorization: "Bearer cli-loc-key" }
      });
      expect(report.status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it("returns actionable failures for a bad credential or unreachable server", async () => {
    const running = await startMockServer({ host: "127.0.0.1", port: 0, apiKey: "right-api-key" });
    try {
      const report = await runDoctor({ baseUrl: running.url, apiKey: "wrong-api-key" });
      expect(report.ok).toBe(false);
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: "authentication and capabilities",
        ok: false,
        detail: expect.stringContaining("HTTP 401")
      }));
      expect(formatReport(report)).toContain("FAIL");
    } finally {
      await running.close();
    }

    const unreachable = await runDoctor({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "unused-api-key"
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.checks.every((check) => !check.ok)).toBe(true);
  });
});

describe("lip cloud-verify command", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build", "--workspace", "@loyalty-interchange/cli"], {
      cwd: resolve(import.meta.dirname, "../..")
    });
  }, 120_000);

  async function seededServer() {
    const engine = new LoyaltyEngine(makeProgram());
    const ctx = (key: string) => ({
      protocol_version: "1.0" as const,
      profile: "foodservice/1.0" as const,
      request_id: `req-${key}`,
      idempotency_key: key,
      occurred_at: "2026-07-18T00:00:00.000Z",
      source: { system: "seed" }
    });
    engine.enroll({
      context: ctx("seed-enroll"),
      program_id: "demo-foodservice",
      identity: { type: "token", value: "known-guest" },
      member_id: "member-001"
    });
    const server = await startReferenceServer(engine, { apiKey: "cloud-verify-cli-key", port: 0 });
    return { server, apiKey: "cloud-verify-cli-key" };
  }

  it("prints doctor, conformance, and member reports and exits 0 when expectations match", async () => {
    const { server, apiKey } = await seededServer();
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        cliEntry,
        "cloud-verify",
        server.url,
        "--api-key", apiKey,
        "--program-id", "demo-foodservice",
        "--expect-member", "known-guest",
        "--expect-available", "0"
      ]);
      expect(stdout).toContain("LIP diagnostics");
      expect(stdout).toContain("known member available: expected 0, got 0");
    } finally {
      await server.close();
    }
  });

  it("exits non-zero when the known member's balance does not match", async () => {
    const { server, apiKey } = await seededServer();
    try {
      await expect(execFileAsync(process.execPath, [
        cliEntry,
        "cloud-verify",
        server.url,
        "--api-key", apiKey,
        "--program-id", "demo-foodservice",
        "--expect-member", "known-guest",
        "--expect-available", "999"
      ])).rejects.toMatchObject({ code: 1 });
    } finally {
      await server.close();
    }
  });
});

describe("lip serve write-freeze", () => {
  it("starts frozen when writeFrozen is set and reports write_frozen on /health", async () => {
    const running = await startMockServer({
      host: "127.0.0.1",
      port: 0,
      apiKey: "cli-test-key",
      writeFrozen: true
    });
    try {
      const response = await fetch(`${running.url}/health`);
      const body = await response.json();
      expect(body).toMatchObject({ write_frozen: true });
    } finally {
      await running.close();
    }
  });

  it("starts unfrozen by default", async () => {
    const running = await startMockServer({ host: "127.0.0.1", port: 0, apiKey: "cli-test-key" });
    try {
      const response = await fetch(`${running.url}/health`);
      const body = await response.json();
      expect(body).toMatchObject({ write_frozen: false });
    } finally {
      await running.close();
    }
  });
});

describe("lip serve local webhook policy", () => {
  it("requires the explicit development opt-in for a loopback webhook", async () => {
    const previousUrl = process.env.LIP_WEBHOOK_URL;
    const previousSecret = process.env.LIP_WEBHOOK_SECRET;
    process.env.LIP_WEBHOOK_URL = "http://127.0.0.1:1/hooks";
    process.env.LIP_WEBHOOK_SECRET = "cli-local-webhook-secret";

    try {
      await expect(startMockServer({
        host: "127.0.0.1",
        port: 0,
        apiKey: "cli-test-key"
      })).rejects.toThrow(/must use HTTPS/);

      const running = await startMockServer({
        host: "127.0.0.1",
        port: 0,
        apiKey: "cli-test-key",
        allowPrivateWebhookNetworks: true
      });
      await running.close();
    } finally {
      if (previousUrl === undefined) delete process.env.LIP_WEBHOOK_URL;
      else process.env.LIP_WEBHOOK_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.LIP_WEBHOOK_SECRET;
      else process.env.LIP_WEBHOOK_SECRET = previousSecret;
    }
  });
});

describe("lip terminal presentation", () => {
  it("formats a clear local server startup screen", () => {
    const output = formatServerReady({
      adminUrl: "http://127.0.0.1:3210/admin/",
      apiBaseUrl: "http://127.0.0.1:3210",
      apiKey: "cli-test-key",
      databasePath: ".lip/reference.db",
      discoveryUrl: "http://127.0.0.1:3210/.well-known/lip",
      doctorCommand: "lip doctor",
      testCommand: "lip test"
    }, { color: false });

    expect(output).toContain("Loyalty Interchange local sandbox");
    expect(output).toContain("[ready] Reference API and Admin dashboard are running.");
    expect(output).toContain("Admin      http://127.0.0.1:3210/admin/");
    expect(output).toContain("Key        cli-test-key");
    expect(output).toContain("Run diagnostics: lip doctor");
    expect(output).toContain("Authorization: Bearer cli-test-key");
  });
});
