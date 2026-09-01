#!/usr/bin/env node

import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OidcAuthenticator } from "./auth.js";
import { StripeBillingProvider } from "./billing.js";
import type { Pool } from "pg";
import {
  PostgresMigrator,
  assertTenantIsolationEnforced,
  createPostgresPool
} from "@loyalty-interchange/storage-postgres";
import { LipClient } from "@loyalty-interchange/sdk";
import { PostgresCustomerRepository } from "./customer-postgres-repository.js";
import { OidcCustomerIdentityProvider } from "./customer-provider.js";
import { CustomerPlatform } from "./customer-service.js";
import {
  databaseIdentityFingerprint,
  managedDatabaseConfiguration
} from "./database-configuration.js";
import { LocalDataPlaneProvisioner } from "./data-plane-provisioner.js";
import { PostgresCredentialOperationStore } from "./credential-operation-store.js";
import { ManagedCredentialService } from "./credential-operations.js";
import { ManagedPostgresDataPlaneManager } from "./managed-data-plane.js";
import { RemoteEnvironmentAttacher } from "./remote-attach.js";
import {
  CloudOperatorService,
  assertOperatorManagementReachable
} from "./operator-service.js";
import { PostgresCloudRepository } from "./postgres-repository.js";
import { CloudProvisioningWorker } from "./provisioning.js";
import { CloudControlPlane } from "./service.js";
import { startCloudServer } from "./server.js";
import type { EnvironmentCredentialRotationOptions } from "./types.js";

const {
  controlPlaneUrl: connectionString,
  dataPlaneUrl: dataPlaneConnectionString
} = managedDatabaseConfiguration(process.env);
const apiKey = process.env["LIP_CLOUD_API_KEY"];
const sharedKeyDisabled = ["true", "1"].includes(
  (process.env["LIP_CLOUD_SHARED_KEY_DISABLED"] ?? "").toLowerCase()
);
const oidcIssuer = process.env["LIP_CLOUD_OIDC_ISSUER"];
const oidcAudience = process.env["LIP_CLOUD_OIDC_AUDIENCE"];
if (Boolean(oidcIssuer) !== Boolean(oidcAudience)) {
  throw new Error("LIP_CLOUD_OIDC_ISSUER and LIP_CLOUD_OIDC_AUDIENCE must be set together");
}
// OIDC subjects allowed to bootstrap the first operator.
const bootstrapSubjects = (
  process.env["LIP_CLOUD_BOOTSTRAP_SUBJECTS"] ??
  process.env["LIP_CLOUD_BOOTSTRAP_SUBJECT"] ??
  ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!oidcIssuer && !sharedKeyDisabled && (!apiKey || apiKey.length < 16)) {
  throw new Error(
    "LIP_CLOUD_API_KEY must contain at least 16 characters " +
    "(or set LIP_CLOUD_SHARED_KEY_DISABLED=true to run on operator keys only)"
  );
}
if (apiKey && !sharedKeyDisabled) {
  console.warn(JSON.stringify({
    event: "cloud_shared_key_deprecated",
    message:
      "LIP_CLOUD_API_KEY is deprecated: bootstrap the first " +
      "operator with `npm run cloud:operator -- create`, migrate every " +
      "caller to LIP_CLOUD_OPERATOR_KEY, then set " +
      "LIP_CLOUD_SHARED_KEY_DISABLED=true"
  }));
}
const authenticator = oidcIssuer && oidcAudience
  ? new OidcAuthenticator({
      issuer: oidcIssuer,
      audience: oidcAudience,
      ...(process.env["LIP_CLOUD_OIDC_JWKS_URI"]
        ? { jwksUri: process.env["LIP_CLOUD_OIDC_JWKS_URI"] }
        : {})
    })
  : undefined;
const regions = (process.env["LIP_CLOUD_REGIONS"] ?? "us-east-1")
  .split(",")
  .map((region) => region.trim())
  .filter(Boolean);
