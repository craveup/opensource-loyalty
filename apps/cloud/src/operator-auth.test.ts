import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair
} from "jose";
import { describe, expect, it } from "vitest";
import { OidcAuthenticator } from "./auth.js";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudOperatorService, OPERATOR_ISSUER } from "./operator-service.js";
import { PostgresCloudRepository } from "./postgres-repository.js";
import { CloudControlPlane } from "./service.js";
import { startCloudServer } from "./server.js";
import { TRUSTED_GATEWAY_ISSUER, type CloudPrincipal } from "./types.js";

const sharedKey = "shared-bootstrap-key-0123456789";
const gateway: CloudPrincipal = {
  issuer: TRUSTED_GATEWAY_ISSUER,
  subject: "legacy-gateway-operator"
};

function fixture(clock?: { now: Date }) {
  const repository = new MemoryCloudRepository();
  const operators = new CloudOperatorService({
    repository,
    ...(clock ? { now: () => new Date(clock.now) } : {})
  });
  const cloud = new CloudControlPlane({
    repository,
    regions: ["us-east-1"],
    ...(clock ? { now: () => new Date(clock.now) } : {})
  });
  return { repository, operators, cloud };
}

async function bootstrapAdmin(
  operators: CloudOperatorService,
  subject = "admin-operator-001"
) {
  const created = await operators.createOperator(gateway, {
    subject,
    email: "ops@example.com",
    role: "platform-admin"
  });
  const principal = await operators.authenticate(created.secret);
  if (!principal) throw new Error("bootstrap operator did not authenticate");
  return { ...created, principal };
}

