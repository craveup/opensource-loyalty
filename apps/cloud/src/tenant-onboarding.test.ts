import { describe, expect, it } from "vitest";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudOperatorService } from "./operator-service.js";
import { CloudProvisioningWorker } from "./provisioning.js";
import { CloudControlPlane } from "./service.js";
import { startCloudServer } from "./server.js";
import {
  TenantOnboardingError,
  provisionTenant,
  rotateTenantCredentials
} from "./tenant-onboarding.js";
import { TRUSTED_GATEWAY_ISSUER } from "./types.js";

/**
 * Legacy shared trusted-gateway key. With the operator credential model, it authenticates nothing
 * but the first-operator bootstrap, so tests use it only to mint the operator
 * key below and to assert the retired-key behavior itself.
 */
const sharedKey = "cloud-onboarding-test-key";

/** Subject of the platform-admin operator every fixture bootstraps. */
const OPERATOR_SUBJECT = "operator_biz_manager";

/**
 * Onboarding client target. An operator key (`lip_ok_...`) carries its own
 * verified identity, so no subject flag is threaded through.
 */
const target = (url: string, apiKey: string) => ({
  cloudUrl: url,
  apiKey,
  email: "ops@example.com"
});

const request = (overrides: Partial<{ envSlug: string; programId: string }> = {}) => ({
  organization: { name: "Demo Restaurants", slug: "demo-restaurants" },
  project: { name: "Loyalty", slug: "loyalty" },
  environment: {
    name: "Production",
    slug: overrides.envSlug ?? "production",
    kind: "production" as const,
    region: "us-east-1",
    programId: overrides.programId ?? "demo-rewards"
  },
  poll: { timeoutMs: 1_500, intervalMs: 20 }
});

async function fixture() {
  const repository = new MemoryCloudRepository();
  const operators = new CloudOperatorService({ repository });
  const cloud = new CloudControlPlane({ repository, regions: ["us-east-1"] });
  const running = await startCloudServer(cloud, { apiKey: sharedKey, operators, port: 0 });
  // The shared key spends its single use bootstrapping the first
  // platform-admin; every later request authenticates with that operator key.
  const bootstrap = await operators.createOperator(
    { issuer: TRUSTED_GATEWAY_ISSUER, subject: "bootstrap" },
    { subject: OPERATOR_SUBJECT, role: "platform-admin" }
  );
  const worker = new CloudProvisioningWorker({
    repository,
    workerId: "onboarding-test-worker",
    provisioner: {
      provision: async ({ environment }) => ({
        api_url: `http://data-plane.internal:13210/${environment.tenant_id}`,
        admin_url: `http://data-plane.internal:13210/${environment.tenant_id}/admin/`
      })
    }
  });
  const drive = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await worker.runOnce() === "succeeded") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const close = async () => {
    worker.close();
    await running.close();
    await cloud.close();
  };
  return { url: running.url, operators, operatorKey: bootstrap.secret, drive, close };
}