const repository = new PostgresCloudRepository({ connectionString });
const operators = new CloudOperatorService({ repository });
const stripeSecret = process.env["LIP_CLOUD_STRIPE_SECRET_KEY"];
const stripeWebhookSecret = process.env["LIP_CLOUD_STRIPE_WEBHOOK_SECRET"];
if (Boolean(stripeSecret) !== Boolean(stripeWebhookSecret)) {
  throw new Error(
    "LIP_CLOUD_STRIPE_SECRET_KEY and LIP_CLOUD_STRIPE_WEBHOOK_SECRET must be set together"
  );
}
const billing = stripeSecret && stripeWebhookSecret
  ? new StripeBillingProvider({
      secretKey: stripeSecret,
      webhookSecret: stripeWebhookSecret,
      priceIds: {
        ...(process.env["LIP_CLOUD_STRIPE_PRICE_PRO"]
          ? { pro: process.env["LIP_CLOUD_STRIPE_PRICE_PRO"] }
          : {}),
        ...(process.env["LIP_CLOUD_STRIPE_PRICE_BUSINESS"]
          ? { business: process.env["LIP_CLOUD_STRIPE_PRICE_BUSINESS"] }
          : {})
      }
    })
  : undefined;
const controlPlane = new CloudControlPlane({
  repository,
  regions,
  defaultPlanId: process.env["LIP_CLOUD_DEFAULT_PLAN"] ?? "free",
  ...(process.env["LIP_CLOUD_ALLOW_PRIVATE_ATTACH_NETWORKS"] === "true"
    ? { attacher: new RemoteEnvironmentAttacher({ allowPrivateNetworks: true }) }
    : {}),
  ...(billing ? { billing } : {})
});
await controlPlane.migrate();

// Fail fast: refuse to boot if the control plane has zero
// operators and no viable path to create the first one — otherwise operator
// management would be silently unreachable.
assertOperatorManagementReachable({
  operatorCount: await operators.countOperators(),
  sharedKeyBootstrap: Boolean(apiKey) && !sharedKeyDisabled,
  oidcBootstrap: Boolean(authenticator) && bootstrapSubjects.length > 0
});

const programDirectory = process.env["LIP_CLOUD_PROGRAM_DIR"];
const publicBaseUrl = process.env["LIP_CLOUD_PUBLIC_BASE_URL"];
const credentialEncryptionKey = process.env["LIP_CLOUD_CREDENTIAL_KEY"];

// The two provisioning modes are mutually exclusive, and the ambiguity is
// refused rather than resolved by precedence. A managed deployment that
// silently fell back to the file-backed provisioner would write tenant
// credentials to a container filesystem that does not survive a redeploy.
if (publicBaseUrl && programDirectory) {
  throw new Error(
    "Set LIP_CLOUD_PUBLIC_BASE_URL for the managed diskless runtime or " +
    "LIP_CLOUD_PROGRAM_DIR for the standalone file-backed provisioner, not both"
  );
}

let managed: ManagedPostgresDataPlaneManager | undefined;
let credentials: ManagedCredentialService | undefined;
let managedPool: Pool | undefined;
let restoredRuntimes = 0;
if (publicBaseUrl) {
  if (!credentialEncryptionKey) {
    throw new Error("LIP_CLOUD_CREDENTIAL_KEY is required for managed provisioning");
  }
  // Every tenant runtime in this process shares one pool against one database.
  // Per-tenant pools would exhaust Neon's connection budget long before the
  // process ran out of anything else.
  managedPool = createPostgresPool({ connectionString: dataPlaneConnectionString });
  await new PostgresMigrator(managedPool).migrate();
  // Prove isolation is in force before accepting a single tenant request.
  // Whether row-level security actually filters depends on a property of the
  // connecting role that no migration can guarantee, and the failure is silent:
  // every query succeeds and returns other tenants' rows. Refusing to boot is
  // the only safe response to a database that cannot demonstrate the boundary.
  const isolation = await assertTenantIsolationEnforced(managedPool);
  if (!isolation.enforced) {
    throw new Error(
      `Tenant isolation is not enforced on this database: ${isolation.detail ?? "unknown cause"}`
    );
  }
  console.log(JSON.stringify({
    event: "cloud_tenant_isolation_verified",
    current_role: isolation.current_role,
    runtime_role_available: isolation.runtime_role_available,
    owner_bypasses_row_level_security: isolation.owner_bypasses_row_level_security
  }));
  managed = new ManagedPostgresDataPlaneManager({
    connectionString: dataPlaneConnectionString,
    publicBaseUrl,
    pool: managedPool,
    environmentById: (environmentId) => repository.environmentById(environmentId),
    readyEnvironments: () => repository.readyEnvironments()
  });
  credentials = new ManagedCredentialService({
    store: new PostgresCredentialOperationStore({ connectionString }),
    issuer: managed,
    encryptionKey: credentialEncryptionKey
  });
  credentials.startHandoffRetentionSweep();
  const restored = await managed.restore();
  restoredRuntimes = restored.length;
  console.log(JSON.stringify({
    event: "cloud_runtimes_restored",
    restored: restoredRuntimes
  }));
}