describe("operator schema", () => {
  it("ships hashed, expiring operator API keys in migration 005", () => {
    const sql = readFileSync(
      new URL("../migrations/005_operators.sql", import.meta.url),
      "utf8"
    );
    for (const table of [
      "lip_cloud_operators",
      "lip_cloud_operator_api_keys",
      "lip_cloud_operator_audit"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("secret_hash");
    expect(sql).toMatch(/subject TEXT NOT NULL UNIQUE/);
    expect(sql).toContain("expires_at");
  });
});

describe("CloudOperatorService", () => {
  it("bootstraps the first platform-admin via the shared gateway, then closes the door", async () => {
    const { repository, operators } = fixture();
    const created = await operators.createOperator(gateway, {
      subject: "admin-operator-001",
      email: "ops@example.com",
      role: "platform-admin"
    });
    expect(created.secret).toMatch(/^lip_ok_/);
    expect(created.operator).toMatchObject({
      subject: "admin-operator-001",
      role: "platform-admin",
      active: true
    });
    expect(created.api_key.prefix).toBe(created.secret.slice(0, 15));
    // The secret is hashed at rest and never echoed on the stored record.
    expect(JSON.stringify(created.api_key)).not.toContain(created.secret);
    const [stored] = await repository.operatorApiKeys(created.operator.operator_id);
    expect(stored?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.secret_hash).not.toContain(created.secret);

    // The shared gateway may only ever create the FIRST operator.
    await expect(operators.createOperator(gateway, {
      subject: "admin-operator-002",
      role: "platform-admin"
    })).rejects.toMatchObject({ status: 403, code: "operator_bootstrap_exhausted" });

    // A platform-admin operator can create more, including org-scoped ones.
    const principal = await operators.authenticate(created.secret);
    expect(principal).toMatchObject({
      issuer: OPERATOR_ISSUER,
      subject: "admin-operator-001",
      operator: {
        operator_id: created.operator.operator_id,
        role: "platform-admin"
      }
    });
    const scoped = await operators.createOperator(principal!, {
      subject: "brand-operator-001",
      role: "org-scoped",
      organization_ids: ["org_demo"]
    });
    expect(scoped.operator).toMatchObject({
      role: "org-scoped",
      organization_ids: ["org_demo"]
    });

    // Org-scoped operators cannot mint operators.
    const scopedPrincipal = await operators.authenticate(scoped.secret);
    await expect(operators.createOperator(scopedPrincipal!, {
      subject: "brand-operator-002",
      role: "platform-admin"
    })).rejects.toMatchObject({ status: 403 });

    // Duplicate subjects conflict.
    await expect(operators.createOperator(principal!, {
      subject: "brand-operator-001",
      role: "platform-admin"
    })).rejects.toMatchObject({ status: 409, code: "operator_conflict" });

    // Org-scoped operators must carry a scope; platform-admins must not.
    await expect(operators.createOperator(principal!, {
      subject: "broken-operator",
      role: "org-scoped"
    })).rejects.toMatchObject({ status: 422 });
    await expect(operators.createOperator(principal!, {
      subject: "broken-operator",
      role: "platform-admin",
      organization_ids: ["org_demo"]
    })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects expired, revoked, and deactivated operator credentials", async () => {
    const clock = { now: new Date("2026-07-23T12:00:00.000Z") };
    const { operators } = fixture(clock);
    const admin = await bootstrapAdmin(operators);

    expect(await operators.authenticate("lip_ok_definitely-wrong")).toBeUndefined();
    expect(await operators.authenticate("not-even-prefixed")).toBeUndefined();

    // Expiring key stops authenticating once the clock passes expires_at.
    const expiring = await operators.createOperatorKey(
      admin.principal,
      admin.operator.operator_id,
      { name: "short-lived", expires_at: "2026-07-23T13:00:00.000Z" }
    );
    expect(await operators.authenticate(expiring.secret)).toBeDefined();
    clock.now = new Date("2026-07-23T14:00:00.000Z");
    expect(await operators.authenticate(expiring.secret)).toBeUndefined();

    // Revoked key dies immediately.
    const revocable = await operators.createOperatorKey(
      admin.principal,
      admin.operator.operator_id,
      { name: "revocable" }
    );
    await operators.revokeOperatorKey(admin.principal, admin.operator.operator_id, {
      key_id: revocable.api_key.key_id
    });
    expect(await operators.authenticate(revocable.secret)).toBeUndefined();

    // Deactivated operator's keys all die, even when unexpired.
    const second = await operators.createOperator(admin.principal, {
      subject: "admin-operator-002",
      role: "platform-admin"
    });
    await operators.updateOperator(admin.principal, second.operator.operator_id, {
      active: false
    });
    expect(await operators.authenticate(second.secret)).toBeUndefined();
  });

  it("rotates operator keys with bounded overlap and inherit-expiry semantics", async () => {
    const clock = { now: new Date("2026-07-23T12:00:00.000Z") };
    const { repository, operators } = fixture(clock);
    const admin = await bootstrapAdmin(operators);
    const operatorId = admin.operator.operator_id;

    // Default rotation keeps the replaced key alive for 24 h, no longer.
    const rotated = await operators.rotateOperatorKey(admin.principal, operatorId, {
      key_id: admin.api_key.key_id
    });
    expect(rotated.secret).toMatch(/^lip_ok_/);
    expect(rotated.secret).not.toBe(admin.secret);
    expect(rotated.replaced_api_key.key_id).toBe(admin.api_key.key_id);
    expect(rotated.replaced_api_key.expires_at)
      .toBe("2026-07-24T12:00:00.000Z");
    expect(await operators.authenticate(admin.secret)).toBeDefined();
    expect(await operators.authenticate(rotated.secret)).toBeDefined();
    clock.now = new Date("2026-07-24T12:00:01.000Z");
    expect(await operators.authenticate(admin.secret)).toBeUndefined();
    expect(await operators.authenticate(rotated.secret)).toBeDefined();

    // Both rotation audit entries are recorded as a pair.
    const audit = await repository.operatorAuditEntries();
    expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "cloud.operator.api_key.created",
      "cloud.operator.api_key.rotated"
    ]));

    // Zero overlap kills the replaced key immediately.
    const emergency = await operators.rotateOperatorKey(admin.principal, operatorId, {
      key_id: rotated.api_key.key_id,
      overlap_seconds: 0
    });
    expect(await operators.authenticate(rotated.secret)).toBeUndefined();
    expect(await operators.authenticate(emergency.secret)).toBeDefined();

    // The replacement inherits a time-boxed expiry; rotation never extends it.
    const boxed = await operators.createOperatorKey(admin.principal, operatorId, {
      name: "time-boxed",
      expires_at: "2026-07-30T00:00:00.000Z"
    });
    const boxedRotation = await operators.rotateOperatorKey(admin.principal, operatorId, {
      key_id: boxed.api_key.key_id
    });
    expect(boxedRotation.api_key.expires_at).toBe("2026-07-30T00:00:00.000Z");
    await expect(operators.rotateOperatorKey(admin.principal, operatorId, {
      key_id: boxedRotation.api_key.key_id,
      expires_at: "2026-08-15T00:00:00.000Z"
    })).rejects.toMatchObject({ status: 422 });
    await expect(operators.rotateOperatorKey(admin.principal, operatorId, {
      key_id: boxedRotation.api_key.key_id,
      overlap_seconds: 999_999_999
    })).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to deactivate the last active platform-admin", async () => {
    const { operators } = fixture();
    const admin = await bootstrapAdmin(operators);
    await expect(operators.updateOperator(
      admin.principal,
      admin.operator.operator_id,
      { active: false }
    )).rejects.toMatchObject({ status: 409, code: "operator_lockout" });
    const second = await operators.createOperator(admin.principal, {
      subject: "admin-operator-002",
      role: "platform-admin"
    });
    const updated = await operators.updateOperator(
      admin.principal,
      second.operator.operator_id,
      { active: false }
    );
    expect(updated.active).toBe(false);
  });
});

