import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalDataPlaneProvisioner,
  readLocalCredential,
  type ProvisionedRuntime
} from "./data-plane-provisioner.js";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudOperatorService } from "./operator-service.js";
import { CloudProvisioningWorker } from "./provisioning.js";
import { startCloudServer } from "./server.js";
import { CloudControlPlane } from "./service.js";
import { provisionTenant } from "./tenant-onboarding.js";
import { TRUSTED_GATEWAY_ISSUER } from "./types.js";

const owner = {
  issuer: "https://identity.example.com",
  subject: "user_clerk_001",
  email: "owner@example.com"
};
const credentialEncryptionKey = Buffer.alloc(32, 7);

function requestContext() {
  return {
    protocol_version: "1.0",
    profile: "foodservice/1.0",
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    idempotency_key: `key-${Math.random().toString(36).slice(2)}`,
    occurred_at: new Date().toISOString(),
    source: { system: "cloud-provisioner-test" }
  };
}

const program = {
  program_id: "acme-rewards",
  name: "Acme Rewards",
  currency: "USD",
  accounts: [{ unit: "points", unit_label: "points", is_primary: true }],
  earn_rate: { points: 1, spend_minor_units: 100 },
  evaluation_ttl_seconds: 300,
  reservation_ttl_seconds: 300,
  rewards: [
    {
      reward_id: "five-off",
      name: "$5 off your order",
      points_cost: 50,
      effect: {
        type: "discount",
        target: "order",
        amount: { amount: 500, currency: "USD" },
        allocations: [{ amount: { amount: 500, currency: "USD" } }]
      },
      funding: [{ party_id: "acme-brand", party_type: "brand", share_bps: 10_000 }]
    }
  ]
};

function makeJob(environmentId: string) {
  return {
    provisioning_job_id: `job-${Math.random().toString(36).slice(2)}`,
    environment_id: environmentId,
    operation: "create" as const,
    status: "running" as const,
    attempts: 1,
    available_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

async function fixture(input: { programId?: string } = {}) {
  const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
  const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
  writeFileSync(
    join(programDirectory, "acme-rewards.json"),
    JSON.stringify(program)
  );
  const provisioned: ProvisionedRuntime[] = [];
  const provisioner = new LocalDataPlaneProvisioner({
    programDirectory,
    dataDirectory,
    credentialEncryptionKey,
    onProvisioned: (runtime) => provisioned.push(runtime)
  });
  const repository = new MemoryCloudRepository();
  const cloud = new CloudControlPlane({ repository });
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
    name: "Staging",
    slug: "staging",
    kind: "staging",
    region: "us-east-1",
    program_id: input.programId ?? "acme-rewards"
  });
  const worker = new CloudProvisioningWorker({
    repository,
    provisioner,
    workerId: "worker-data-plane-test",
    onError: () => {}
  });
  return {
    provisioner,
    provisioned,
    repository,
    cloud,
    environment,
    worker,
    programDirectory,
    dataDirectory
  };
}