describe("provisionTenant", () => {
  it("creates org, project, and environment, then reports the ready tenant", async () => {
    const { url, operatorKey, drive, close } = await fixture();
    try {
      const [result] = await Promise.all([
        provisionTenant(target(url, operatorKey), request()),
        drive()
      ]);
      expect(result.tenant_id).toMatch(/^tenant_/);
      expect(result.status).toBe("ready");
      expect(result.timed_out).toBe(false);
      expect(result.api_url).toContain(result.tenant_id);
      expect(result.created).toEqual({ organization: true, project: true, environment: true });
    } finally {
      await close();
    }
  });

  it("is idempotent: re-running with the same slugs reuses every resource", async () => {
    const { url, operatorKey, drive, close } = await fixture();
    try {
      const [first] = await Promise.all([
        provisionTenant(target(url, operatorKey), request()),
        drive()
      ]);
      const second = await provisionTenant(target(url, operatorKey), request());
      expect(second.tenant_id).toBe(first.tenant_id);
      expect(second.environment_id).toBe(first.environment_id);
      expect(second.status).toBe("ready");
      expect(second.created).toEqual({ organization: false, project: false, environment: false });
    } finally {
      await close();
    }
  });

  it("rejects reusing an environment slug for a different program", async () => {
    const { url, operatorKey, drive, close } = await fixture();
    try {
      await Promise.all([provisionTenant(target(url, operatorKey), request()), drive()]);
      await expect(
        provisionTenant(target(url, operatorKey), request({ programId: "other-program" }))
      ).rejects.toMatchObject({ code: "program_mismatch", status: 409 });
    } finally {
      await close();
    }
  });

  it("returns a pending, timed-out result when no provisioning worker runs", async () => {
    const { url, operatorKey, close } = await fixture();
    try {
      const result = await provisionTenant(target(url, operatorKey), {
        ...request(),
        poll: { timeoutMs: 100, intervalMs: 20 }
      });
      expect(result.status).toBe("pending");
      expect(result.timed_out).toBe(true);
      expect(result.api_url).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("rejects an invalid webhook configuration before touching the control plane", async () => {
    await expect(provisionTenant(target("http://127.0.0.1:9", "lip_ok_unused_client_side_validation"), {
      ...request(),
      webhook: { url: "https://hooks.example.com/loyalty", secret: "short" }
    })).rejects.toThrow(/16/);
    await expect(provisionTenant(target("http://127.0.0.1:9", "lip_ok_unused_client_side_validation"), {
      ...request(),
      webhook: { url: "ftp://hooks.example.com/loyalty", secret: "a-webhook-secret-16ch" }
    })).rejects.toThrow(/HTTP/i);
  });

  it("onboards with an operator API key and no subject flag", async () => {
    const { url, operatorKey, drive, close } = await fixture();
    try {
      const [result] = await Promise.all([
        provisionTenant({ cloudUrl: url, apiKey: operatorKey }, request()),
        drive()
      ]);
      expect(result.status).toBe("ready");
      expect(result.created.organization).toBe(true);
    } finally {
      await close();
    }
  });

  it("rejects the legacy shared key before any request is sent", async () => {
    // The shared key only authenticates the first-operator bootstrap route,
    // which onboarding never calls — so this fails client-side, with or
    // without a subject, and never reaches the network.
    for (const subject of [undefined, "operator_biz_manager"]) {
      await expect(provisionTenant(
        {
          cloudUrl: "http://127.0.0.1:9",
          apiKey: sharedKey,
          ...(subject ? { subject } : {})
        },
        request()
      )).rejects.toThrow(/per-operator API key \(lip_ok_\.\.\.\) is required/);
    }
  });

  it("retires the shared key server-side once an operator exists", async () => {
    const { url, close } = await fixture();
    try {
      const response = await fetch(`${url}/cloud/v1/organizations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sharedKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ name: "Shared Key Org", slug: "shared-key-org" })
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "shared_key_retired" });
    } finally {
      await close();
    }
  });

  it("surfaces control-plane authentication failures", async () => {
    const { url, close } = await fixture();
    try {
      await expect(
        provisionTenant(target(url, "lip_ok_unregistered_operator_key"), request())
      ).rejects.toBeInstanceOf(TenantOnboardingError);
      await expect(
        provisionTenant(target(url, "lip_ok_unregistered_operator_key"), request())
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      await close();
    }
  });
});

describe("rotateTenantCredentials", () => {
  it("returns the fresh merchant credential from the rotation endpoint", async () => {
    const repository = new MemoryCloudRepository();
    const operators = new CloudOperatorService({ repository });
    const cloud = new CloudControlPlane({ repository, regions: ["us-east-1"] });
    const rotateCalls: Array<{
      environmentId: string;
      options: { subject: string; overlap_seconds?: number };
    }> = [];
    const running = await startCloudServer(cloud, {
      apiKey: sharedKey,
      operators,
      port: 0,
      rotateEnvironmentCredentials: async (environmentId, options) => {
        rotateCalls.push({ environmentId, options });
        return {
          environment_id: environmentId,
          tenant_id: "tenant_rotated",
          program_id: "demo-rewards",
          api_url: "http://data-plane.internal:13999",
          admin_url: "http://data-plane.internal:13999/admin/",
          merchant_api_key: "lip_sk_rotated_merchant_secret",
          merchant_api_key_id: "key_rotated",
          replaced_api_key_expires_at: "2099-01-01T00:00:00.000Z"
        };
      }
    });
    const worker = new CloudProvisioningWorker({
      repository,
      workerId: "rotation-test-worker",
      provisioner: {
        provision: async ({ environment }) => ({
          api_url: `http://data-plane.internal:13210/${environment.tenant_id}`
        })
      }
    });
    // Bootstrap the platform-admin whose key drives every rotation
    // below, and whose subject is the expected attribution subject.
    const admin = await operators.createOperator(
      { issuer: TRUSTED_GATEWAY_ISSUER, subject: "bootstrap" },
      { subject: OPERATOR_SUBJECT, role: "platform-admin" }
    );
    const operatorKey = admin.secret;
    try {
      const [provisioned] = await Promise.all([
        provisionTenant(target(running.url, operatorKey), request()),
        (async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (await worker.runOnce() === "succeeded") return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        })()
      ]);
      const rotated = await rotateTenantCredentials(
        target(running.url, operatorKey),
        provisioned.environment_id
      );
      expect(rotated).toMatchObject({
        environment_id: provisioned.environment_id,
        tenant_id: "tenant_rotated",
        merchant_api_key: "lip_sk_rotated_merchant_secret",
        merchant_api_key_id: "key_rotated",
        replaced_api_key_expires_at: "2099-01-01T00:00:00.000Z",
        rotated_at: expect.any(String)
      });
      // The operator subject is threaded down for tenant-side attribution.
      expect(rotateCalls.at(-1)?.options.subject).toBe("operator_biz_manager");
      expect(rotateCalls.at(-1)?.options.overlap_seconds).toBeUndefined();

      // An explicit overlap (emergency cutover) reaches the data plane.
      await rotateTenantCredentials(
        target(running.url, operatorKey),
        provisioned.environment_id,
        { overlapSeconds: 0 }
      );
      expect(rotateCalls.at(-1)?.options.overlap_seconds).toBe(0);

      await expect(rotateTenantCredentials(target(running.url, operatorKey), "env_unknown"))
        .rejects.toMatchObject({ status: 404 });

      // Under an operator key the tenant-side attribution subject is the
      // VERIFIED operator, regardless of any claimed subject.
      const second = await operators.createOperator(
        operators.principalFor(admin.operator),
        { subject: "rotation-operator-001", role: "platform-admin" }
      );
      await rotateTenantCredentials(
        {
          cloudUrl: running.url,
          apiKey: second.secret,
          subject: "claimed-someone-else"
        },
        provisioned.environment_id
      );
      expect(rotateCalls.at(-1)?.options.subject).toBe("rotation-operator-001");
    } finally {
      worker.close();
      await running.close();
      await cloud.close();
    }
  });
});
