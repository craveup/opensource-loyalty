import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair
} from "jose";
import { describe, expect, it } from "vitest";
import { createDemoPlatform, startReferenceServer } from "@loyalty-interchange/server";
import { OidcAuthenticator } from "./auth.js";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudOperatorService } from "./operator-service.js";
import { PostgresCloudRepository } from "./postgres-repository.js";
import { CloudProvisioningWorker } from "./provisioning.js";
import { CloudControlPlane, CloudError } from "./service.js";
import { startCloudServer } from "./server.js";
import { TRUSTED_GATEWAY_ISSUER } from "./types.js";

const fixedNow = new Date("2026-07-15T12:00:00.000Z");
const owner = {
  issuer: "https://identity.example.com",
  subject: "user_clerk_001",
  email: "owner@example.com"
};

const OIDC_AUDIENCE = "lip-cloud";

/**
 * A verified-identity harness. Since PLA-442 the shared key cannot mint a
 * principal for a caller-chosen subject, so tests that need several distinct
 * identities issue a real signed token per identity.
 */
async function oidcHarness() {
  const kid = "cloud-test-key";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  const authenticator = new OidcAuthenticator({
    issuer: owner.issuer,
    audience: OIDC_AUDIENCE,
    key: createLocalJWKSet({ keys: [jwk] })
  });
  const tokenFor = async (subject: string, email: string) =>
    new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(owner.issuer)
      .setAudience(OIDC_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  return { authenticator, tokenFor };
}

async function fixture() {
  const repository = new MemoryCloudRepository();
  const cloud = new CloudControlPlane({
    repository,
    regions: ["us-east-1", "eu-west-1"],
    now: () => new Date(fixedNow)
  });
  const dashboard = await cloud.createOrganization(owner, {
    name: "Acme Restaurants",
    slug: "acme-restaurants"
  });
  const project = await cloud.createProject(
    owner,
    dashboard.organization.organization_id,
    { name: "Acme Loyalty", slug: "acme-loyalty" }
  );
  const environment = await cloud.createEnvironment(owner, project.project_id, {
    name: "Production",
    slug: "production",
    kind: "production",
    region: "us-east-1",
    program_id: "acme-rewards"
  });
  return { cloud, repository, dashboard, project, environment };
}

describe("Cloud control plane", () => {
  it("ships a tenant-scoped control-plane migration", () => {
    const sql = [
      "001_control_plane.sql",
      "002_identity_memberships.sql",
      "003_customer_identity.sql"
    ].map((name) => readFileSync(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8"
    )).join("\n");
    for (const table of [
      "lip_cloud_organizations",
      "lip_cloud_organization_memberships",
      "lip_cloud_organization_invitations",
      "lip_cloud_projects",
      "lip_cloud_environments",
      "lip_cloud_plans",
      "lip_cloud_subscriptions",
      "lip_cloud_audit_log",
      "lip_cloud_usage_events",
      "lip_cloud_usage_counters",
      "lip_cloud_provisioning_jobs",
      "lip_cloud_customers",
      "lip_cloud_customer_identities",
      "lip_cloud_customer_consents",
      "lip_cloud_customer_loyalty_memberships"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("UNIQUE (environment_id, metric, idempotency_key)");
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("creates isolated organizations, projects, and provisionable environments", async () => {
    const { cloud, dashboard, project, environment } = await fixture();
    expect(dashboard).toMatchObject({
      organization: { slug: "acme-restaurants" },
      membership: { subject: owner.subject, role: "owner" },
      subscription: { plan_id: "free", status: "active" },
      plan: { plan_id: "free" }
    });
    expect(project.organization_id).toBe(dashboard.organization.organization_id);
    expect(environment).toMatchObject({
      project_id: project.project_id,
      kind: "production",
      region: "us-east-1",
      status: "pending",
      program_id: "acme-rewards"
    });
    expect(environment.tenant_id).toMatch(/^tenant_/);
    await expect(cloud.dashboard(
      { issuer: owner.issuer, subject: "different-user" },
      dashboard.organization.organization_id
    )).rejects.toMatchObject({ status: 404 });
    await expect(cloud.createOrganization(owner, {
      name: "Duplicate",
      slug: "acme-restaurants"
    })).rejects.toMatchObject({ status: 409, code: "slug_conflict" });
  });

  it("meters usage idempotently and enforces plan hard limits", async () => {
    const { cloud, environment } = await fixture();
    const first = await cloud.recordUsage(owner, environment.environment_id, {
      metric: "loyalty_transactions",
      quantity: 900,
      idempotency_key: "orders-2026-07-15"
    });
    expect(first.duplicate).toBe(false);
    const duplicate = await cloud.recordUsage(owner, environment.environment_id, {
      metric: "loyalty_transactions",
      quantity: 900,
      idempotency_key: "orders-2026-07-15"
    });
    expect(duplicate.duplicate).toBe(true);
    await expect(cloud.recordUsage(owner, environment.environment_id, {
      metric: "loyalty_transactions",
      quantity: 101,
      idempotency_key: "orders-2026-07-16"
    })).rejects.toMatchObject({
      status: 429,
      code: "usage_limit_exceeded"
    });
    expect(await cloud.usage(owner, environment.environment_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "loyalty_transactions",
          quantity: 900,
          included: 1_000,
          remaining: 100,
          overage: 0
        })
      ])
    );
  });

  it("invites members and binds membership to issuer and subject", async () => {
    const { cloud, dashboard } = await fixture();
    const invited = {
      issuer: "https://identity.example.com",
      subject: "user_invited_001",
      email: "developer@example.com"
    };
    const invitation = await cloud.inviteMember(
      owner,
      dashboard.organization.organization_id,
      { email: invited.email, role: "developer" }
    );
    expect(invitation.secret).toMatch(/^lip_inv_/);
    expect(invitation.invitation).toMatchObject({
      email: invited.email,
      role: "developer"
    });
    await expect(cloud.acceptInvitation(
      { ...invited, email: "different@example.com" },
      invitation.secret
    )).rejects.toMatchObject({
      status: 403,
      code: "invitation_email_mismatch"
    });
    expect(await cloud.acceptInvitation(invited, invitation.secret)).toMatchObject({
      issuer: invited.issuer,
      subject: invited.subject,
      role: "developer"
    });
    expect(await cloud.members(
      owner,
      dashboard.organization.organization_id
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "owner", subject: owner.subject }),
      expect.objectContaining({ role: "developer", subject: invited.subject })
    ]));
    expect(await cloud.updateMember(
      owner,
      dashboard.organization.organization_id,
      {
        issuer: invited.issuer,
        subject: invited.subject,
        role: "viewer",
        active: false
      }
    )).toMatchObject({ role: "viewer", active: false });
    await expect(cloud.dashboard(
      invited,
      dashboard.organization.organization_id
    )).rejects.toMatchObject({ status: 404 });
    await expect(
      cloud.acceptInvitation(invited, invitation.secret)
    ).rejects.toMatchObject({ status: 409, code: "invitation_accepted" });
  });

  it("verifies OIDC issuer, audience, signature, subject, and verified email", async () => {
    const issuer = "https://identity.example.com";
    const audience = "lip-cloud";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    const authenticator = new OidcAuthenticator({
      issuer,
      audience,
      key: createLocalJWKSet({ keys: [jwk] })
    });
    const token = await new SignJWT({
      email: "OIDC@Example.com",
      email_verified: true
    })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("oidc-user-001")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(authenticator.authenticate({
      authorization: `Bearer ${token}`,
      headers: {}
    })).resolves.toEqual({
      issuer,
      subject: "oidc-user-001",
      email: "oidc@example.com"
    });
    const wrongAudience = new OidcAuthenticator({
      issuer,
      audience: "different-audience",
      key: createLocalJWKSet({ keys: [jwk] })
    });
    await expect(wrongAudience.authenticate({
      authorization: `Bearer ${token}`,
      headers: {}
    })).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    const cloud = new CloudControlPlane({
      repository: new MemoryCloudRepository()
    });
    const running = await startCloudServer(cloud, {
      authenticator,
      port: 0
    });
    try {
      expect(await fetch(`${running.url}/cloud/v1/plans`, {
        headers: { authorization: `Bearer ${token}` }
      }).then((response) => response.status)).toBe(200);
      expect(await fetch(`${running.url}/cloud/v1/plans`, {
        headers: { authorization: "Bearer invalid" }
      }).then((response) => response.status)).toBe(401);
    } finally {
      await running.close();
      await cloud.close();
    }
  });

  it("claims provisioning jobs and marks environments ready", async () => {
    const { repository, environment } = await fixture();
    const worker = new CloudProvisioningWorker({
      repository,
      workerId: "worker-test-1",
      provisioner: {
        provision: async ({ environment: target }) => ({
          api_url: `https://${target.environment_id}.api.example.com`,
          admin_url: `https://${target.environment_id}.admin.example.com`
        })
      }
    });
    expect(await worker.runOnce()).toBe("succeeded");
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({
      status: "ready",
      api_url: `https://${environment.environment_id}.api.example.com`,
      admin_url: `https://${environment.environment_id}.admin.example.com`
    });
    expect(await worker.runOnce()).toBe("idle");
  });

  it("validates regions, identifiers, and usage input", async () => {
    const { cloud, project, environment } = await fixture();
    await expect(cloud.createEnvironment(owner, project.project_id, {
      name: "Other",
      slug: "other-env",
      kind: "production",
      region: "moon-1",
      program_id: "acme-rewards"
    })).rejects.toMatchObject({ status: 422, code: "unsupported_region" });
    await expect(cloud.recordUsage(owner, environment.environment_id, {
      metric: "messages",
      quantity: 0,
      idempotency_key: "invalid-quantity"
    })).rejects.toBeInstanceOf(CloudError);
  });

  it("serves an authenticated Cloud management API", async () => {
    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({
      repository,
      now: () => new Date(fixedNow)
    });
    const { authenticator, tokenFor } = await oidcHarness();
    const running = await startCloudServer(cloud, {
      authenticator,
      deployment: { environment: "sandbox", release: "candidate-commit" },
      port: 0
    });
    const headers = {
      authorization: `Bearer ${await tokenFor(owner.subject, owner.email)}`,
      "content-type": "application/json"
    };
    try {
      const health = await fetch(`${running.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        environment: "sandbox",
        instance_policy: "single",
        release: "candidate-commit",
        service: "lip-cloud-control-plane",
        status: "ok"
      });
      const metrics = await fetch(`${running.url}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      expect(await metrics.text()).toContain("lip_cloud_http_requests_total");
      const unauthorized = await fetch(`${running.url}/cloud/v1/organizations`);
      expect(unauthorized.status).toBe(401);
      const createdResponse = await fetch(`${running.url}/cloud/v1/organizations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Cloud Org", slug: "cloud-org" })
      });
      expect(createdResponse.status).toBe(201);
      expect(createdResponse.headers.get("location")).toMatch(
        /^\/cloud\/v1\/organizations\/org_/
      );
      const created = await createdResponse.json() as {
        data: { organization: { organization_id: string } };
      };
      const listResponse = await fetch(`${running.url}/cloud/v1/organizations`, {
        headers
      });
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({
        data: [{ organization_id: created.data.organization.organization_id }]
      });
      const projectResponse = await fetch(
        `${running.url}/cloud/v1/organizations/${created.data.organization.organization_id}/projects`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Cloud Project", slug: "cloud-project" })
        }
      );
      expect(projectResponse.status).toBe(201);
      const invitationResponse = await fetch(
        `${running.url}/cloud/v1/organizations/${created.data.organization.organization_id}/invitations`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            email: "api-member@example.com",
            role: "viewer"
          })
        }
      );
      expect(invitationResponse.status).toBe(201);
      const invitation = await invitationResponse.json() as {
        data: { secret: string };
      };
      const memberHeaders = {
        ...headers,
        authorization: `Bearer ${await tokenFor("api-member-001", "api-member@example.com")}`
      };
      const acceptResponse = await fetch(
        `${running.url}/cloud/v1/invitations/accept`,
        {
          method: "POST",
          headers: memberHeaders,
          body: JSON.stringify({ secret: invitation.data.secret })
        }
      );
      expect(acceptResponse.status).toBe(200);
      const updateMemberResponse = await fetch(
        `${running.url}/cloud/v1/organizations/${created.data.organization.organization_id}/members`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            issuer: owner.issuer,
            subject: "api-member-001",
            role: "developer"
          })
        }
      );
      expect(updateMemberResponse.status).toBe(200);
      const membersResponse = await fetch(
        `${running.url}/cloud/v1/organizations/${created.data.organization.organization_id}/members`,
        { headers }
      );
      expect(await membersResponse.json()).toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ subject: "api-member-001", role: "developer" })
        ])
      });
    } finally {
      await running.close();
      await cloud.close();
    }
  });

  it("attaches a remote data-plane host synchronously via POST /attach", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-cloud-attach-"));
    const databasePath = join(directory, "reference.db");
    const platform = await createDemoPlatform({ databasePath, reset: true, seed: false });
    const lipApiKey = "lip_sk_attach_test_0123456789abcdef";
    const lipServer = await startReferenceServer(platform.engine, {
      apiKey: lipApiKey,
      port: 0
    });
    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({
      repository,
      now: () => new Date(fixedNow)
    });
    const operators = new CloudOperatorService({ repository });
    const running = await startCloudServer(cloud, {
      apiKey: "cloud-attach-test-api-key",
      operators,
      port: 0
    });
    // PLA-442: the attach route is driven by a platform-admin operator key,
    // which carries its own verified identity and gets virtual owner scope on
    // every organization — no membership wiring or subject header needed.
    const admin = await operators.createOperator(
      { issuer: TRUSTED_GATEWAY_ISSUER, subject: "bootstrap" },
      { subject: "attach-operator-001", role: "platform-admin" }
    );
    const operator = operators.principalFor(admin.operator);
    const operatorHeaders = {
      authorization: `Bearer ${admin.secret}`,
      "content-type": "application/json"
    };
    try {
      const dashboard = await cloud.createOrganization(operator, {
        name: "Attach Restaurants",
        slug: "attach-restaurants"
      });
      const project = await cloud.createProject(
        operator,
        dashboard.organization.organization_id,
        { name: "Attach Loyalty", slug: "attach-loyalty" }
      );
      const environment = await cloud.createEnvironment(operator, project.project_id, {
        name: "Production",
        slug: "production",
        kind: "production",
        region: "us-east-1",
        program_id: platform.engine.getProgramDefinition().program_id
      });
      const cloudUrl = running.url;
      const environmentId = environment.environment_id;

      // attach with the correct key → ready + fingerprint, no full key stored
      const attach = await fetch(`${cloudUrl}/cloud/v1/environments/${environmentId}/attach`, {
        method: "POST",
        headers: operatorHeaders,
        body: JSON.stringify({ endpoint_url: lipServer.url, api_key: lipApiKey })
      });
      expect(attach.status).toBe(200);
      const attachedEnv = (await attach.json() as {
        data: {
          status: string;
          api_url: string;
          api_key_fingerprint: string;
        };
      }).data;
      expect(attachedEnv.status).toBe("ready");
      expect(attachedEnv.api_url).toBe(lipServer.url.replace(/\/+$/, ""));
      expect(attachedEnv.api_key_fingerprint).toContain("…");
      expect(JSON.stringify(attachedEnv)).not.toContain(lipApiKey);

      // attach with a wrong key → 422 auth_rejected, not ready
      const bad = await fetch(`${cloudUrl}/cloud/v1/environments/${environmentId}/attach`, {
        method: "POST",
        headers: operatorHeaders,
        body: JSON.stringify({ endpoint_url: lipServer.url, api_key: "lip_sk_wrong" })
      });
      expect(bad.status).toBe(422);
      expect((await bad.json() as { code: string }).code).toBe("auth_rejected");
      expect(await repository.environmentById(environmentId)).toMatchObject({
        status: "failed",
        status_message: "auth_rejected"
      });
    } finally {
      await running.close();
      await cloud.close();
      await lipServer.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects attach for a non-attachable environment status with 409", async () => {
    const { cloud, repository, environment } = await fixture();
    await repository.attachEnvironment(environment.environment_id, {
      api_url: "https://x",
      status: "suspended"
    });
    await expect(cloud.attachEnvironment(owner, environment.environment_id, {
      endpoint_url: "https://data-plane.example.com",
      api_key: "lip_sk_irrelevant"
    })).rejects.toMatchObject({
      status: 409,
      code: "environment_not_attachable"
    });
  });
});

const postgresUrl = process.env["LIP_TEST_POSTGRES_URL"];
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("Cloud Postgres integration", () => {
  it("migrates and persists an isolated organization lifecycle", async () => {
    const repository = new PostgresCloudRepository({
      connectionString: postgresUrl!
    });
    const suffix = randomUUID().slice(0, 8);
    const principal = {
      issuer: "https://identity.example.com",
      subject: `integration-user-${suffix}`
    };
    const cloud = new CloudControlPlane({
      repository,
      now: () => new Date(fixedNow)
    });
    try {
      await cloud.migrate();
      const dashboard = await cloud.createOrganization(principal, {
        name: "Integration Organization",
        slug: `integration-${suffix}`
      });
      const project = await cloud.createProject(
        principal,
        dashboard.organization.organization_id,
        { name: "Integration Project", slug: "integration-project" }
      );
      const environment = await cloud.createEnvironment(
        principal,
        project.project_id,
        {
          name: "Development",
          slug: "development",
          kind: "development",
          region: "us-east-1",
          program_id: "integration-program"
        }
      );
      await cloud.recordUsage(principal, environment.environment_id, {
        metric: "loyalty_transactions",
        quantity: 12,
        idempotency_key: `integration-${suffix}`
      });
      expect(await cloud.usage(principal, environment.environment_id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metric: "loyalty_transactions",
            quantity: 12
          })
        ])
      );
    } finally {
      await cloud.close();
    }
  });
});