describe("LocalDataPlaneProvisioner", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("provisions a reachable, authenticated LIP runtime for a pending environment", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    close = () => provisioner.close();

    expect(environment.status).toBe("pending");
    expect(await worker.runOnce()).toBe("succeeded");

    const ready = await repository.environmentById(environment.environment_id);
    expect(ready).toMatchObject({ status: "ready" });
    expect(ready?.api_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    expect(provisioned).toHaveLength(1);
    const runtime = provisioned[0]!;
    expect(runtime.api_key).toMatch(/^lip_sk_/);

    const health = await fetch(`${ready!.api_url}/health`);
    expect(health.status).toBe(200);

    const authorized = await fetch(`${ready!.api_url}/lip/v1/programs/get`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.api_key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ context: requestContext(), program_id: "acme-rewards" })
    });
    expect(authorized.status).toBe(200);
    const body = await authorized.json() as { program: { program_id: string } };
    expect(body.program.program_id).toBe("acme-rewards");

    const unauthorized = await fetch(`${ready!.api_url}/lip/v1/programs/get`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({ context: requestContext(), program_id: "acme-rewards" })
    });
    expect(unauthorized.status).toBe(401);

    // The advertised admin_url is backed by the full Admin service suite.
    const adminLocations = await fetch(`${ready!.api_url}/admin/api/v1/locations`, {
      headers: { authorization: `Bearer ${runtime.api_key}` }
    });
    expect(adminLocations.status).toBe(200);
    expect(await adminLocations.json()).toEqual({ locations: [] });
    const adminSnapshot = await fetch(`${ready!.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${runtime.api_key}` }
    });
    expect(adminSnapshot.status).toBe(200);
    expect(await adminSnapshot.json()).toMatchObject({
      program_management: expect.objectContaining({ active_program: expect.anything() }),
      access_control: expect.objectContaining({ tenant: expect.anything() })
    });

    // The credential is delivered as an operator-readable 0600 file.
    expect(statSync(runtime.credentials_path).mode & 0o777).toBe(0o600);

    // A retried job for an already-running environment reuses the runtime.
    expect(await provisioner.provision({
      environment: ready!,
      job: {
        provisioning_job_id: "job-retry",
        environment_id: environment.environment_id,
        operation: "create",
        status: "running",
        attempts: 2,
        available_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    })).toEqual({ api_url: runtime.api_url, admin_url: runtime.admin_url });
    expect(provisioner.runtimes()).toHaveLength(1);
  });

  it("fails provisioning when the program definition is missing", async () => {
    const { provisioner, repository, environment, worker } = await fixture({
      programId: "unknown-program"
    });
    close = () => provisioner.close();

    expect(await worker.runOnce()).toBe("retrying");
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({
      status: "pending",
      status_message: expect.stringContaining("unknown-program")
    });
    expect(provisioner.runtimes()).toHaveLength(0);
  });

  it("stops provisioned runtimes on close", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);

    await provisioner.close();
    expect(provisioner.runtimes()).toHaveLength(0);
    await expect(fetch(`${ready!.api_url}/health`)).rejects.toThrow();
    expect(provisioned).toHaveLength(1);
  });

  it("suspends, resumes, backs up, and restores a local environment", async () => {
    const {
      provisioner,
      provisioned,
      repository,
      environment,
      worker,
      programDirectory,
      dataDirectory
    } = await fixture();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);
    const original = provisioned[0]!;

    await provisioner.suspend(environment.environment_id);
    expect(provisioner.runtimes()).toHaveLength(0);
    await expect(fetch(`${ready!.api_url}/health`)).rejects.toThrow();
    const resumed = await provisioner.resume(environment.environment_id);
    expect(resumed.api_url).toBe(original.api_url);
    expect(await fetch(`${resumed.api_url}/health`).then((response) => response.status)).toBe(200);

    const backupPath = join(dataDirectory, "environment.backup.json");
    const backup = await provisioner.backup(environment.environment_id, backupPath, {
      now: () => new Date("2026-08-15T20:00:00.000Z")
    });
    expect(backup).toMatchObject({
      format: "lip-cloud-local-backup",
      environment_id: environment.environment_id,
      tenant_id: original.tenant_id,
      sqlite_database: {
        algorithm: "aes-256-gcm",
        key_id: expect.any(String),
        ciphertext: expect.any(String)
      }
    });
    expect(backup).not.toHaveProperty("sqlite_database_base64");
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(provisioner.runtimes()).toHaveLength(1);

    const tamperedBackupPath = join(dataDirectory, "environment.tampered.backup.json");
    const tamperedBackup = JSON.parse(readFileSync(backupPath, "utf8")) as {
      sqlite_database: { ciphertext: string };
      checksum: { value: string };
      [key: string]: unknown;
    };
    tamperedBackup.sqlite_database.ciphertext =
      `${tamperedBackup.sqlite_database.ciphertext.startsWith("A") ? "B" : "A"}` +
      tamperedBackup.sqlite_database.ciphertext.slice(1);
    const { checksum: _checksum, ...tamperedWithoutChecksum } = tamperedBackup;
    tamperedBackup.checksum.value = createHash("sha256")
      .update(JSON.stringify(tamperedWithoutChecksum))
      .digest("hex");
    writeFileSync(tamperedBackupPath, JSON.stringify(tamperedBackup));
    const tamperedProvisioner = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory: mkdtempSync(join(tmpdir(), "lip-cloud-tampered-restore-")),
      credentialEncryptionKey
    });
    await expect(tamperedProvisioner.restoreBackup(tamperedBackupPath)).rejects.toThrow(
      /Backup database authentication failed/
    );
    await tamperedProvisioner.close();

    await provisioner.close();
    rmSync(original.credentials_path);
    rmSync(join(dataDirectory, `${original.tenant_id}.db`));
    const restoredProvisioner = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey
    });
    close = () => restoredProvisioner.close();
    const restored = await restoredProvisioner.restoreBackup(backupPath);
    expect(restored).toMatchObject({
      environment_id: original.environment_id,
      tenant_id: original.tenant_id,
      api_url: original.api_url
    });
    expect(await fetch(`${restored.api_url}/health`).then((response) => response.status)).toBe(200);
  });

  it("rejects tampered encrypted credentials and plaintext unless migration is explicit", async () => {
    const { provisioner, provisioned, repository, environment, worker, programDirectory,
      dataDirectory } = await fixture();
    expect(await worker.runOnce()).toBe("succeeded");
    await repository.environmentById(environment.environment_id);
    const runtime = provisioned[0]!;
    await provisioner.close();

    const envelope = JSON.parse(readFileSync(runtime.credentials_path, "utf8")) as {
      ciphertext: string;
    };
    envelope.ciphertext = `${envelope.ciphertext.startsWith("A") ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
    writeFileSync(runtime.credentials_path, JSON.stringify(envelope));
    const tampered = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey
    });
    close = () => tampered.close();
    expect(await tampered.restore()).toEqual([]);

    writeFileSync(runtime.credentials_path, JSON.stringify({
      environment_id: runtime.environment_id,
      tenant_id: runtime.tenant_id,
      program_id: runtime.program_id,
      api_url: runtime.api_url,
      api_key: runtime.api_key,
      port: runtime.port
    }));
    expect(await tampered.restore()).toEqual([]);
  });

  it("bootstraps a rotatable merchant key alongside the deprecated root key", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    close = () => provisioner.close();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);
    const runtime = provisioned[0]!;

    // The merchant credential is an owner-role access-control key, not the root key.
    expect(runtime.merchant_api_key).toMatch(/^lip_sk_/);
    expect(runtime.merchant_api_key).not.toBe(runtime.api_key);
    expect(runtime.merchant_api_key_id).toMatch(/^key_/);

    const encrypted = readFileSync(runtime.credentials_path, "utf8");
    expect(encrypted).not.toContain(runtime.api_key);
    expect(encrypted).not.toContain(runtime.merchant_api_key);
    expect(JSON.parse(encrypted)).toMatchObject({ version: 3, algorithm: "aes-256-gcm" });
    const credential = await readLocalCredential(
      runtime.credentials_path,
      credentialEncryptionKey
    ) as {
      version: number;
      api_key: string;
      api_key_deprecated: boolean;
      merchant_api_key: string;
      merchant_api_key_id: string;
    };
    expect(credential).toMatchObject({
      version: 2,
      api_key: runtime.api_key,
      api_key_deprecated: true,
      merchant_api_key: runtime.merchant_api_key,
      merchant_api_key_id: runtime.merchant_api_key_id
    });

    // The merchant key works on both surfaces of its own runtime.
    const protocol = await fetch(`${ready!.api_url}/lip/v1/programs/get`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.merchant_api_key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ context: requestContext(), program_id: "acme-rewards" })
    });
    expect(protocol.status).toBe(200);
    const admin = await fetch(`${ready!.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${runtime.merchant_api_key}` }
    });
    expect(admin.status).toBe(200);
  });

  it("rotates merchant credentials in place with an overlap window", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    close = () => provisioner.close();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);
    const before = provisioned[0]!;

    const rotated = await provisioner.rotateCredentials(environment.environment_id);
    expect(rotated.merchant_api_key).toMatch(/^lip_sk_/);
    expect(rotated.merchant_api_key).not.toBe(before.merchant_api_key);
    expect(rotated.merchant_api_key_id).not.toBe(before.merchant_api_key_id);

    // File and in-memory runtime reflect the new credential.
    const credential = await readLocalCredential(before.credentials_path, credentialEncryptionKey) as {
      merchant_api_key: string;
    };
    expect(credential.merchant_api_key).toBe(rotated.merchant_api_key);
    expect(provisioner.runtimes()[0]!.merchant_api_key).toBe(rotated.merchant_api_key);

    // Old and new merchant keys are both valid during the default overlap.
    for (const secret of [before.merchant_api_key, rotated.merchant_api_key]) {
      const probe = await fetch(`${ready!.api_url}/admin/api/v1/snapshot`, {
        headers: { authorization: `Bearer ${secret}` }
      });
      expect(probe.status).toBe(200);
    }

    await expect(provisioner.rotateCredentials("env_unknown"))
      .rejects.toThrowError(/env_unknown/);
  });

  it("recovers control-plane rotation after tenant self-rotation and serializes concurrent rotations", async () => {
    const { provisioner, provisioned, repository, environment, worker } = await fixture();
    close = () => provisioner.close();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);
    const before = provisioned[0]!;

    // The tenant self-rotates its merchant key (a documented surface) with an
    // immediate cutover, so the control plane's pinned key id goes dead.
    const self = await fetch(`${ready!.api_url}/admin/api/v1/access/api-keys/rotate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${before.merchant_api_key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ key_id: before.merchant_api_key_id, overlap_seconds: 0 })
    });
    expect(self.status).toBe(200);

    // Control-plane rotation re-adopts the live lineage instead of failing
    // forever on the stale pinned key id.
    const rotated = await provisioner.rotateCredentials(environment.environment_id);
    expect(rotated.merchant_api_key).toMatch(/^lip_sk_/);
    expect(await fetch(`${ready!.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${rotated.merchant_api_key}` }
    }).then((r) => r.status)).toBe(200);
    const file = await readLocalCredential(before.credentials_path, credentialEncryptionKey) as {
      merchant_api_key: string;
    };
    expect(file.merchant_api_key).toBe(rotated.merchant_api_key);

    // Concurrent rotations serialize: the runtime, file, and access state
    // converge on one live lineage instead of minting orphaned keys.
    const [first, second] = await Promise.all([
      provisioner.rotateCredentials(environment.environment_id),
      provisioner.rotateCredentials(environment.environment_id)
    ]);
    const current = provisioner.runtimes()[0]!;
    expect([first.merchant_api_key, second.merchant_api_key])
      .toContain(current.merchant_api_key);
    const fileAfter = await readLocalCredential(before.credentials_path, credentialEncryptionKey) as {
      merchant_api_key: string;
    };
    expect(fileAfter.merchant_api_key).toBe(current.merchant_api_key);
    const snapshot = await fetch(`${ready!.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${current.merchant_api_key}` }
    });
    expect(snapshot.status).toBe(200);
    const body = await snapshot.json() as {
      access_control: { api_keys: Array<{ name: string; active: boolean; expires_at?: string }> };
    };
    const immortal = body.access_control.api_keys.filter((key) =>
      key.name === "cloud-merchant" && key.active && !key.expires_at
    );
    expect(immortal).toHaveLength(1);
  });

  it("re-adopts the persisted merchant lineage instead of minting a second key after a lost credentials file", async () => {
    const {
      provisioner, provisioned, repository, environment, worker, programDirectory, dataDirectory
    } = await fixture();
    expect(await worker.runOnce()).toBe("succeeded");
    const before = provisioned[0]!;
    const ready = await repository.environmentById(environment.environment_id);
    await provisioner.close();
    rmSync(before.credentials_path);

    const second = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey
    });
    close = () => second.close();
    await second.provision({ environment: ready!, job: makeJob(environment.environment_id) });
    const runtime = second.runtimes()[0]!;
    expect(runtime.merchant_api_key_id).not.toBe(before.merchant_api_key_id);

    const snapshot = await fetch(`${runtime.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${runtime.merchant_api_key}` }
    });
    expect(snapshot.status).toBe(200);
    const body = await snapshot.json() as {
      access_control: {
        api_keys: Array<{ key_id: string; name: string; active: boolean; expires_at?: string }>;
      };
    };
    const merchantKeys = body.access_control.api_keys.filter((key) =>
      key.name === "cloud-merchant" && key.active
    );
    // One live lineage: the previous key was rotated (bounded overlap), not
    // left immortal next to a second freshly minted owner key.
    expect(merchantKeys.filter((key) => !key.expires_at)).toHaveLength(1);
    expect(merchantKeys.find((key) => key.key_id === before.merchant_api_key_id)?.expires_at)
      .toEqual(expect.any(String));
  });

  it("mints no orphan merchant key when the runtime fails to start", async () => {
    const {
      provisioner, provisioned, repository, environment, worker, programDirectory, dataDirectory
    } = await fixture();
    expect(await worker.runOnce()).toBe("succeeded");
    const before = provisioned[0]!;
    const ready = await repository.environmentById(environment.environment_id);
    await provisioner.close();
    rmSync(before.credentials_path);

    // Occupy the environment's stable port so the runtime cannot bind.
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(before.port, "127.0.0.1", resolve);
    });
    const second = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey
    });
    close = () => second.close();
    try {
      await expect(
        second.provision({ environment: ready!, job: makeJob(environment.environment_id) })
      ).rejects.toThrow();
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }

    // The retry succeeds and the failed attempt minted nothing: exactly the
    // rotated-out key plus one live replacement remain.
    await second.provision({ environment: ready!, job: makeJob(environment.environment_id) });
    const runtime = second.runtimes()[0]!;
    const snapshot = await fetch(`${runtime.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${runtime.merchant_api_key}` }
    });
    const body = await snapshot.json() as {
      access_control: { api_keys: Array<{ name: string; active: boolean; expires_at?: string }> };
    };
    const merchantKeys = body.access_control.api_keys.filter((key) =>
      key.name === "cloud-merchant" && key.active
    );
    expect(merchantKeys).toHaveLength(2);
    expect(merchantKeys.filter((key) => !key.expires_at)).toHaveLength(1);
  });

  it("fails before minting when an existing credential path is unreadable", async () => {
    const {
      provisioner, provisioned, repository, environment, worker, programDirectory, dataDirectory
    } = await fixture();
    expect(await worker.runOnce()).toBe("succeeded");
    const before = provisioned[0]!;
    const ready = await repository.environmentById(environment.environment_id);
    await provisioner.close();
    // Block the credentials path so the post-mint write fails.
    rmSync(before.credentials_path);
    mkdirSync(before.credentials_path);

    const second = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey
    });
    close = () => second.close();
    await expect(
      second.provision({ environment: ready!, job: makeJob(environment.environment_id) })
    ).rejects.toThrow();

    rmSync(before.credentials_path, { recursive: true, force: true });
    await second.provision({ environment: ready!, job: makeJob(environment.environment_id) });
    const runtime = second.runtimes()[0]!;
    const snapshot = await fetch(`${runtime.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${runtime.merchant_api_key}` }
    });
    const body = await snapshot.json() as {
      access_control: {
        api_keys: Array<{ name: string; active: boolean; revoked_at?: string; expires_at?: string }>;
      };
    };
    const merchantKeys = body.access_control.api_keys.filter((key) =>
      key.name === "cloud-merchant"
    );
    // Fail-closed credential reads abort before minting. The successful retry
    // rotates the old standing key, so no failed-attempt key needs revocation.
    expect(merchantKeys.filter((key) => key.active)).toHaveLength(2);
    expect(merchantKeys.filter((key) => key.active && !key.expires_at)).toHaveLength(1);
    expect(merchantKeys.some((key) => !key.active && key.revoked_at)).toBe(false);
  });

  it("does not seed tenant runtimes from host-level webhook env vars", async () => {
    process.env["LIP_WEBHOOK_URL"] = "https://host-level.example/hooks";
    process.env["LIP_WEBHOOK_SECRET"] = "host-level-shared-secret";
    try {
      const { provisioner, provisioned, repository, environment, worker } = await fixture();
      close = () => provisioner.close();
      expect(await worker.runOnce()).toBe("succeeded");
      const ready = await repository.environmentById(environment.environment_id);
      const health = await fetch(`${ready!.api_url}/admin/api/v1/webhooks/health`, {
        headers: { authorization: `Bearer ${provisioned[0]!.merchant_api_key}` }
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        enabled: false,
        subscription_count: 0
      });
    } finally {
      delete process.env["LIP_WEBHOOK_URL"];
      delete process.env["LIP_WEBHOOK_SECRET"];
    }
  });

  it("skips a credentials file carrying a weak root key without bricking the other tenants", async () => {
    const { provisioner, repository, environment, worker, programDirectory, dataDirectory } =
      await fixture();
    expect(await worker.runOnce()).toBe("succeeded");
    const ready = await repository.environmentById(environment.environment_id);
    await provisioner.close();

    // One weak/tampered credentials file must not abort the whole restore loop.
    writeFileSync(join(dataDirectory, "env_weak.credentials.json"), JSON.stringify({
      environment_id: "env_weak",
      tenant_id: "tenant_weak",
      program_id: "acme-rewards",
      api_url: "http://127.0.0.1:19999",
      api_key: "lip-dev-key",
      port: 19_999
    }));
    const errors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    let restored;
    const second = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey,
      allowLegacyPlaintextCredentials: true
    });
    close = () => second.close();
    try {
      restored = await second.restore();
    } finally {
      console.error = consoleError;
    }
    expect(restored).toHaveLength(1);
    expect(restored[0]!.environment_id).toBe(environment.environment_id);
    expect(second.runtimes()).toHaveLength(1);
    expect(await fetch(`${ready!.api_url}/health`).then((r) => r.status)).toBe(200);
    // The failed environment is surfaced in the logs.
    expect(errors.flat().join(" ")).toContain("env_weak");
  });

  it("exposes credential rotation through the control-plane API", async () => {
    const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
    const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
    writeFileSync(join(programDirectory, "acme-rewards.json"), JSON.stringify(program));
    const provisioner = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey
    });
    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({ repository });
    // PLA-442: a platform-admin operator key replaces the shared key + subject
    // header. It carries a verified identity and virtual owner scope on every
    // organization, so no membership wiring is needed.
    const operators = new CloudOperatorService({ repository });
    const admin = await operators.createOperator(
      { issuer: TRUSTED_GATEWAY_ISSUER, subject: "bootstrap" },
      { subject: "rotate-operator-001", role: "platform-admin" }
    );
    const operator = operators.principalFor(admin.operator);
    const dashboard = await cloud.createOrganization(operator, {
      name: "Rotate Restaurants",
      slug: "rotate-restaurants"
    });
    const project = await cloud.createProject(
      operator,
      dashboard.organization.organization_id,
      { name: "Rotate Loyalty", slug: "rotate-loyalty" }
    );
    const environment = await cloud.createEnvironment(operator, project.project_id, {
      name: "Production",
      slug: "production",
      kind: "production",
      region: "us-east-1",
      program_id: "acme-rewards"
    });
    const worker = new CloudProvisioningWorker({
      repository,
      provisioner,
      workerId: "worker-rotate-endpoint",
      onError: () => {}
    });
    expect(await worker.runOnce()).toBe("succeeded");
    const runtimeBefore = provisioner.runtimes()[0]!;
    const running = await startCloudServer(cloud, {
      apiKey: "cloud-rotate-test-key",
      operators,
      port: 0,
      rotateEnvironmentCredentials: (environmentId, rotateOptions) =>
        provisioner.rotateCredentials(environmentId, rotateOptions)
    });
    const operatorHeaders = {
      authorization: `Bearer ${admin.secret}`,
      "content-type": "application/json"
    };
    close = async () => {
      await running.close();
      await provisioner.close();
    };

    const path = `/cloud/v1/environments/${environment.environment_id}/credentials/rotate`;
    const rotated = await fetch(`${running.url}${path}`, {
      method: "POST",
      headers: operatorHeaders
    });
    expect(rotated.status).toBe(200);
    const bodyText = await rotated.text();
    const body = JSON.parse(bodyText) as {
      data: {
        environment_id: string;
        tenant_id: string;
        merchant_api_key: string;
        merchant_api_key_id: string;
        api_url: string;
        replaced_api_key_expires_at?: string;
      };
    };
    expect(body.data).toMatchObject({
      environment_id: environment.environment_id,
      tenant_id: environment.tenant_id,
      api_url: runtimeBefore.api_url
    });
    expect(body.data.merchant_api_key).toMatch(/^lip_sk_/);
    expect(body.data.merchant_api_key).not.toBe(runtimeBefore.merchant_api_key);
    // Operators learn when the replaced key dies without querying the tenant.
    expect(Date.parse(body.data.replaced_api_key_expires_at!)).toBeGreaterThan(Date.now());
    // The deprecated root key must never leave the host through this API.
    expect(bodyText).not.toContain(runtimeBefore.api_key);

    // The returned credential is live on the tenant runtime.
    expect(await fetch(`${runtimeBefore.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${body.data.merchant_api_key}` }
    }).then((r) => r.status)).toBe(200);

    // Tenant-side audit attributes the rotation to the cloud operator, not root.
    const audited = await fetch(`${runtimeBefore.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${body.data.merchant_api_key}` }
    }).then((r) => r.json()) as {
      access_control: { audit: Array<{ action: string; actor_id: string }> };
    };
    expect(audited.access_control.audit.find((entry) =>
      entry.action === "access.api_key.rotated"
    )?.actor_id).toBe(`cloud:${operator.subject}`);

    // overlap_seconds threads through: 0 cuts the replaced key off immediately.
    const cutover = await fetch(`${running.url}${path}`, {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ overlap_seconds: 0 })
    });
    expect(cutover.status).toBe(200);
    const cutoverBody = await cutover.json() as {
      data: { merchant_api_key: string; replaced_api_key_expires_at?: string };
    };
    expect(Date.parse(cutoverBody.data.replaced_api_key_expires_at!))
      .toBeLessThanOrEqual(Date.now());
    expect(await fetch(`${runtimeBefore.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${body.data.merchant_api_key}` }
    }).then((r) => r.status)).toBe(401);
    expect(await fetch(`${runtimeBefore.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${cutoverBody.data.merchant_api_key}` }
    }).then((r) => r.status)).toBe(200);

    // Invalid overlap values are rejected at the cloud surface.
    for (const overlap of [-1, 999_999_999, "tomorrow"]) {
      expect((await fetch(`${running.url}${path}`, {
        method: "POST",
        headers: operatorHeaders,
        body: JSON.stringify({ overlap_seconds: overlap })
      })).status).toBe(422);
    }

    // Authorization failures.
    expect((await fetch(`${running.url}${path}`, { method: "POST" })).status).toBe(401);
    // PLA-442: a caller-chosen subject can no longer downgrade or widen a
    // principal, so out-of-scope access is exercised with a real org-scoped
    // operator whose scope excludes this environment's organization.
    const outsiderOperator = await operators.createOperator(operator, {
      subject: "outsider-001",
      role: "org-scoped",
      organization_ids: ["org_some_other_tenant"]
    });
    const outsider = await fetch(`${running.url}${path}`, {
      method: "POST",
      headers: {
        ...operatorHeaders,
        authorization: `Bearer ${outsiderOperator.secret}`
      }
    });
    expect([403, 404]).toContain(outsider.status);
    expect((await fetch(
      `${running.url}/cloud/v1/environments/env_unknown/credentials/rotate`,
      { method: "POST", headers: operatorHeaders }
    )).status).toBe(404);

    // Without a wired provisioner the control plane reports the surface unavailable.
    const detached = await startCloudServer(cloud, {
      apiKey: "cloud-rotate-test-key",
      operators,
      port: 0
    });
    try {
      expect((await fetch(
        `${detached.url}${path}`,
        { method: "POST", headers: operatorHeaders }
      )).status).toBe(409);
    } finally {
      await detached.close();
    }
  });

  it("creates the tenant's first webhook subscription at provision time", async () => {
    const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
    const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
    writeFileSync(join(programDirectory, "acme-rewards.json"), JSON.stringify(program));
    const provisioner = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey
    });
    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({ repository });
    const worker = new CloudProvisioningWorker({
      repository,
      provisioner,
      workerId: "worker-webhook-onboarding",
      onError: () => {}
    });
    const operators = new CloudOperatorService({ repository });
    const running = await startCloudServer(cloud, {
      apiKey: "cloud-webhook-test-key",
      operators,
      port: 0,
      rotateEnvironmentCredentials: (environmentId, options) =>
        provisioner.rotateCredentials(environmentId, options)
    });
    close = async () => {
      await running.close();
      await provisioner.close();
    };
    // PLA-442: onboarding authenticates with a platform-admin operator key.
    const admin = await operators.createOperator(
      { issuer: TRUSTED_GATEWAY_ISSUER, subject: "bootstrap" },
      { subject: "webhook-operator-001", role: "platform-admin" }
    );
    const target = {
      cloudUrl: running.url,
      apiKey: admin.secret
    };
    const request = {
      organization: { name: "Hook Restaurants", slug: "hook-restaurants" },
      project: { name: "Loyalty", slug: "loyalty" },
      environment: {
        name: "Production",
        slug: "production",
        kind: "production" as const,
        region: "us-east-1",
        programId: "acme-rewards"
      },
      webhook: {
        url: "https://hooks.example.com/loyalty",
        secret: "a-webhook-secret-16ch"
      },
      poll: { timeoutMs: 10_000, intervalMs: 20 }
    };
    const drive = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await worker.runOnce() === "succeeded") return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    const [result] = await Promise.all([provisionTenant(target, request), drive()]);
    expect(result.status).toBe("ready");
    // The onboarding run hands back the credential it minted for the wiring.
    expect(result.credentials?.merchant_api_key).toMatch(/^lip_sk_/);
    expect(result.webhook?.subscription_id).toMatch(/^webhook_/);

    const health = await fetch(`${result.api_url}/admin/api/v1/webhooks/health`, {
      headers: { authorization: `Bearer ${result.credentials!.merchant_api_key}` }
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ enabled: true, subscription_count: 1 });

    // Re-running is idempotent: the subscription is upserted, not duplicated.
    const again = await provisionTenant(target, request);
    expect(again.webhook?.subscription_id).toBe(result.webhook?.subscription_id);
    const healthAgain = await fetch(`${result.api_url}/admin/api/v1/webhooks/health`, {
      headers: { authorization: `Bearer ${again.credentials!.merchant_api_key}` }
    });
    expect(await healthAgain.json()).toMatchObject({ subscription_count: 1 });
  });

  it("restores the same port and API key after close", async () => {
    const programDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-programs-"));
    const dataDirectory = mkdtempSync(join(tmpdir(), "lip-cloud-data-"));
    writeFileSync(join(programDirectory, "acme-rewards.json"), JSON.stringify(program));
    const first = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey,
      basePort: 18_210
    });
    const repository = new MemoryCloudRepository();
    const cloud = new CloudControlPlane({ repository });
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
      name: "Staging",
      slug: "staging",
      kind: "staging",
      region: "us-east-1",
      program_id: "acme-rewards"
    });
    const worker = new CloudProvisioningWorker({
      repository,
      provisioner: first,
      workerId: "worker-restore",
      onError: () => {}
    });
    expect(await worker.runOnce()).toBe("succeeded");
    const original = first.runtimes()[0]!;
    await first.close();

    // Downgrade the credentials file to the v1 layout (root key only) to
    // prove restore keeps accepting legacy files and upgrades them in place.
    writeFileSync(original.credentials_path, JSON.stringify({
      environment_id: environment.environment_id,
      tenant_id: original.tenant_id,
      program_id: original.program_id,
      api_url: original.api_url,
      api_key: original.api_key,
      port: original.port
    }));

    const second = new LocalDataPlaneProvisioner({
      programDirectory,
      dataDirectory,
      credentialEncryptionKey,
      allowLegacyPlaintextCredentials: true,
      basePort: 18_210
    });
    close = () => second.close();
    const restored = await second.restore();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      environment_id: environment.environment_id,
      api_url: original.api_url,
      api_key: original.api_key,
      port: original.port
    });
    expect(await fetch(`${original.api_url}/health`).then((r) => r.status)).toBe(200);

    // The legacy file was upgraded to an authenticated v3 envelope containing
    // a freshly minted merchant key.
    expect(JSON.parse(readFileSync(original.credentials_path, "utf8")))
      .toMatchObject({ version: 3, algorithm: "aes-256-gcm" });
    const upgraded = await readLocalCredential(
      original.credentials_path,
      credentialEncryptionKey
    ) as {
      version: number;
      api_key: string;
      merchant_api_key: string;
    };
    expect(upgraded.version).toBe(2);
    expect(upgraded.api_key).toBe(original.api_key);
    expect(upgraded.merchant_api_key).toMatch(/^lip_sk_/);
    expect(await fetch(`${original.api_url}/admin/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${upgraded.merchant_api_key}` }
    }).then((r) => r.status)).toBe(200);
  });
});