let provisioner: LocalDataPlaneProvisioner | undefined;
let worker: CloudProvisioningWorker | undefined;
if (programDirectory) {
  if (!credentialEncryptionKey) {
    throw new Error(
      "LIP_CLOUD_CREDENTIAL_KEY is required when LIP_CLOUD_PROGRAM_DIR enables local provisioning"
    );
  }
  provisioner = new LocalDataPlaneProvisioner({
    programDirectory,
    dataDirectory: process.env["LIP_CLOUD_DATA_DIR"] ?? ".lip-cloud",
    credentialEncryptionKey,
    ...(process.env["LIP_CLOUD_ALLOW_LEGACY_CREDENTIAL_MIGRATION"] === "true"
      ? { allowLegacyPlaintextCredentials: true }
      : {}),
    connectionString: dataPlaneConnectionString,
    ...(process.env["LIP_CLOUD_DATA_PLANE_HOST"]
      ? { host: process.env["LIP_CLOUD_DATA_PLANE_HOST"] }
      : {}),
    ...(process.env["LIP_CLOUD_DATA_PLANE_PUBLIC_HOST"]
      ? { publicHost: process.env["LIP_CLOUD_DATA_PLANE_PUBLIC_HOST"] }
      : {}),
    ...(process.env["LIP_CLOUD_DATA_PLANE_BASE_PORT"]
      ? { basePort: Number.parseInt(process.env["LIP_CLOUD_DATA_PLANE_BASE_PORT"], 10) }
      : {}),
    onProvisioned: (runtime) => {
      console.log(JSON.stringify({
        event: "cloud_environment_provisioned",
        environment_id: runtime.environment_id,
        tenant_id: runtime.tenant_id,
        program_id: runtime.program_id,
        api_url: runtime.api_url,
        port: runtime.port,
        credentials_path: runtime.credentials_path
      }));
    }
  });
  const restored = await provisioner.restore();
  for (const runtime of restored) {
    console.log(JSON.stringify({
      event: "cloud_environment_restored",
      environment_id: runtime.environment_id,
      api_url: runtime.api_url,
      port: runtime.port
    }));
  }
  worker = new CloudProvisioningWorker({
    repository,
    provisioner,
    workerId: `local-${hostname()}-${process.pid}`
  });
  worker.start();
}

if (managed) {
  worker = new CloudProvisioningWorker({
    repository,
    provisioner: managed,
    workerId: `managed-${hostname()}-${process.pid}`
  });
  worker.start();
}

const customerIssuer = process.env["LIP_CLOUD_CUSTOMER_OIDC_ISSUER"];
const customerTenantId = process.env["LIP_CLOUD_CUSTOMER_TENANT_ID"];
const customerProviderId = process.env["LIP_CLOUD_CUSTOMER_PROVIDER_ID"];
const customerConfigured = Boolean(customerIssuer || customerTenantId || customerProviderId);
if (customerConfigured && (!customerIssuer || !customerTenantId || !customerProviderId)) {
  throw new Error(
    "LIP_CLOUD_CUSTOMER_OIDC_ISSUER, LIP_CLOUD_CUSTOMER_TENANT_ID, and " +
    "LIP_CLOUD_CUSTOMER_PROVIDER_ID must be set together"
  );
}
if (
  customerConfigured &&
  !process.env["LIP_CLOUD_CUSTOMER_OIDC_AUDIENCE"] &&
  !process.env["LIP_CLOUD_CUSTOMER_AUTHORIZED_PARTIES"]
) {
  throw new Error(
    "Managed customer OIDC requires LIP_CLOUD_CUSTOMER_OIDC_AUDIENCE or " +
    "LIP_CLOUD_CUSTOMER_AUTHORIZED_PARTIES"
  );
}
if (customerConfigured && !provisioner && !managed) {
  throw new Error("Managed customer routes require a configured loyalty runtime");
}
const customerLoyalty = managed
  ? {
      enroll: (input: {
        tenant_id: string;
        program_id: string;
        customer_id: string;
        idempotency_key: string;
      }) => managed!.enrollCustomer({
        tenantId: input.tenant_id,
        programId: input.program_id,
        customerId: input.customer_id,
        idempotencyKey: input.idempotency_key
      })
    }
  : provisioner
    ? {
        enroll: async (input: {
          tenant_id: string;
          program_id: string;
          customer_id: string;
          idempotency_key: string;
        }) => {
          const runtime = provisioner!.runtimes().find((candidate) =>
            candidate.tenant_id === input.tenant_id &&
            candidate.program_id === input.program_id
          );
          if (!runtime) throw new Error("Customer loyalty runtime is unavailable");
          const client = new LipClient({
            baseUrl: runtime.api_url,
            apiKey: runtime.merchant_api_key,
            source: { system: "lip-cloud-customer-gateway", instance: "server" }
          });
          const enrolled = await client.members.enroll({
            program_id: input.program_id,
            identity: { type: "external", value: input.customer_id },
            member_id: input.customer_id
          }, { idempotencyKey: input.idempotency_key });
          return { member_id: enrolled.member.member_id };
        }
      }
    : undefined;
