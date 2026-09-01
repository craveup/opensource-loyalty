import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPlatform } from "@loyalty-interchange/server";
import { createBootstrapProgram, isBootstrapProgram } from "./bootstrap-program.js";
import {
  ManagedPostgresDataPlaneManager,
  parseRuntimePath,
  type ManagedTenantPlatform
} from "./managed-data-plane.js";
import type { CloudEnvironment, CloudProvisioningJob } from "./types.js";

const CONNECTION = "postgres://lip:lip@db.example.internal:5432/lip";
const BASE_URL = "https://loyalty.example.com";

function environment(overrides: Partial<CloudEnvironment> = {}): CloudEnvironment {
  return {
    environment_id: "env-alpha",
    project_id: "project-1",
    slug: "development",
    name: "Development",
    kind: "development",
    region: "render-oregon",
    tenant_id: "tenant-alpha",
    program_id: "program-alpha",
    status: "ready",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const createJob: CloudProvisioningJob = {
  provisioning_job_id: "job-1",
  environment_id: "env-alpha",
  operation: "create",
  status: "running",
  attempts: 1,
  available_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z"
};

/**
 * A real, working tenant platform for tests, backed by SQLite instead of
 * Postgres. It exercises the same handler wiring the managed path uses; only
 * the storage driver differs, which is exactly what the structural
 * ManagedTenantPlatform type exists to allow.
 */
const temporaryDirectories: string[] = [];
const closers: Array<() => Promise<void>> = [];

let requestSequence = 0;

function context(idempotencyKey: string): Record<string, unknown> {
  requestSequence += 1;
  return {
    protocol_version: "1.0",
    profile: "foodservice/1.0",
    request_id: `request-${requestSequence}`,
    idempotency_key: idempotencyKey,
    occurred_at: "2026-01-01T10:00:00.000Z",
    source: { system: "managed-test", instance: "vitest" }
  };
}

function order(): Record<string, unknown> {
  return {
    order_id: "order-1",
    scope: {
      program_id: "program-alpha",
      brand_id: "brand-1",
      merchant_id: "merchant-1",
      location_id: "location-1"
    },
    member_id: "member-1",
    channel: "counter",
    status: "paid",
    business_date: "2026-01-01",
    placed_at: "2026-01-01T10:00:00.000Z",
    closed_at: "2026-01-01T10:02:00.000Z",
    lines: [{
      line_id: "line-1",
      kind: "item",
      product_id: "coffee",
      quantity: 1,
      unit_price: { amount: 5_000, currency: "USD" },
      subtotal: { amount: 5_000, currency: "USD" },
      discount: { amount: 0, currency: "USD" },
      tax: { amount: 0, currency: "USD" }
    }],
    totals: {
      subtotal: { amount: 5_000, currency: "USD" },
      discount: { amount: 0, currency: "USD" },
      tax: { amount: 0, currency: "USD" },
      tip: { amount: 0, currency: "USD" },
      service_charge: { amount: 0, currency: "USD" },
      total: { amount: 5_000, currency: "USD" }
    }
  };
}

async function sqlitePlatform(target: CloudEnvironment): Promise<ManagedTenantPlatform> {
  const directory = mkdtempSync(join(tmpdir(), "lip-managed-"));
  temporaryDirectories.push(directory);
  const demo = await createDemoPlatform({
    databasePath: join(directory, `${target.tenant_id}.db`),
    program: createBootstrapProgram(target.program_id),
    seed: false,
    webhooks: []
  });
  return {
    ...demo,
    store: { status: demo.store.status },
    executeEngineOperation: async <T>(operation: () => T | Promise<T>): Promise<T> => {
      const result = await operation();
      demo.store.save(demo.engine.exportState());
      return result;
    },
    readEngineSnapshot: async <T>(read: (engine: typeof demo.engine) => T | Promise<T>) =>
      read(demo.engine)
  };
}

function manager(options: {
  environments: CloudEnvironment[];
  createPlatform?: (target: CloudEnvironment) => Promise<ManagedTenantPlatform>;
}): ManagedPostgresDataPlaneManager {
  const created = new ManagedPostgresDataPlaneManager({
    connectionString: CONNECTION,
    publicBaseUrl: BASE_URL,
    environmentById: async (id) =>
      options.environments.find((candidate) => candidate.environment_id === id),
    readyEnvironments: async () =>
      options.environments.filter((candidate) => candidate.status === "ready"),
    createPlatform: options.createPlatform ?? sqlitePlatform,
    onEvent: () => undefined
  });
  closers.push(() => created.close());
  return created;
}

/** Mounts the manager behind one listener, the way the control plane does. */
async function listen(
  managed: ManagedPostgresDataPlaneManager
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    void managed.handleRuntimeRequest(request, response).then((handled) => {
      if (handled) return;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closers.push(close);
  return { url: `http://127.0.0.1:${address.port}`, close };
}

afterEach(async () => {
  while (closers.length) await closers.pop()?.().catch(() => undefined);
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

describe("managed runtime path routing", () => {
  it("keeps only the validated environment prefix", () => {
    expect(parseRuntimePath("/runtime/v1/environments/env-1/lip/v1/capabilities")).toEqual({
      environmentId: "env-1",
      forwarded: "/lip/v1/capabilities"
    });
    expect(parseRuntimePath("/runtime/v1/environments/env-1")).toEqual({
      environmentId: "env-1",
      forwarded: "/"
    });
    expect(parseRuntimePath("/runtime/v1/environments/env-1/admin/api/v1/snapshot?full=1")).toEqual({
      environmentId: "env-1",
      forwarded: "/admin/api/v1/snapshot?full=1"
    });
  });

  it("forwards a nested environment path as data instead of re-routing it", () => {
    // A tenant that can make the router re-read a later path segment as the
    // environment id can address another tenant. Only the first segment counts.
    expect(
      parseRuntimePath("/runtime/v1/environments/env-1/runtime/v1/environments/env-2/lip/v1/capabilities")
    ).toEqual({
      environmentId: "env-1",
      forwarded: "/runtime/v1/environments/env-2/lip/v1/capabilities"
    });
  });

  it("refuses traversal, empty and malformed environment segments", () => {
    for (const path of [
      "/runtime/v1/environments/",
      "/runtime/v1/environments/../../etc/passwd",
      "/runtime/v1/environments/-leading-dash/lip/v1/capabilities",
      "/cloud/v1/organizations"
    ]) {
      expect(parseRuntimePath(path), path).toBeUndefined();
    }
  });
});

describe("managed data-plane manager", () => {
  it("provisions a path-scoped runtime and serves protocol requests through it", async () => {
    const managed = manager({ environments: [environment()] });
    const provisioned = await managed.provision({ environment: environment(), job: createJob });
    expect(provisioned).toEqual({
      api_url: `${BASE_URL}/runtime/v1/environments/env-alpha`,
      admin_url: `${BASE_URL}/runtime/v1/environments/env-alpha`
    });

    const server = await listen(managed);
    const response = await fetch(
      `${server.url}/runtime/v1/environments/env-alpha/.well-known/lip`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ protocol_version: "1.0" });
  });

  it("refuses an environment that is not ready and one that does not exist", async () => {
    const managed = manager({
      environments: [environment({ environment_id: "env-suspended", status: "suspended" })]
    });
    const server = await listen(managed);

    const suspended = await fetch(
      `${server.url}/runtime/v1/environments/env-suspended/.well-known/lip`
    );
    expect(suspended.status).toBe(409);
    expect(await suspended.json()).toMatchObject({ code: "environment_not_ready" });

    const missing = await fetch(
      `${server.url}/runtime/v1/environments/env-unknown/.well-known/lip`
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "environment_not_found" });
  });

  it("re-reads status per request, so a suspension takes effect without a restart", async () => {
    const record = environment();
    const environments = [record];
    const managed = manager({ environments });
    const server = await listen(managed);
    expect(
      (await fetch(`${server.url}/runtime/v1/environments/env-alpha/.well-known/lip`)).status
    ).toBe(200);

    environments[0] = environment({ status: "suspended" });
    const afterSuspension = await fetch(
      `${server.url}/runtime/v1/environments/env-alpha/.well-known/lip`
    );
    expect(afterSuspension.status).toBe(409);
  });

  it("starts one runtime for concurrent first requests", async () => {
    let starts = 0;
    const managed = manager({
      environments: [environment()],
      createPlatform: async (target) => {
        starts += 1;
        return sqlitePlatform(target);
      }
    });
    const server = await listen(managed);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${server.url}/runtime/v1/environments/env-alpha/.well-known/lip`))
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(starts).toBe(1);
  });

  it("evicts a failed start so a later request can recover", async () => {
    let attempt = 0;
    const managed = manager({
      environments: [environment()],
      createPlatform: async (target) => {
        attempt += 1;
        if (attempt === 1) throw new Error("database unavailable");
        return sqlitePlatform(target);
      }
    });
    const server = await listen(managed);
    const failed = await fetch(
      `${server.url}/runtime/v1/environments/env-alpha/.well-known/lip`
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "runtime_unavailable" });

    const recovered = await fetch(
      `${server.url}/runtime/v1/environments/env-alpha/.well-known/lip`
    );
    expect(recovered.status).toBe(200);
    expect(attempt).toBe(2);
  });

  it("restores every ready environment on boot without a request arriving", async () => {
    const managed = manager({
      environments: [
        environment(),
        environment({
          environment_id: "env-beta",
          tenant_id: "tenant-beta",
          program_id: "program-beta"
        }),
        environment({ environment_id: "env-failed", status: "failed" })
      ]
    });
    const restored = await managed.restore();
    expect(restored.map((runtime) => runtime.environment_id).sort()).toEqual([
      "env-alpha",
      "env-beta"
    ]);
    expect(managed.runtimeDescriptors()).toHaveLength(2);
  });

  it("keeps restoring after one environment fails to start", async () => {
    const managed = manager({
      environments: [
        environment({ environment_id: "env-broken", tenant_id: "tenant-broken" }),
        environment({ environment_id: "env-beta", tenant_id: "tenant-beta" })
      ],
      createPlatform: async (target) => {
        if (target.environment_id === "env-broken") throw new Error("corrupt tenant state");
        return sqlitePlatform(target);
      }
    });
    const restored = await managed.restore();
    expect(restored.map((runtime) => runtime.environment_id)).toEqual(["env-beta"]);
  });

  it("issues a merchant credential the environment's own runtime authenticates", async () => {
    const managed = manager({ environments: [environment()] });
    const issued = await managed.issueMerchantCredential("env-alpha", { subject: "operator@crave" });
    expect(issued.merchant_api_key).toMatch(/^lip_/);
    expect(issued.environment_id).toBe("env-alpha");

    const server = await listen(managed);
    const authorized = await fetch(
      `${server.url}/runtime/v1/environments/env-alpha/admin/api/v1/snapshot`,
      { headers: { authorization: `Bearer ${issued.merchant_api_key}` } }
    );
    expect(authorized.status).toBe(200);
  });

  it("refuses a credential minted for another environment", async () => {
    const managed = manager({
      environments: [
        environment(),
        environment({
          environment_id: "env-beta",
          tenant_id: "tenant-beta",
          program_id: "program-alpha"
        })
      ]
    });
    // Same program id in both environments: only the tenant boundary separates
    // them, which is the case a program-scoped check would wave through.
    const alpha = await managed.issueMerchantCredential("env-alpha", { subject: "operator" });
    const server = await listen(managed);
    const crossTenant = await fetch(
      `${server.url}/runtime/v1/environments/env-beta/admin/api/v1/snapshot`,
      { headers: { authorization: `Bearer ${alpha.merchant_api_key}` } }
    );
    expect([401, 403]).toContain(crossTenant.status);
  });

  it("rotates rather than accumulating standing merchant keys", async () => {
    const managed = manager({ environments: [environment()] });
    const first = await managed.issueMerchantCredential("env-alpha", { subject: "operator" });
    const second = await managed.issueMerchantCredential("env-alpha", { subject: "operator" });
    expect(second.merchant_api_key).not.toBe(first.merchant_api_key);
    expect(second.merchant_api_key_id).not.toBe(first.merchant_api_key_id);
    expect(second.replaced_api_key_expires_at).toBeTypeOf("string");
  });

  it("serializes concurrent rotations onto one lineage", async () => {
    const managed = manager({ environments: [environment()] });
    const issued = await Promise.all(
      Array.from({ length: 4 }, () =>
        managed.issueMerchantCredential("env-alpha", { subject: "operator" }))
    );
    const keyIds = new Set(issued.map((credential) => credential.merchant_api_key_id));
    expect(keyIds.size).toBe(4);
  });

  it("rejects a public base URL that carries credentials or a query", () => {
    for (const base of [
      "https://user:secret@loyalty.example.com",
      "https://loyalty.example.com/?token=abc",
      "ftp://loyalty.example.com"
    ]) {
      expect(() => new ManagedPostgresDataPlaneManager({
        connectionString: CONNECTION,
        publicBaseUrl: base,
        environmentById: async () => undefined,
        readyEnvironments: async () => []
      }), base).toThrow();
    }
  });

  it("preserves a base URL path prefix and trims trailing slashes", () => {
    const managed = new ManagedPostgresDataPlaneManager({
      connectionString: CONNECTION,
      publicBaseUrl: "https://loyalty.example.com/lip/",
      environmentById: async () => undefined,
      readyEnvironments: async () => []
    });
    expect(managed.apiUrlFor("env-alpha")).toBe(
      "https://loyalty.example.com/lip/runtime/v1/environments/env-alpha"
    );
  });
});

describe("bootstrap program", () => {
  it("is valid, inert, and free of seeded activity", () => {
    const program = createBootstrapProgram("program-alpha");
    expect(program.currency).toBe("USD");
    expect(program.earn_rate.points).toBe(0);
    expect(program.rewards).toEqual([]);
    expect(program.tiers).toBeUndefined();
    expect(program.membership_policy).toBeUndefined();
    expect(isBootstrapProgram(program)).toBe(true);
  });

  it("earns nothing and can redeem nothing before the merchant publishes", async () => {
    const managed = manager({ environments: [environment()] });
    const server = await listen(managed);
    const issued = await managed.issueMerchantCredential("env-alpha", { subject: "operator" });
    const base = `${server.url}/runtime/v1/environments/env-alpha`;
    const headers = {
      authorization: `Bearer ${issued.merchant_api_key}`,
      "content-type": "application/json"
    };
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, { body: JSON.stringify(body), headers, method: "POST" });

    const enrolled = await post("/lip/v1/members/enroll", {
      context: context("enroll-1"),
      program_id: "program-alpha",
      identity: { type: "token", value: "guest-token-1", issuer: "test-identity" },
      member_id: "member-1"
    });
    expect(enrolled.status).toBe(201);

    const accrued = await post("/lip/v1/accruals", {
      context: context("accrual-1"),
      member_id: "member-1",
      order: order()
    });
    expect(accrued.status).toBe(201);
    expect(await accrued.json()).toMatchObject({ entry: { amount: 0 } });

    const account = await post("/lip/v1/accounts/get", {
      context: context("account-1"),
      member_id: "member-1",
      program_id: "program-alpha"
    });
    expect(account.status).toBe(200);
    const balances = (await account.json() as { balances: Array<{ available: number }> }).balances;
    expect(balances.every((balance) => balance.available === 0)).toBe(true);

    // No rewards exist, so nothing is reservable no matter the balance.
    const reserved = await post("/lip/v1/redemptions/reserve", {
      context: context("reserve-1"),
      member_id: "member-1",
      program_id: "program-alpha",
      reward_id: "any-reward",
      scope: {
        program_id: "program-alpha",
        brand_id: "brand-1",
        merchant_id: "merchant-1",
        location_id: "location-1"
      }
    });
    expect(reserved.ok).toBe(false);
  });
});
