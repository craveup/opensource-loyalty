import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import {
  assertStrongApiKey,
  createReferenceServer,
  createDemoPlatform,
  startReferenceServer,
  type StructuredRequestLog
} from "@loyalty-interchange/server";
import { makeContext, makeEnroll, makeOrder, makeProgram } from "../fixtures.js";

describe("reference HTTP server", () => {
  it("requires a nontrivial API key", () => {
    expect(() => createReferenceServer(new LoyaltyEngine(makeProgram()), { apiKey: "short" }))
      .toThrowError(/at least 8/);
  });

  it("rejects weak or default keys for shared deployments", () => {
    expect(() => assertStrongApiKey("lip-dev-key")).toThrowError(/default/);
    expect(() => assertStrongApiKey("only-15-chars-x")).toThrowError(/at least 16/);
    expect(() => assertStrongApiKey("")).toThrowError(/at least 16/);
    expect(() => assertStrongApiKey("a-strong-key-of-16ch")).not.toThrow();
  });

  it("refuses weak keys when binding beyond loopback, regardless of storage backend", async () => {
    const engine = new LoyaltyEngine(makeProgram());
    // A non-loopback binding is network-exposed: the local default key and
    // short keys must be rejected even for demo/SQLite runtimes.
    await expect(startReferenceServer(engine, { apiKey: "lip-dev-key", host: "0.0.0.0" }))
      .rejects.toThrowError(/lip-dev-key|default/);
    await expect(startReferenceServer(engine, { apiKey: "weak-key-15ch-x", host: "::" }))
      .rejects.toThrowError(/at least 16/);
    // Loopback development bindings keep accepting the local default key.
    for (const host of [undefined, "127.0.0.1", "localhost"]) {
      const running = await startReferenceServer(engine, {
        apiKey: "lip-dev-key",
        ...(host ? { host } : {})
      });
      await running.close();
    }
  });

  it("commits protocol operations through an external transaction hook", async () => {
    const engine = new LoyaltyEngine(makeProgram());
    let executions = 0;
    let directPersists = 0;
    const running = await startReferenceServer(engine, {
      apiKey: "transaction-test-key",
      executeEngineOperation: async (operation) => {
        executions += 1;
        return operation();
      },
      persistState: () => {
        directPersists += 1;
      }
    });
    try {
      const response = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: {
          authorization: "Bearer transaction-test-key",
          "content-type": "application/json"
        },
        body: JSON.stringify(makeEnroll("transaction-hook-enroll"))
      });
      expect(response.status).toBe(201);
      expect(executions).toBe(1);
      expect(directPersists).toBe(0);
    } finally {
      await running.close();
    }
  });

  it("freezes protocol writes at startup while allowing reads and health", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "freeze-test-key",
      writeFrozen: true
    });
    try {
      // a write is rejected with a stable 503 problem + Retry-After
      const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer freeze-test-key", "content-type": "application/json" },
        body: JSON.stringify(makeEnroll("freeze-write-key"))
      });
      expect(enroll.status).toBe(503);
      expect(enroll.headers.get("content-type")).toContain("application/problem+json");
      expect(enroll.headers.get("retry-after")).toBeTruthy();
      expect(await enroll.json()).toMatchObject({ code: "write_frozen" });

      // a read still works
      const program = await fetch(`${running.url}/lip/v1/programs/get`, {
        method: "POST",
        headers: { authorization: "Bearer freeze-test-key", "content-type": "application/json" },
        body: JSON.stringify({ context: makeContext("freeze-read-key"), program_id: "demo-foodservice" })
      });
      expect(program.status).toBe(200);

      // health reflects the freeze
      const health = await (await fetch(`${running.url}/health`)).json();
      expect(health).toMatchObject({ status: "ok", write_frozen: true });
    } finally {
      await running.close();
    }
  });

  it("defaults to unfrozen (writes allowed, health write_frozen false)", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), { apiKey: "unfrozen-key" });
    try {
      const health = await (await fetch(`${running.url}/health`)).json();
      expect(health).toMatchObject({ write_frozen: false });
      const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer unfrozen-key", "content-type": "application/json" },
        body: JSON.stringify(makeEnroll("unfrozen-write-key"))
      });
      expect(enroll.status).toBe(201);
    } finally {
      await running.close();
    }
  });

  it("toggles the write-freeze via the admin maintenance endpoint", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "maintenance-admin-key"
    });
    try {
      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "maintenance-admin-key" })
      });
      expect(login.status).toBe(204);
      const setCookies = login.headers.getSetCookie();
      const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
      const csrf = decodeURIComponent(
        setCookies
          .find((value) => value.startsWith("lip_admin_csrf="))!
          .split(";", 1)[0]!
          .slice("lip_admin_csrf=".length)
      );
      const authed = { cookie, "content-type": "application/json", "x-lip-csrf": csrf };

      // starts unfrozen: status read reflects it
      const before = await (await fetch(`${running.url}/admin/api/v1/maintenance`, { headers: { cookie } })).json();
      expect(before).toMatchObject({ write_frozen: false });

      // freeze
      const set = await fetch(`${running.url}/admin/api/v1/maintenance`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ write_frozen: true })
      });
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({ write_frozen: true });

      // a write is now frozen
      const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer maintenance-admin-key", "content-type": "application/json" },
        body: JSON.stringify(makeEnroll("toggle-write-key"))
      });
      expect(enroll.status).toBe(503);

      // unfreeze -> write works
      const unset = await fetch(`${running.url}/admin/api/v1/maintenance`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ write_frozen: false })
      });
      expect(unset.status).toBe(200);
      expect(await unset.json()).toMatchObject({ write_frozen: false });

      const enroll2 = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer maintenance-admin-key", "content-type": "application/json" },
        body: JSON.stringify(makeEnroll("toggle-write-key-2"))
      });
      expect(enroll2.status).toBe(201);

      const after = await (await fetch(`${running.url}/admin/api/v1/maintenance`, { headers: { cookie } })).json();
      expect(after).toMatchObject({ write_frozen: false });
    } finally {
      await running.close();
    }
  });

  it("rejects a maintenance write with a valid session but no CSRF header, leaving the flag unchanged", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "maintenance-csrf-key"
    });
    try {
      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "maintenance-csrf-key" })
      });
      expect(login.status).toBe(204);
      const setCookies = login.headers.getSetCookie();
      const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");

      // session cookie present, but no x-lip-csrf header
      const res = await fetch(`${running.url}/admin/api/v1/maintenance`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ write_frozen: true })
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "csrf_failed" });

      // flag unchanged: a follow-up GET still reports unfrozen
      const after = await (await fetch(`${running.url}/admin/api/v1/maintenance`, { headers: { cookie } })).json();
      expect(after).toMatchObject({ write_frozen: false });
    } finally {
      await running.close();
    }
  });

  it("rejects a maintenance write without admin authorization, leaving the flag unchanged", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "maintenance-unauth-key"
    });
    try {
      const res = await fetch(`${running.url}/admin/api/v1/maintenance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ write_frozen: true })
      });
      expect([401, 403]).toContain(res.status);

      // flag unchanged: a subsequent write still succeeds
      const enroll = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer maintenance-unauth-key", "content-type": "application/json" },
        body: JSON.stringify(makeEnroll("maintenance-unauth-write-key"))
      });
      expect(enroll.status).toBe(201);
    } finally {
      await running.close();
    }
  });

  it("returns problem details for routes, methods, media types, JSON, and body limits", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "server-test-key"
    });
    try {
      const missing = await fetch(`${running.url}/missing`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "not_found" });

      const wrongMethod = await fetch(`${running.url}/lip/v1/members/enroll`, {
        headers: { authorization: "Bearer server-test-key" }
      });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("POST");
      expect(await wrongMethod.json()).toMatchObject({ code: "method_not_allowed" });

      const postToGetRoute = await fetch(`${running.url}/health`, { method: "POST" });
      expect(postToGetRoute.status).toBe(405);
      expect(postToGetRoute.headers.get("allow")).toBe("GET");

      const discovery = await fetch(`${running.url}/.well-known/lip`);
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({
        protocol: "LIP",
        endpoints: { capabilities: "/lip/v1/capabilities" }
      });

      const capabilities = await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: "Bearer server-test-key" }
      });
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({
        protocol_version: "1.0",
        operations: expect.arrayContaining([
          "order.evaluate",
          "redemption.reserve",
          "program.get",
          "account.get",
          "ledger.list",
          "ledger.manual_adjustment"
        ])
      });

      const wrongType = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer server-test-key", "content-type": "text/plain" },
        body: "{}"
      });
      expect(wrongType.status).toBe(415);
      expect(await wrongType.json()).toMatchObject({ code: "unsupported_media_type" });

      const malformed = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer server-test-key", "content-type": "application/json" },
        body: "{not-json"
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ code: "invalid_json" });

      const tooLarge = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: { authorization: "Bearer server-test-key", "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(1_048_576) })
      });
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({ code: "payload_too_large" });
    } finally {
      await running.close();
    }
  });

  it("rate limits authenticated clients and emits structured request logs", async () => {
    const logs: StructuredRequestLog[] = [];
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "rate-test-key",
      rateLimit: { maxRequests: 2, windowMs: 60_000 },
      requestLogger: (entry) => logs.push(entry)
    });
    try {
      for (const requestId of ["request-one", "request-two"]) {
        const response = await fetch(`${running.url}/lip/v1/capabilities`, {
          headers: {
            authorization: "Bearer rate-test-key",
            "x-request-id": requestId
          }
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBe(requestId);
        expect(response.headers.get("ratelimit-limit")).toBe("2");
        await response.json();
      }

      const limited = await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: "Bearer rate-test-key" }
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect(limited.headers.get("ratelimit-remaining")).toBe("0");
      expect(await limited.json()).toMatchObject({ code: "rate_limit_exceeded" });

      expect(logs).toHaveLength(3);
      expect(logs.map((entry) => entry.status)).toEqual([200, 200, 429]);
      expect(logs[0]).toMatchObject({
        request_id: "request-one",
        method: "GET",
        path: "/lip/v1/capabilities",
        status: 200
      });
      expect(logs[0]?.duration_ms).toBeGreaterThanOrEqual(0);

      const metrics = await fetch(`${running.url}/metrics`, {
        headers: { authorization: "Bearer rate-test-key" }
      });
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      const metricsBody = await metrics.text();
      expect(metricsBody).toContain(
        'lip_http_requests_total{method="GET",path="/lip/v1/capabilities",status="200"} 2'
      );
      expect(metricsBody).toContain(
        'lip_http_requests_total{method="GET",path="/lip/v1/capabilities",status="429"} 1'
      );
    } finally {
      await running.close();
    }
  });

  it("serves an authenticated, non-normative Admin snapshot and persists operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-admin-assets-"));
    writeFileSync(join(directory, "index.html"), "<!doctype html><title>LIP Admin</title>");
    const persisted: unknown[] = [];
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "admin-test-key",
      persistState: (state) => persisted.push(state),
      admin: {
        assetRoot: directory,
        storage: { driver: "sqlite", location: "/tmp/reference.db", persistent: true },
        webhooks: () => ({
          enabled: true,
          pending: [{
            delivery_id: "delivery-001",
            event_id: "event-001",
            event_type: "org.loyalty-interchange.order.accrued.v1",
            url: "https://receiver.example/hooks",
            attempts: 2,
            created_at: "2026-07-15T00:00:00.000Z",
            updated_at: "2026-07-15T00:01:00.000Z",
            last_error: "receiver responded with HTTP 503"
          }],
          recent: []
        })
      }
    });
    try {
      const redirect = await fetch(`${running.url}/admin`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/admin/");

      const admin = await fetch(`${running.url}/admin/`);
      expect(admin.status).toBe(200);
      expect(await admin.text()).toContain("LIP Admin");

      const bootstrap = await fetch(`${running.url}/admin/api/v1/bootstrap`);
      expect(bootstrap.status).toBe(200);
      const bootstrapBody = await bootstrap.text();
      expect(bootstrapBody).not.toContain("admin-test-key");
      expect(JSON.parse(bootstrapBody)).toMatchObject({
        admin_api_version: "0.4",
        auth: {
          mode: "api_key",
          requires_login: true,
          default_local_key: false,
          credential_hint: "Copy the Admin/API key from the terminal that started this server. Docker users can run docker compose logs lip."
        },
        session: { authenticated: false },
        platform: {
          protocol_version: "1.0",
          profile: "foodservice/1.0",
          storage: { driver: "sqlite", persistent: true }
        },
        onboarding: {
          steps: expect.arrayContaining([
            expect.objectContaining({ id: "signin", status: "next" }),
            expect.objectContaining({ id: "configure-program", status: "ready" })
          ])
        },
        links: { admin: "/admin/", api: "/lip/v1" }
      });

      const unauthorized = await fetch(`${running.url}/admin/api/v1/snapshot`);
      expect(unauthorized.status).toBe(401);

      const rejected = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "incorrect-key" })
      });
      expect(rejected.status).toBe(401);

      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "admin-test-key" })
      });
      expect(login.status).toBe(204);
      const cookie = login.headers.get("set-cookie");
      expect(cookie).toContain("lip_admin_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      // Plain-HTTP request (no TLS, no forwarded proto): Secure would make the
      // cookie undeliverable, so it must be omitted for local development.
      expect(cookie).not.toContain("Secure");

      const authenticatedBootstrap = await fetch(`${running.url}/admin/api/v1/bootstrap`, {
        headers: { cookie: cookie! }
      });
      expect(authenticatedBootstrap.status).toBe(200);
      expect(await authenticatedBootstrap.json()).toMatchObject({
        session: { authenticated: true }
      });

      const enrollment = await fetch(`${running.url}/lip/v1/members/enroll`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-test-key",
          "content-type": "application/json"
        },
        body: JSON.stringify(makeEnroll("admin-server-enroll-key"))
      });
      expect(enrollment.status).toBe(201);

      const manual = await fetch(`${running.url}/lip/v1/ledger/manual-adjustments`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-test-key",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          context: makeContext("admin-manual-adjustment-key"),
          member_id: "member-001",
          program_id: "demo-foodservice",
          adjustment_id: "manual-admin-001",
          amount: 40,
          classification: "service_recovery",
          reason: "Guest support credit",
          qualifies_for_tier: false
        })
      });
      expect(manual.status).toBe(201);
      expect(await manual.json()).toMatchObject({
        entry: {
          operation: "manual",
          amount: 40,
          classification: "service_recovery"
        },
        balances: [{ amount: 40 }]
      });

      const snapshot = await fetch(`${running.url}/admin/api/v1/snapshot`, {
        headers: { cookie: cookie! }
      });
      expect(snapshot.status).toBe(200);
      expect(await snapshot.json()).toMatchObject({
        admin_api_version: "0.4",
        platform: { storage: { driver: "sqlite", persistent: true } },
        webhooks: {
          enabled: true,
          pending: [{
            delivery_id: "delivery-001",
            attempts: 2,
            last_error: "receiver responded with HTTP 503"
          }],
          recent: []
        },
        program_configuration: {
          current_model_id: "points",
          templates: expect.arrayContaining([
            expect.objectContaining({ model_id: "points", status: "active" }),
            expect.objectContaining({ model_id: "visits", status: "available" }),
            expect.objectContaining({ model_id: "wallet_credit", status: "available" })
          ])
        },
        summary: { active_members: 1 },
        members: [{ member: { member_id: "member-001" } }]
      });
      expect(persisted).toHaveLength(3);
    } finally {
      await running.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("marks admin cookies Secure when the edge terminates TLS", async () => {
    const running = await startReferenceServer(new LoyaltyEngine(makeProgram()), {
      apiKey: "admin-test-key",
      admin: { storage: { driver: "sqlite", location: ":memory:", persistent: false } }
    });
    try {
      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https"
        },
        body: JSON.stringify({ api_key: "admin-test-key" })
      });
      expect(login.status).toBe(204);
      const cookie = login.headers.get("set-cookie");
      expect(cookie).toContain("lip_admin_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");

      const logout = await fetch(`${running.url}/admin/api/v1/logout`, {
        method: "POST",
        headers: { "x-forwarded-proto": "https, http" }
      });
      expect(logout.status).toBe(204);
      // Deletion cookie must carry matching attributes so the browser evicts it.
      expect(logout.headers.get("set-cookie")).toContain("Secure");
    } finally {
      await running.close();
    }
  });

  it("protects live program draft, publish, and rollback writes with CSRF", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-program-admin-"));
    const databasePath = join(directory, "reference.db");
    const platform = await createDemoPlatform({
      databasePath,
      reset: true,
      seed: false,
      program: makeProgram()
    });
    platform.engine.enroll(makeEnroll("campaign-admin-enroll"));
    const running = await startReferenceServer(platform.engine, {
      apiKey: "program-admin-key",
      persistState: (state) => platform.store.save(state),
      admin: {
        programs: platform.programs,
        campaigns: platform.campaigns,
        webhookManager: platform.webhooks,
        access: platform.access,
        engagement: platform.engagement,
        storage: platform.store.status
      }
    });
    try {
      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "program-admin-key" })
      });
      expect(login.status).toBe(204);
      const setCookies = login.headers.getSetCookie();
      const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
      const csrf = decodeURIComponent(
        setCookies
          .find((value) => value.startsWith("lip_admin_csrf="))!
          .split(";", 1)[0]!
          .slice("lip_admin_csrf=".length)
      );
      const changed = {
        ...makeProgram(),
        name: "Admin-published program",
        earn_rate: { points: 4, spend_minor_units: 100 }
      };

      const webhook = await fetch(`${running.url}/admin/api/v1/webhooks/subscription`, {
        method: "PUT",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({
          url: "https://receiver.example/hooks",
          secret: "server-test-secret-value"
        })
      });
      expect(webhook.status).toBe(200);
      const webhookBody = await webhook.json() as { subscription_id: string };
      expect(platform.webhooks.listSubscriptions()).toEqual([
        expect.objectContaining({ subscription_id: webhookBody.subscription_id })
      ]);

      const apiKeyResponse = await fetch(`${running.url}/admin/api/v1/access/api-keys`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ name: "Test integration", role: "integration" })
      });
      expect(apiKeyResponse.status).toBe(201);
      const createdKey = await apiKeyResponse.json() as {
        secret: string;
        api_key: { key_id: string };
      };
      expect(createdKey.secret).toMatch(/^lip_sk_/);
      const scopedCapabilities = await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: `Bearer ${createdKey.secret}` }
      });
      expect(scopedCapabilities.status).toBe(200);
      const rejectedAdmin = await fetch(`${running.url}/admin/api/v1/snapshot`, {
        headers: { authorization: `Bearer ${createdKey.secret}` }
      });
      expect(rejectedAdmin.status).toBe(401);

      const segmentResponse = await fetch(`${running.url}/admin/api/v1/segments`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ name: "Admin segment", member_ids: ["member-001"] })
      });
      expect(segmentResponse.status).toBe(200);
      const segment = await segmentResponse.json() as { segment_id: string };
      const connectorResponse = await fetch(
        `${running.url}/admin/api/v1/engagement/connectors`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
          body: JSON.stringify({
            name: "CRM",
            type: "webhook",
            configuration: { url: "https://crm.example/messages" },
            secret: "engagement-test-secret"
          })
        }
      );
      expect(connectorResponse.status).toBe(200);
      const connector = await connectorResponse.json() as { connector_id: string };
      const messageResponse = await fetch(`${running.url}/admin/api/v1/engagement/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({
          idempotency_key: "admin-message-001",
          connector_id: connector.connector_id,
          segment_id: segment.segment_id,
          template_id: "receipt-follow-up",
          content: { text: "Thanks for visiting" },
          purpose: "transactional"
        })
      });
      expect(messageResponse.status).toBe(201);
      expect(await messageResponse.json()).toMatchObject({
        status: "queued",
        deliveries: [expect.objectContaining({ member_id: "member-001", status: "pending" })]
      });
      const analyticsResponse = await fetch(`${running.url}/admin/api/v1/analytics`, {
        headers: { cookie }
      });
      expect(analyticsResponse.status).toBe(200);
      expect(await analyticsResponse.json()).toMatchObject({
        members: { total: 1, active: 1 }
      });
      const exportResponse = await fetch(
        `${running.url}/admin/api/v1/exports/members?format=json&include_unconsented=true`,
        { headers: { cookie } }
      );
      expect(exportResponse.status).toBe(200);
      expect(await exportResponse.json()).toMatchObject({
        members: [expect.objectContaining({ member_id: "member-001" })]
      });
      const campaignResponse = await fetch(`${running.url}/admin/api/v1/campaigns`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({
          name: "Admin campaign",
          reward_id: "one-dollar-off",
          segment_id: segment.segment_id
        })
      });
      expect(campaignResponse.status).toBe(200);
      const campaign = await campaignResponse.json() as { campaign_id: string };
      const runCampaign = await fetch(`${running.url}/admin/api/v1/campaigns/run`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ campaign_id: campaign.campaign_id })
      });
      expect(runCampaign.status).toBe(200);
      expect(await runCampaign.json()).toMatchObject({ issued: 1, failed: 0 });

      const rewardDraft = await fetch(`${running.url}/admin/api/v1/program/rewards`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({
          reward: {
            ...makeProgram().rewards[0],
            reward_id: "admin-created-reward",
            name: "Admin created reward"
          }
        })
      });
      expect(rewardDraft.status).toBe(200);
      expect(await rewardDraft.json()).toMatchObject({
        draft: { validation: { ok: true } }
      });

      const rejected = await fetch(`${running.url}/admin/api/v1/program/draft`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ program: changed })
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ code: "csrf_failed" });

      const draft = await fetch(`${running.url}/admin/api/v1/program/draft`, {
        method: "PUT",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ program: changed })
      });
      expect(draft.status).toBe(200);
      const draftBody = await draft.json() as {
        draft: { version: number; validation: { ok: boolean } };
      };
      expect(draftBody.draft.validation.ok).toBe(true);

      const published = await fetch(`${running.url}/admin/api/v1/program/publish`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ expected_draft_version: draftBody.draft.version })
      });
      expect(published.status).toBe(200);
      expect(await published.json()).toMatchObject({
        active_revision: 2,
        active_program: { name: "Admin-published program" }
      });
      expect(platform.engine.inspectAdmin().program.earning.rate.amount).toBe(4);

      const rolledBack = await fetch(`${running.url}/admin/api/v1/program/rollback`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ revision: 1 })
      });
      expect(rolledBack.status).toBe(200);
      expect(platform.engine.inspectAdmin().program.earning.rate.amount).toBe(
        makeProgram().earn_rate.points
      );

      const revokedKey = await fetch(
        `${running.url}/admin/api/v1/access/api-keys/revoke`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
          body: JSON.stringify({ key_id: createdKey.api_key.key_id })
        }
      );
      expect(revokedKey.status).toBe(200);
      expect(await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: `Bearer ${createdKey.secret}` }
      })).toHaveProperty("status", 401);
      expect(platform.access.snapshot().audit.map(({ action }) => action)).toContain(
        "access.api_key.revoked"
      );

      const deletedWebhook = await fetch(
        `${running.url}/admin/api/v1/webhooks/subscription/delete`,
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "x-lip-csrf": csrf
          },
          body: JSON.stringify({ subscription_id: webhookBody.subscription_id })
        }
      );
      expect(deletedWebhook.status).toBe(200);
      expect(platform.webhooks.listSubscriptions()).toEqual([]);

      const webhookHealth = await fetch(`${running.url}/admin/api/v1/webhooks/health`, {
        headers: { cookie }
      });
      expect(webhookHealth.status).toBe(200);
      expect(await webhookHealth.json()).toMatchObject({
        enabled: false,
        pending_count: 0,
        healthy: false
      });

      const cancelMember = await fetch(`${running.url}/admin/api/v1/members/cancel`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ member_id: "member-001" })
      });
      expect(cancelMember.status).toBe(200);
      expect(await cancelMember.json()).toMatchObject({
        member: { member_id: "member-001", status: "closed" }
      });

      const inspectBeforeErasure = await fetch(
        `${running.url}/admin/api/v1/members/inspect`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ member_id: "member-001" })
        }
      );
      expect(inspectBeforeErasure.status).toBe(200);
      expect(await inspectBeforeErasure.json()).toMatchObject({
        erased: false,
        member: { member_id: "member-001", status: "closed" }
      });

      const eraseMember = await fetch(`${running.url}/admin/api/v1/members/erase`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-lip-csrf": csrf
        },
        body: JSON.stringify({ member_id: "member-001" })
      });
      expect(eraseMember.status).toBe(200);
      expect(await eraseMember.json()).toMatchObject({
        erased: true,
        member: {
          identities: [
            { issuer: "lip-erasure", type: "loyalty_id", value: "member-001" }
          ],
          member_id: "member-001",
          status: "closed"
        }
      });

      const inspectAfterErasure = await fetch(
        `${running.url}/admin/api/v1/members/inspect`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ member_id: "member-001" })
        }
      );
      expect(inspectAfterErasure.status).toBe(200);
      expect(await inspectAfterErasure.json()).toMatchObject({ erased: true });
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rotates tenant API keys over HTTP with overlap semantics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-rotate-http-"));
    const databasePath = join(directory, "reference.db");
    const platform = await createDemoPlatform({
      databasePath,
      reset: true,
      seed: false,
      program: makeProgram()
    });
    const running = await startReferenceServer(platform.engine, {
      apiKey: "rotate-admin-key-16ch",
      persistState: (state) => platform.store.save(state),
      admin: {
        programs: platform.programs,
        campaigns: platform.campaigns,
        memberships: platform.memberships,
        access: platform.access,
        engagement: platform.engagement,
        webhookManager: platform.webhooks,
        storage: platform.store.status
      }
    });
    const rootHeaders = {
      authorization: "Bearer rotate-admin-key-16ch",
      "content-type": "application/json"
    };
    try {
      const created = await fetch(`${running.url}/admin/api/v1/access/api-keys`, {
        method: "POST",
        headers: rootHeaders,
        body: JSON.stringify({ name: "BFF", role: "integration" })
      });
      expect(created.status).toBe(201);
      const createdKey = await created.json() as { secret: string; api_key: { key_id: string } };

      // Default overlap keeps both secrets valid.
      const rotated = await fetch(`${running.url}/admin/api/v1/access/api-keys/rotate`, {
        method: "POST",
        headers: rootHeaders,
        body: JSON.stringify({ key_id: createdKey.api_key.key_id })
      });
      expect(rotated.status).toBe(200);
      const rotatedKey = await rotated.json() as {
        secret: string;
        api_key: { key_id: string };
        replaced_api_key: { key_id: string; expires_at?: string };
      };
      expect(rotatedKey.secret).toMatch(/^lip_sk_/);
      expect(rotatedKey.replaced_api_key).toMatchObject({
        key_id: createdKey.api_key.key_id,
        expires_at: expect.any(String)
      });
      for (const secret of [createdKey.secret, rotatedKey.secret]) {
        const probe = await fetch(`${running.url}/lip/v1/capabilities`, {
          headers: { authorization: `Bearer ${secret}` }
        });
        expect(probe.status).toBe(200);
      }

      // overlap_seconds: 0 cuts the replaced key off immediately.
      const cutover = await fetch(`${running.url}/admin/api/v1/access/api-keys/rotate`, {
        method: "POST",
        headers: rootHeaders,
        body: JSON.stringify({ key_id: rotatedKey.api_key.key_id, overlap_seconds: 0 })
      });
      expect(cutover.status).toBe(200);
      const cutoverKey = await cutover.json() as { secret: string };
      expect((await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: `Bearer ${rotatedKey.secret}` }
      })).status).toBe(401);
      expect((await fetch(`${running.url}/lip/v1/capabilities`, {
        headers: { authorization: `Bearer ${cutoverKey.secret}` }
      })).status).toBe(200);

      // Validation and auth failures.
      expect((await fetch(`${running.url}/admin/api/v1/access/api-keys/rotate`, {
        method: "POST",
        headers: rootHeaders,
        body: JSON.stringify({})
      })).status).toBe(422);
      // Non-string expires_at is rejected, never silently dropped.
      expect((await fetch(`${running.url}/admin/api/v1/access/api-keys`, {
        method: "POST",
        headers: rootHeaders,
        body: JSON.stringify({ name: "Typed", role: "integration", expires_at: 12345 })
      })).status).toBe(422);
      expect((await fetch(`${running.url}/admin/api/v1/access/api-keys/rotate`, {
        method: "POST",
        headers: rootHeaders,
        body: JSON.stringify({ key_id: createdKey.api_key.key_id, expires_at: 12345 })
      })).status).toBe(422);
      expect((await fetch(`${running.url}/admin/api/v1/access/api-keys/rotate`, {
        method: "POST",
        headers: rootHeaders,
        body: JSON.stringify({ key_id: "key_missing" })
      })).status).toBe(404);
      expect((await fetch(`${running.url}/admin/api/v1/access/api-keys/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key_id: createdKey.api_key.key_id })
      })).status).toBe(401);
      // An authenticated principal without access:manage is forbidden.
      const operator = await fetch(`${running.url}/admin/api/v1/access/api-keys`, {
        method: "POST",
        headers: rootHeaders,
        body: JSON.stringify({ name: "Operator", role: "operator" })
      });
      expect(operator.status).toBe(201);
      const operatorKey = await operator.json() as { secret: string };
      expect((await fetch(`${running.url}/admin/api/v1/access/api-keys/rotate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorKey.secret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ key_id: createdKey.api_key.key_id })
      })).status).toBe(403);
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects one tenant's API key on another tenant's runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-cross-tenant-"));
    const platformA = await createDemoPlatform({
      databasePath: join(directory, "tenant-a.db"),
      reset: true,
      seed: false,
      program: makeProgram()
    });
    const platformB = await createDemoPlatform({
      databasePath: join(directory, "tenant-b.db"),
      reset: true,
      seed: false,
      program: { ...makeProgram(), program_id: "program-tenant-b" }
    });
    const serverA = await startReferenceServer(platformA.engine, {
      apiKey: "tenant-a-root-key-16c",
      persistState: (state) => platformA.store.save(state),
      admin: { access: platformA.access, storage: platformA.store.status }
    });
    const serverB = await startReferenceServer(platformB.engine, {
      apiKey: "tenant-b-root-key-16c",
      persistState: (state) => platformB.store.save(state),
      admin: { access: platformB.access, storage: platformB.store.status }
    });
    try {
      const created = await fetch(`${serverA.url}/admin/api/v1/access/api-keys`, {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-root-key-16c",
          "content-type": "application/json"
        },
        body: JSON.stringify({ name: "Tenant A key", role: "admin" })
      });
      expect(created.status).toBe(201);
      const key = await created.json() as { secret: string };

      // Tenant A's key works on tenant A only.
      expect((await fetch(`${serverA.url}/lip/v1/capabilities`, {
        headers: { authorization: `Bearer ${key.secret}` }
      })).status).toBe(200);
      expect((await fetch(`${serverB.url}/lip/v1/capabilities`, {
        headers: { authorization: `Bearer ${key.secret}` }
      })).status).toBe(401);
      expect((await fetch(`${serverB.url}/admin/api/v1/snapshot`, {
        headers: { authorization: `Bearer ${key.secret}` }
      })).status).toBe(401);
    } finally {
      await serverA.close();
      await serverB.close();
      await platformA.close();
      await platformB.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed: location-scoped principals are denied tenant-wide admin reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-scope-fail-closed-"));
    const databasePath = join(directory, "reference.db");
    const platform = await createDemoPlatform({
      databasePath,
      reset: true,
      seed: false,
      program: makeProgram()
    });
    const running = await startReferenceServer(platform.engine, {
      apiKey: "fail-closed-key",
      persistState: (state) => platform.store.save(state),
      admin: {
        programs: platform.programs,
        campaigns: platform.campaigns,
        memberships: platform.memberships,
        access: platform.access,
        engagement: platform.engagement,
        locations: platform.locations,
        storage: platform.store.status
      }
    });
    try {
      const scoped = await platform.access.createApiKey({
        name: "Franchisee 42 dashboard",
        role: "viewer",
        allowed_location_ids: ["location-42"]
      }, platform.access.rootPrincipal());
      const scopedHeaders = { authorization: `Bearer ${scoped.secret}` };

      for (const path of [
        "/admin/api/v1/snapshot",
        "/admin/api/v1/analytics",
        "/admin/api/v1/exports/members",
        "/admin/api/v1/maintenance"
      ]) {
        const denied = await fetch(`${running.url}${path}`, { headers: scopedHeaders });
        expect(denied.status, path).toBe(403);
        const body = await denied.json() as { code: string; detail?: string };
        expect(body.code, path).toBe("location_scoped_forbidden");
        expect(body.detail, path).toContain("/admin/api/v1/reports/locations");
      }

      const scopedReport = await fetch(`${running.url}/admin/api/v1/reports/locations`, {
        headers: scopedHeaders
      });
      expect(scopedReport.status).toBe(200);
      const scopedRegistry = await fetch(`${running.url}/admin/api/v1/locations`, {
        headers: scopedHeaders
      });
      expect(scopedRegistry.status).toBe(200);

      // Unscoped principals keep full tenant-wide access.
      const rootHeaders = { authorization: "Bearer fail-closed-key" };
      for (const path of [
        "/admin/api/v1/snapshot",
        "/admin/api/v1/analytics",
        "/admin/api/v1/exports/members",
        "/admin/api/v1/maintenance"
      ]) {
        const allowed = await fetch(`${running.url}${path}`, { headers: rootHeaders });
        expect(allowed.status, path).toBe(200);
      }
      const unscoped = await platform.access.createApiKey({
        name: "HQ dashboard",
        role: "viewer"
      }, platform.access.rootPrincipal());
      const unscopedSnapshot = await fetch(`${running.url}/admin/api/v1/snapshot`, {
        headers: { authorization: `Bearer ${unscoped.secret}` }
      });
      expect(unscopedSnapshot.status).toBe(200);
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates scope payloads strictly and confines scoped principals' registry writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-scope-writes-"));
    const databasePath = join(directory, "reference.db");
    const platform = await createDemoPlatform({
      databasePath,
      reset: true,
      seed: false,
      program: makeProgram()
    });
    const running = await startReferenceServer(platform.engine, {
      apiKey: "scope-writes-key",
      persistState: (state) => platform.store.save(state),
      admin: {
        programs: platform.programs,
        campaigns: platform.campaigns,
        memberships: platform.memberships,
        access: platform.access,
        engagement: platform.engagement,
        locations: platform.locations,
        storage: platform.store.status
      }
    });
    const root = { authorization: "Bearer scope-writes-key", "content-type": "application/json" };
    try {
      // Mixed-type scope arrays are rejected, not silently filtered.
      const mixedUser = await fetch(`${running.url}/admin/api/v1/access/users`, {
        method: "PUT",
        headers: root,
        body: JSON.stringify({
          email: "mixed@acme.example",
          role: "viewer",
          allowed_location_ids: ["location-42", 7]
        })
      });
      expect(mixedUser.status).toBe(422);
      const mixedKey = await fetch(`${running.url}/admin/api/v1/access/api-keys`, {
        method: "POST",
        headers: root,
        body: JSON.stringify({
          name: "Mixed key",
          role: "viewer",
          allowed_location_ids: [null]
        })
      });
      expect(mixedKey.status).toBe(422);

      // allowed_location_ids: null clears a user's stored scope over HTTP.
      const created = await fetch(`${running.url}/admin/api/v1/access/users`, {
        method: "PUT",
        headers: root,
        body: JSON.stringify({
          email: "clearable@acme.example",
          role: "viewer",
          allowed_location_ids: ["location-42"]
        })
      });
      expect(created.status).toBe(200);
      const createdUser = await created.json() as { user_id: string };
      const clearedResponse = await fetch(`${running.url}/admin/api/v1/access/users`, {
        method: "PUT",
        headers: root,
        body: JSON.stringify({
          user_id: createdUser.user_id,
          email: "clearable@acme.example",
          role: "viewer",
          allowed_location_ids: null
        })
      });
      expect(clearedResponse.status).toBe(200);
      const cleared = await clearedResponse.json() as { allowed_location_ids?: string[] };
      expect(cleared.allowed_location_ids).toBeUndefined();

      // Registry writes validate location_id against protocol id constraints.
      const badId = await fetch(`${running.url}/admin/api/v1/locations`, {
        method: "PUT",
        headers: root,
        body: JSON.stringify({ location_id: "bad id!", name: "Invalid" })
      });
      expect(badId.status).toBe(422);

      // A scoped principal may only touch registry rows inside its scope.
      await fetch(`${running.url}/admin/api/v1/locations`, {
        method: "PUT",
        headers: root,
        body: JSON.stringify({ location_id: "location-99", name: "HQ Pilot" })
      });
      const scopedOperator = await platform.access.createApiKey({
        name: "Franchisee 42 operator",
        role: "operator",
        allowed_location_ids: ["location-42"]
      }, platform.access.rootPrincipal());
      const scoped = {
        authorization: `Bearer ${scopedOperator.secret}`,
        "content-type": "application/json"
      };
      const insideScope = await fetch(`${running.url}/admin/api/v1/locations`, {
        method: "PUT",
        headers: scoped,
        body: JSON.stringify({ location_id: "location-42", name: "Downtown Drive-Thru" })
      });
      expect(insideScope.status).toBe(200);
      const outsideScope = await fetch(`${running.url}/admin/api/v1/locations`, {
        method: "PUT",
        headers: scoped,
        body: JSON.stringify({ location_id: "location-99", name: "Hijacked" })
      });
      expect(outsideScope.status).toBe(403);
      const outsideDelete = await fetch(`${running.url}/admin/api/v1/locations/delete`, {
        method: "POST",
        headers: scoped,
        body: JSON.stringify({ location_id: "location-99" })
      });
      expect(outsideDelete.status).toBe(403);
      const insideDelete = await fetch(`${running.url}/admin/api/v1/locations/delete`, {
        method: "POST",
        headers: scoped,
        body: JSON.stringify({ location_id: "location-42" })
      });
      expect(insideDelete.status).toBe(200);
      expect(platform.locations.snapshot().locations.map(({ location_id }) => location_id))
        .toEqual(["location-99"]);
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("manages the location registry and serves location-scoped reports", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-location-admin-"));
    const databasePath = join(directory, "reference.db");
    const platform = await createDemoPlatform({
      databasePath,
      reset: true,
      seed: false,
      program: makeProgram()
    });
    platform.engine.enroll(makeEnroll("location-admin-enroll"));
    platform.engine.postAccrual({
      context: makeContext("location-admin-accrual-42"),
      member_id: "member-001",
      order: makeOrder()
    });
    const otherLocation = makeOrder({ order_id: "order-location-77" });
    otherLocation.scope.location_id = "location-77";
    platform.engine.postAccrual({
      context: makeContext("location-admin-accrual-77"),
      member_id: "member-001",
      order: otherLocation
    });
    const running = await startReferenceServer(platform.engine, {
      apiKey: "location-admin-key",
      persistState: (state) => platform.store.save(state),
      admin: {
        programs: platform.programs,
        campaigns: platform.campaigns,
        memberships: platform.memberships,
        access: platform.access,
        engagement: platform.engagement,
        locations: platform.locations,
        storage: platform.store.status
      }
    });
    try {
      const login = await fetch(`${running.url}/admin/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "location-admin-key" })
      });
      expect(login.status).toBe(204);
      const setCookies = login.headers.getSetCookie();
      const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
      const csrf = decodeURIComponent(
        setCookies
          .find((value) => value.startsWith("lip_admin_csrf="))!
          .split(";", 1)[0]!
          .slice("lip_admin_csrf=".length)
      );

      const missingName = await fetch(`${running.url}/admin/api/v1/locations`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ location_id: "location-42" })
      });
      expect(missingName.status).toBe(422);

      const noCsrf = await fetch(`${running.url}/admin/api/v1/locations`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ location_id: "location-42", name: "Downtown" })
      });
      expect(noCsrf.status).toBe(403);

      const upserted = await fetch(`${running.url}/admin/api/v1/locations`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({
          location_id: "location-42",
          name: "Downtown Drive-Thru",
          franchisee_id: "franchisee-7"
        })
      });
      expect(upserted.status).toBe(200);
      expect(await upserted.json()).toMatchObject({
        location_id: "location-42",
        franchisee_id: "franchisee-7",
        active: true
      });
      await fetch(`${running.url}/admin/api/v1/locations`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ location_id: "location-99", name: "Closed Pilot", active: false })
      });

      const listed = await fetch(`${running.url}/admin/api/v1/locations`, {
        headers: { cookie }
      });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        locations: [
          expect.objectContaining({ location_id: "location-42" }),
          expect.objectContaining({ location_id: "location-99", active: false })
        ]
      });

      const fullReport = await fetch(`${running.url}/admin/api/v1/reports/locations`, {
        headers: { cookie }
      });
      expect(fullReport.status).toBe(200);
      const fullBody = await fullReport.json() as {
        locations: Array<{ location_id: string }>;
        unattributed?: unknown;
      };
      expect(fullBody.locations.map(({ location_id }) => location_id)).toEqual([
        "location-42",
        "location-77",
        "location-99"
      ]);
      expect(fullBody.unattributed).toBeDefined();

      const scopedKey = await fetch(`${running.url}/admin/api/v1/access/api-keys`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({
          name: "Franchisee 77 dashboard",
          role: "viewer",
          allowed_location_ids: ["location-77"]
        })
      });
      expect(scopedKey.status).toBe(201);
      const scoped = await scopedKey.json() as { secret: string };
      const scopedReport = await fetch(`${running.url}/admin/api/v1/reports/locations`, {
        headers: { authorization: `Bearer ${scoped.secret}` }
      });
      expect(scopedReport.status).toBe(200);
      const scopedBody = await scopedReport.json() as {
        locations: Array<{ location_id: string }>;
        unattributed?: unknown;
      };
      expect(scopedBody.locations.map(({ location_id }) => location_id)).toEqual([
        "location-77"
      ]);
      expect(scopedBody.unattributed).toBeUndefined();
      const scopedRegistry = await fetch(`${running.url}/admin/api/v1/locations`, {
        headers: { authorization: `Bearer ${scoped.secret}` }
      });
      expect(scopedRegistry.status).toBe(200);
      expect(await scopedRegistry.json()).toEqual({ locations: [] });

      const removed = await fetch(`${running.url}/admin/api/v1/locations/delete`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-lip-csrf": csrf },
        body: JSON.stringify({ location_id: "location-99" })
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ deleted: true });
      expect(platform.locations.snapshot().locations.map(({ location_id }) => location_id))
        .toEqual(["location-42"]);
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