let customers: CustomerPlatform | undefined;
if (customerIssuer && customerTenantId && customerProviderId && customerLoyalty) {
  customers = new CustomerPlatform({
    repository: new PostgresCustomerRepository({ connectionString }),
    providers: [new OidcCustomerIdentityProvider({
      providerId: customerProviderId,
      tenantId: customerTenantId,
      issuer: customerIssuer,
      ...(process.env["LIP_CLOUD_CUSTOMER_OIDC_AUDIENCE"]
        ? { audience: process.env["LIP_CLOUD_CUSTOMER_OIDC_AUDIENCE"] }
        : {}),
      ...(process.env["LIP_CLOUD_CUSTOMER_AUTHORIZED_PARTIES"]
        ? {
            authorizedParties: process.env["LIP_CLOUD_CUSTOMER_AUTHORIZED_PARTIES"]
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          }
        : {})
    })],
    loyalty: customerLoyalty
  });
  await customers.migrate();
}

const running = await startCloudServer(controlPlane, {
  ...(authenticator
    ? { authenticator }
    : apiKey ? { apiKey } : {}),
  operators,
  databaseFingerprints: {
    controlPlane: databaseIdentityFingerprint(connectionString),
    dataPlane: databaseIdentityFingerprint(dataPlaneConnectionString)
  },
  healthCheck: () => repository.healthCheck(),
  storagePolicy: {
    instance_policy: "single",
    storage_policy: managed ? "postgres_only" : "filesystem",
    shared_database: managed
      ? databaseIdentityFingerprint(connectionString) ===
        databaseIdentityFingerprint(dataPlaneConnectionString)
      : false,
    disk_required: !managed
  },
  ...(managed
    ? {
        runtimeRequestHandler: (request, response) =>
          managed!.handleRuntimeRequest(request, response),
        readiness: async () => {
          // Readiness is four separate claims, reported separately, because an
          // operator diagnosing a stuck deploy needs to know which one failed.
          let databaseReachable = true;
          let detail: string | undefined;
          try {
            await repository.healthCheck();
          } catch (error) {
            databaseReachable = false;
            detail = error instanceof Error ? error.message : String(error);
          }
          const expected = databaseReachable
            ? (await repository.readyEnvironments()).length
            : restoredRuntimes;
          const running = managed!.runtimeDescriptors().length;
          return {
            ready: databaseReachable && Boolean(worker) && running >= expected,
            migrations_applied: true,
            database_reachable: databaseReachable,
            provisioning_worker_running: Boolean(worker),
            expected_runtimes: expected,
            restored_runtimes: running,
            ...(detail ? { detail } : {})
          };
        }
      }
    : {}),
  ...(process.env["LIP_CLOUD_DEPLOYMENT_ENVIRONMENT"]
    ? {
        deployment: {
          environment: process.env["LIP_CLOUD_DEPLOYMENT_ENVIRONMENT"],
          release: process.env["RENDER_GIT_COMMIT"] ?? "unknown"
        }
      }
    : {}),
  ...(customers ? { customers } : {}),
  ...(sharedKeyDisabled ? { sharedKeyDisabled: true } : {}),
  ...(bootstrapSubjects.length > 0 ? { bootstrapSubjects } : {}),
  ...(credentials
    ? {
        rotateEnvironmentCredentials: async (
          environmentId: string,
          rotateOptions: EnvironmentCredentialRotationOptions
        ) => credentials!.issue({
          environmentId,
          idempotencyKey: rotateOptions.idempotency_key ?? "",
          operation: "rotate",
          subject: rotateOptions.subject,
          ...(rotateOptions.overlap_seconds === undefined
            ? {}
            : { overlapSeconds: rotateOptions.overlap_seconds })
        })
      }
    : provisioner
      ? {
          rotateEnvironmentCredentials: (
            environmentId: string,
            rotateOptions: EnvironmentCredentialRotationOptions
          ) => provisioner!.rotateCredentials(environmentId, rotateOptions)
        }
      : {}),
  ...(managed
    ? {
        operateLocalEnvironment: async (environmentId, operation) => {
          // Suspension stops the runtime; every other lifecycle operation a
          // disk-backed deployment offered is now Neon's. Backup and restore
          // are branch/PITR operations against the database, not file copies
          // this process could honestly perform.
          if (operation === "suspend") {
            await managed!.suspend(environmentId);
            return {};
          }
          if (operation === "resume") {
            const runtime = await managed!.provision({
              environment: (await repository.environmentById(environmentId))!,
              job: {
                provisioning_job_id: "resume",
                environment_id: environmentId,
                operation: "create",
                status: "running",
                attempts: 1,
                available_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              }
            });
            return { api_url: runtime.api_url, ...(runtime.admin_url ? { admin_url: runtime.admin_url } : {}) };
          }
          throw new Error(
            `${operation} is a Neon backup/restore operation for a managed deployment; ` +
            "use a database branch or point-in-time restore"
          );
        }
      }
    : {}),
  ...(provisioner
    ? {
        operateLocalEnvironment: async (environmentId, operation, input) => {
          if (operation === "suspend") {
            await provisioner!.suspend(environmentId);
            return {};
          }
          if (operation === "resume") {
            const runtime = await provisioner!.resume(environmentId);
            return { api_url: runtime.api_url, admin_url: runtime.admin_url };
          }
          const backupDirectory = resolve(
            process.env["LIP_CLOUD_BACKUP_DIR"] ??
            join(process.env["LIP_CLOUD_DATA_DIR"] ?? ".lip-cloud", "backups")
          );
          mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
          if (operation === "backup") {
            const backupId = `${environmentId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
            const backup = await provisioner!.backup(
              environmentId,
              join(backupDirectory, `${backupId}.json`)
            );
            return { backup_id: backupId, checksum: backup.checksum.value };
          }
          const backupId = input.backup_id;
          if (!backupId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/.test(backupId)) {
            throw new Error("backup_id is invalid");
          }
          const runtime = await provisioner!.restoreBackup(
            join(backupDirectory, `${backupId}.json`),
            { force: true }
          );
          return { api_url: runtime.api_url, admin_url: runtime.admin_url, backup_id: backupId };
        }
      }
    : {}),
  host: process.env["LIP_CLOUD_HOST"] ?? "0.0.0.0",
  port: Number.parseInt(process.env["LIP_CLOUD_PORT"] ?? "3220", 10),
  ...(process.env["LIP_CLOUD_ALLOWED_ORIGINS"]
    ? {
        allowedOrigins: process.env["LIP_CLOUD_ALLOWED_ORIGINS"]
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      }
    : {})
});

console.log(JSON.stringify({
  event: "cloud_control_plane_ready",
  url: running.url,
  regions,
  managed_runtime: Boolean(managed),
  local_provisioner: Boolean(provisioner),
  restored_runtimes: restoredRuntimes
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    worker?.close();
    // Runtimes close before the listener so in-flight tenant writes finish
    // against a live pool rather than a closing one.
    void (managed?.close() ?? Promise.resolve())
      .then(() => provisioner?.close())
      .then(() => running.close())
      .then(() => customers?.close())
      .then(() => credentials?.close())
      .then(() => controlPlane.close())
      .then(() => managedPool?.end())
      .then(() => process.exit(0));
  });
}