describe("Cloud server operator auth", () => {
  async function httpFixture(options: {
    sharedKeyDisabled?: boolean;
    rotateSubjects?: string[];
  } = {}) {
    const { repository, operators, cloud } = fixture();
    const rotateSubjects = options.rotateSubjects ?? [];
    const running = await startCloudServer(cloud, {
      apiKey: sharedKey,
      operators,
      port: 0,
      ...(options.sharedKeyDisabled ? { sharedKeyDisabled: true } : {}),
      rotateEnvironmentCredentials: async (environmentId, rotateOptions) => {
        rotateSubjects.push(rotateOptions.subject);
        return {
          environment_id: environmentId,
          tenant_id: "tenant_rotated",
          program_id: "demo-rewards",
          api_url: "http://data-plane.internal:13999",
          admin_url: "http://data-plane.internal:13999/admin/",
          merchant_api_key: "lip_sk_rotated_merchant_secret",
          merchant_api_key_id: "key_rotated"
        };
      }
    });
    return { repository, operators, cloud, running, rotateSubjects };
  }

  it("bootstraps the first operator over HTTP with the shared key, once", async () => {
    const { running, cloud } = await httpFixture();
    try {
      // Fix 2: the bootstrap request carries NO X-LIP-Cloud-Subject header —
      // the operator identity comes from the body, exactly as the CLI sends it.
      const bootstrap = await fetch(`${running.url}/cloud/v1/operators`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sharedKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          subject: "admin-operator-001",
          email: "ops@example.com",
          role: "platform-admin"
        })
      });
      expect(bootstrap.status).toBe(201);
      const created = (await bootstrap.json() as {
        data: { secret: string; operator: { operator_id: string } };
      }).data;
      expect(created.secret).toMatch(/^lip_ok_/);

      // A second shared-key request is now retired (an operator exists).
      const again = await fetch(`${running.url}/cloud/v1/operators`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sharedKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ subject: "admin-operator-002", role: "platform-admin" })
      });
      expect(again.status).toBe(401);
      expect((await again.json() as { code: string }).code).toBe("shared_key_retired");

      // The minted operator key manages operators from here on.
      const list = await fetch(`${running.url}/cloud/v1/operators`, {
        headers: { authorization: `Bearer ${created.secret}` }
      });
      expect(list.status).toBe(200);
      expect((await list.json() as { data: unknown[] }).data).toHaveLength(1);
    } finally {
      await running.close();
      await cloud.close();
    }
  });

  it("derives identity from the operator key, never from the subject header", async () => {
    const { repository, operators, running, cloud, rotateSubjects } = await httpFixture();
    try {
      const admin = await bootstrapAdmin(operators, "admin-operator-verified");
      const headers = {
        authorization: `Bearer ${admin.secret}`,
        "content-type": "application/json",
        // A hostile caller claims someone else — it must NOT become identity.
        "x-lip-cloud-subject": "victim-subject"
      };
      const createdResponse = await fetch(`${running.url}/cloud/v1/organizations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Verified Org", slug: "verified-org" })
      });
      expect(createdResponse.status).toBe(201);
      const dashboard = (await createdResponse.json() as {
        data: {
          organization: { organization_id: string };
          membership: { issuer: string; subject: string };
        };
      }).data;
      expect(dashboard.membership.subject).toBe("admin-operator-verified");
      expect(dashboard.membership.issuer).toBe(OPERATOR_ISSUER);

      // Audit records the verified operator id; the claimed subject is only
      // an on-behalf-of annotation.
      const audit = await repository.auditForOrganization(
        dashboard.organization.organization_id
      );
      expect(audit[0]).toMatchObject({
        actor_subject: "admin-operator-verified",
        metadata: expect.objectContaining({
          operator_id: admin.operator.operator_id,
          on_behalf_of: "victim-subject"
        })
      });

      // The data-plane rotation hook receives the VERIFIED operator subject.
      const project = await fetch(
        `${running.url}/cloud/v1/organizations/${dashboard.organization.organization_id}/projects`,
        { method: "POST", headers, body: JSON.stringify({ name: "Loyalty", slug: "loyalty" }) }
      ).then(async (response) => (await response.json() as {
        data: { project_id: string };
      }).data);
      const environment = await fetch(
        `${running.url}/cloud/v1/projects/${project.project_id}/environments`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Production",
            slug: "production",
            kind: "production",
            region: "us-east-1",
            program_id: "demo-rewards"
          })
        }
      ).then(async (response) => (await response.json() as {
        data: { environment_id: string };
      }).data);
      const rotate = await fetch(
        `${running.url}/cloud/v1/environments/${environment.environment_id}/credentials/rotate`,
        { method: "POST", headers }
      );
      expect(rotate.status).toBe(200);
      expect(rotateSubjects).toEqual(["admin-operator-verified"]);
    } finally {
      await running.close();
      await cloud.close();
    }
  });

  it("confines org-scoped operators to their organizations", async () => {
    const { operators, cloud, running, rotateSubjects } = await httpFixture();
    try {
      const admin = await bootstrapAdmin(operators);
      const orgA = await cloud.createOrganization(admin.principal, {
        name: "Brand A", slug: "brand-a"
      });
      const orgB = await cloud.createOrganization(admin.principal, {
        name: "Brand B", slug: "brand-b"
      });
      const projectA = await cloud.createProject(
        admin.principal, orgA.organization.organization_id,
        { name: "Loyalty", slug: "loyalty" }
      );
      const projectB = await cloud.createProject(
        admin.principal, orgB.organization.organization_id,
        { name: "Loyalty", slug: "loyalty" }
      );
      const environmentA = await cloud.createEnvironment(admin.principal, projectA.project_id, {
        name: "Production", slug: "production", kind: "production",
        region: "us-east-1", program_id: "brand-a-rewards"
      });
      const environmentB = await cloud.createEnvironment(admin.principal, projectB.project_id, {
        name: "Production", slug: "production", kind: "production",
        region: "us-east-1", program_id: "brand-b-rewards"
      });
      const scoped = await operators.createOperator(admin.principal, {
        subject: "brand-a-operator",
        role: "org-scoped",
        organization_ids: [orgA.organization.organization_id]
      });
      const headers = {
        authorization: `Bearer ${scoped.secret}`,
        "content-type": "application/json"
      };

      // Sees only its own organization.
      const organizations = await fetch(`${running.url}/cloud/v1/organizations`, { headers });
      expect((await organizations.json() as {
        data: Array<{ organization_id: string }>;
      }).data.map((value) => value.organization_id))
        .toEqual([orgA.organization.organization_id]);

      // Own org: dashboard + credentials rotate work.
      expect((await fetch(
        `${running.url}/cloud/v1/organizations/${orgA.organization.organization_id}`,
        { headers }
      )).status).toBe(200);
      expect((await fetch(
        `${running.url}/cloud/v1/environments/${environmentA.environment_id}/credentials/rotate`,
        { method: "POST", headers }
      )).status).toBe(200);
      expect(rotateSubjects).toEqual(["brand-a-operator"]);

      // Foreign org: invisible.
      expect((await fetch(
        `${running.url}/cloud/v1/organizations/${orgB.organization.organization_id}`,
        { headers }
      )).status).toBe(404);
      expect((await fetch(
        `${running.url}/cloud/v1/environments/${environmentB.environment_id}/credentials/rotate`,
        { method: "POST", headers }
      )).status).toBe(404);

      // Operator management stays platform-admin only.
      expect((await fetch(`${running.url}/cloud/v1/operators`, { headers })).status).toBe(403);

      // Platform admin remains unrestricted.
      const adminHeaders = {
        authorization: `Bearer ${admin.secret}`,
        "content-type": "application/json"
      };
      expect((await fetch(
        `${running.url}/cloud/v1/organizations/${orgB.organization.organization_id}`,
        { headers: adminHeaders }
      )).status).toBe(200);
      expect((await fetch(
        `${running.url}/cloud/v1/environments/${environmentB.environment_id}/credentials/rotate`,
        { method: "POST", headers: adminHeaders }
      )).status).toBe(200);
    } finally {
      await running.close();
      await cloud.close();
    }
  });

  it("manages operator keys over HTTP (platform-admin only)", async () => {
    const { operators, running, cloud } = await httpFixture();
    try {
      const admin = await bootstrapAdmin(operators);
      const adminHeaders = {
        authorization: `Bearer ${admin.secret}`,
        "content-type": "application/json"
      };
      const minted = await fetch(
        `${running.url}/cloud/v1/operators/${admin.operator.operator_id}/keys`,
        {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ name: "ci-runner" })
        }
      );
      expect(minted.status).toBe(201);
      const mintedKey = (await minted.json() as {
        data: { secret: string; api_key: { key_id: string } };
      }).data;
      expect(mintedKey.secret).toMatch(/^lip_ok_/);

      const rotated = await fetch(
        `${running.url}/cloud/v1/operators/${admin.operator.operator_id}/keys/rotate`,
        {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ key_id: mintedKey.api_key.key_id, overlap_seconds: 0 })
        }
      );
      expect(rotated.status).toBe(200);
      const rotatedKey = (await rotated.json() as {
        data: { secret: string; api_key: { key_id: string } };
      }).data;
      expect(await operators.authenticate(mintedKey.secret)).toBeUndefined();
      expect(await operators.authenticate(rotatedKey.secret)).toBeDefined();

      const revoked = await fetch(
        `${running.url}/cloud/v1/operators/${admin.operator.operator_id}/keys/revoke`,
        {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ key_id: rotatedKey.api_key.key_id })
        }
      );
      expect(revoked.status).toBe(200);
      expect(await operators.authenticate(rotatedKey.secret)).toBeUndefined();

      const deactivated = await fetch(
        `${running.url}/cloud/v1/operators/${admin.operator.operator_id}`,
        {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ active: false })
        }
      );
      expect(deactivated.status).toBe(409);
    } finally {
      await running.close();
      await cloud.close();
    }
  });

  it("retires the shared key to bootstrap-only: no general data-plane access", async () => {
    const { operators, running, cloud } = await httpFixture();
    try {
      const legacyHeaders = {
        authorization: `Bearer ${sharedKey}`,
        "content-type": "application/json",
        "x-lip-cloud-subject": "legacy-operator"
      };
      // With zero operators the shared key still cannot reach a data route —
      // it is not a general trusted-gateway credential.
      const beforeBootstrap = await fetch(`${running.url}/cloud/v1/plans`, {
        headers: legacyHeaders
      });
      expect(beforeBootstrap.status).toBe(401);
      expect((await beforeBootstrap.json() as { code: string }).code)
        .toBe("shared_key_retired");

      // Bootstrap the first operator with the shared key (its one job).
      await bootstrapAdmin(operators, "shared-retire-admin");

      // Once an operator exists the shared key is fully retired everywhere,
      // including the operators route.
      const afterData = await fetch(`${running.url}/cloud/v1/plans`, {
        headers: legacyHeaders
      });
      expect(afterData.status).toBe(401);
      expect((await afterData.json() as { code: string }).code).toBe("shared_key_retired");
      const afterOperators = await fetch(`${running.url}/cloud/v1/operators`, {
        method: "POST",
        headers: legacyHeaders,
        body: JSON.stringify({ subject: "second-admin", role: "platform-admin" })
      });
      expect(afterOperators.status).toBe(401);
      expect((await afterOperators.json() as { code: string }).code)
        .toBe("shared_key_retired");
    } finally {
      await running.close();
      await cloud.close();
    }
  });

  it("rejects the shared key outright when LIP_CLOUD_SHARED_KEY_DISABLED is on", async () => {
    const { operators, running, cloud } = await httpFixture({ sharedKeyDisabled: true });
    try {
      const admin = await bootstrapAdmin(operators);
      const legacy = await fetch(`${running.url}/cloud/v1/plans`, {
        headers: {
          authorization: `Bearer ${sharedKey}`,
          "x-lip-cloud-subject": "legacy-operator"
        }
      });
      expect(legacy.status).toBe(401);
      expect((await legacy.json() as { code: string }).code).toBe("shared_key_disabled");
      // Operator keys keep working.
      expect((await fetch(`${running.url}/cloud/v1/plans`, {
        headers: { authorization: `Bearer ${admin.secret}` }
      })).status).toBe(200);
    } finally {
      await running.close();
      await cloud.close();
    }
  });

  it("maps verified OIDC subjects onto operator records for operator powers", async () => {
    const issuer = "https://identity.example.com";
    const audience = "lip-cloud";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "operator-test-key";
    const authenticator = new OidcAuthenticator({
      issuer,
      audience,
      key: createLocalJWKSet({ keys: [jwk] })
    });
    const { operators, cloud } = fixture();
    await operators.createOperator(gateway, {
      subject: "oidc-operator-001",
      role: "platform-admin"
    });
    const running = await startCloudServer(cloud, {
      authenticator,
      operators,
      port: 0
    });
    const token = (subject: string) => new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "operator-test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    try {
      // Verified sub with an active operator record → operator powers.
      const asOperator = await fetch(`${running.url}/cloud/v1/operators`, {
        headers: { authorization: `Bearer ${await token("oidc-operator-001")}` }
      });
      expect(asOperator.status).toBe(200);
      // Verified sub without an operator record → member surface only.
      const asMember = await fetch(`${running.url}/cloud/v1/operators`, {
        headers: { authorization: `Bearer ${await token("plain-member-001")}` }
      });
      expect(asMember.status).toBe(403);
      expect((await fetch(`${running.url}/cloud/v1/plans`, {
        headers: { authorization: `Bearer ${await token("plain-member-001")}` }
      })).status).toBe(200);
    } finally {
      await running.close();
      await cloud.close();
    }
  });
});

const postgresUrl = process.env["LIP_TEST_POSTGRES_URL"];
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("Operator Postgres integration", () => {
  it("persists operators and hashed keys through the full lifecycle", async () => {
    const repository = new PostgresCloudRepository({ connectionString: postgresUrl! });
    const operators = new CloudOperatorService({ repository });
    const suffix = randomUUID().slice(0, 8);
    // Direct-principal authorization: middleware-constructed platform-admin.
    const actor: CloudPrincipal = {
      issuer: OPERATOR_ISSUER,
      subject: `pg-admin-${suffix}`,
      operator: { operator_id: `op_pg_${suffix}`, role: "platform-admin" }
    };
    try {
      await repository.migrate();
      const created = await operators.createOperator(actor, {
        subject: `pg-operator-${suffix}`,
        email: "pg-ops@example.com",
        role: "platform-admin"
      });
      expect(created.secret).toMatch(/^lip_ok_/);
      const principal = await operators.authenticate(created.secret);
      expect(principal).toMatchObject({
        issuer: OPERATOR_ISSUER,
        subject: `pg-operator-${suffix}`,
        operator: { role: "platform-admin" }
      });
      const [stored] = await repository.operatorApiKeys(created.operator.operator_id);
      expect(stored?.secret_hash).toMatch(/^[0-9a-f]{64}$/);

      const scoped = await operators.createOperator(actor, {
        subject: `pg-scoped-${suffix}`,
        role: "org-scoped",
        organization_ids: [`org_pg_${suffix}`]
      });
      const scopedPrincipal = await operators.authenticate(scoped.secret);
      expect(scopedPrincipal?.operator).toMatchObject({
        role: "org-scoped",
        organization_ids: [`org_pg_${suffix}`]
      });

      const rotated = await operators.rotateOperatorKey(
        actor,
        created.operator.operator_id,
        { key_id: created.api_key.key_id, overlap_seconds: 0 }
      );
      expect(await operators.authenticate(created.secret)).toBeUndefined();
      expect(await operators.authenticate(rotated.secret)).toBeDefined();

      await operators.revokeOperatorKey(actor, created.operator.operator_id, {
        key_id: rotated.api_key.key_id
      });
      expect(await operators.authenticate(rotated.secret)).toBeUndefined();

      const audit = await repository.operatorAuditEntries();
      expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining([
        "cloud.operator.created",
        "cloud.operator.api_key.rotated",
        "cloud.operator.api_key.revoked"
      ]));
    } finally {
      await repository.close();
    }
  });
});
