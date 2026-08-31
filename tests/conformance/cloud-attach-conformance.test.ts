import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoPlatform, startReferenceServer } from "@loyalty-interchange/server";
import { runCloudVerification } from "@loyalty-interchange/cli";
import { MemoryCloudRepository } from "../../apps/cloud/src/memory-repository.js";
import { CloudControlPlane } from "../../apps/cloud/src/service.js";
import { startCloudServer } from "../../apps/cloud/src/server.js";
import { CloudOperatorService } from "../../apps/cloud/src/operator-service.js";
import { RemoteEnvironmentAttacher } from "../../apps/cloud/src/remote-attach.js";
import { TRUSTED_GATEWAY_ISSUER } from "../../apps/cloud/src/types.js";

const fixedNow = new Date("2026-07-15T12:00:00.000Z");

const OPERATOR_SUBJECT = "conformance-operator-001";

function seedContext(key: string) {
  return {
    protocol_version: "1.0" as const,
    profile: "foodservice/1.0" as const,
    request_id: `req-${key}`,
    idempotency_key: key,
    occurred_at: "2026-07-18T00:00:00.000Z",
    source: { system: "seed" }
  };
}

describe("Cloud attach -> cloud-verify conformance", () => {
  it("creates an environment, attaches a real reference LIP host, and verifies it end to end", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-cloud-verify-conformance-"));
    const databasePath = join(directory, "reference.db");
    const platform = await createDemoPlatform({ databasePath, reset: true, seed: false });
    const lipApiKey = "lip_sk_conformance_0123456789abcdef";

    // Seed a known member so the doctor/conformance/member checks below have
    // something real to read, matching Task 1's seededServer fixture.
    platform.engine.enroll({
      context: seedContext("seed-enroll"),
      program_id: "demo-foodservice",
      identity: { type: "token", value: "known-guest" },
      member_id: "member-001"
    });

    const lipServer = await startReferenceServer(platform.engine, {
      apiKey: lipApiKey,
      port: 0
    });

    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({
      repository,
      now: () => new Date(fixedNow),
      attacher: new RemoteEnvironmentAttacher({ allowPrivateNetworks: true })
    });
    const cloudApiKey = "cloud-verify-conformance-key";
    const operators = new CloudOperatorService({ repository });
    const running = await startCloudServer(cloud, {
      apiKey: cloudApiKey,
      operators,
      port: 0
    });
    // The attach flow authenticates with a platform-admin operator
    // key, whose verified identity carries owner scope on every organization.
    const admin = await operators.createOperator(
      { issuer: TRUSTED_GATEWAY_ISSUER, subject: "bootstrap" },
      { subject: OPERATOR_SUBJECT, role: "platform-admin" }
    );
    const operator = operators.principalFor(admin.operator);
    const operatorHeaders = {
      authorization: `Bearer ${admin.secret}`,
      "content-type": "application/json"
    };

    try {
      const dashboard = await cloud.createOrganization(operator, {
        name: "Conformance Restaurants",
        slug: "conformance-restaurants"
      });
      const project = await cloud.createProject(
        operator,
        dashboard.organization.organization_id,
        { name: "Conformance Loyalty", slug: "conformance-loyalty" }
      );
      const environment = await cloud.createEnvironment(operator, project.project_id, {
        name: "Staging",
        slug: "staging",
        kind: "staging",
        region: "us-east-1",
        program_id: platform.engine.getProgramDefinition().program_id
      });

      // The #4 attach flow: bind the environment to a real reference LIP host.
      const attach = await fetch(
        `${running.url}/cloud/v1/environments/${environment.environment_id}/attach`,
        {
          method: "POST",
          headers: operatorHeaders,
          body: JSON.stringify({ endpoint_url: lipServer.url, api_key: lipApiKey })
        }
      );
      expect(attach.status).toBe(200);
      const attachedEnv = (await attach.json() as {
        data: { status: string; api_url: string };
      }).data;
      expect(attachedEnv.status).toBe("ready");

      // The full path: run runCloudVerification against the attached api_url.
      const report = await runCloudVerification(
        { baseUrl: attachedEnv.api_url, apiKey: lipApiKey },
        {
          programId: "demo-foodservice",
          expectMember: { identity: { type: "token", value: "known-guest" }, available: 0 },
          expectMembers: 1
        }
      );

      expect(report.doctor.ok).toBe(true);
      expect(report.conformance.ok).toBe(true);
      expect(report.knownMember).toMatchObject({ ok: true });
      expect(report.memberCount).toMatchObject({ ok: true });
      expect(report.ok).toBe(true);
    } finally {
      await running.close();
      await cloud.close();
      await lipServer.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
