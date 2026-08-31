#!/usr/bin/env node

import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OidcAuthenticator } from "./auth.js";
import { StripeBillingProvider } from "./billing.js";
import { LipClient } from "@loyalty-interchange/sdk";
import { PostgresCustomerRepository } from "./customer-postgres-repository.js";
import { OidcCustomerIdentityProvider } from "./customer-provider.js";
import { CustomerPlatform } from "./customer-service.js";
import {
  databaseIdentityFingerprint,
  managedDatabaseConfiguration
} from "./database-configuration.js";
import { LocalDataPlaneProvisioner } from "./data-plane-provisioner.js";
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
let provisioner: LocalDataPlaneProvisioner | undefined;
let worker: CloudProvisioningWorker | undefined;
if (programDirectory) {
  const credentialEncryptionKey = process.env["LIP_CLOUD_CREDENTIAL_KEY"];
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
if (customerConfigured && !provisioner) {
  throw new Error("Managed customer routes require a configured local data-plane provisioner");
}
let customers: CustomerPlatform | undefined;
if (customerIssuer && customerTenantId && customerProviderId && provisioner) {
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
    loyalty: {
      enroll: async (input) => {
        const runtime = provisioner.runtimes().find((candidate) =>
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
  ...(provisioner
    ? {
        rotateEnvironmentCredentials: (
          environmentId: string,
          rotateOptions: EnvironmentCredentialRotationOptions
        ) => provisioner!.rotateCredentials(environmentId, rotateOptions)
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
  local_provisioner: Boolean(provisioner)
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    worker?.close();
    void (provisioner?.close() ?? Promise.resolve())
      .then(() => running.close())
      .then(() => customers?.close())
      .then(() => controlPlane.close())
      .then(() => process.exit(0));
  });
}
