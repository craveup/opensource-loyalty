import { assertSessionLeaseCompatibleUrl } from "@loyalty-interchange/storage-postgres";

export interface ManagedDatabaseConfiguration {
  controlPlaneUrl: string;
  dataPlaneUrl: string;
}

export function managedDatabaseConfiguration(
  environment: NodeJS.ProcessEnv
): ManagedDatabaseConfiguration {
  const controlPlaneUrl = environment["LIP_CLOUD_DATABASE_URL"]?.trim() ?? "";
  const dataPlaneUrl = environment["LIP_CLOUD_DATA_PLANE_DATABASE_URL"]?.trim() ?? "";
  assertSessionLeaseCompatibleUrl(controlPlaneUrl, "LIP_CLOUD_DATABASE_URL");
  assertSessionLeaseCompatibleUrl(dataPlaneUrl, "LIP_CLOUD_DATA_PLANE_DATABASE_URL");
  return { controlPlaneUrl, dataPlaneUrl };
}

function databaseIdentity(value: string): string {
  const parsed = new URL(value);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}${parsed.pathname}`;
}

export function assertIndependentDeploymentDatabases(input: {
  production: ManagedDatabaseConfiguration;
  sandbox: ManagedDatabaseConfiguration;
}): void {
  const sandbox = new Set([
    databaseIdentity(input.sandbox.controlPlaneUrl),
    databaseIdentity(input.sandbox.dataPlaneUrl)
  ]);
  const production = [
    databaseIdentity(input.production.controlPlaneUrl),
    databaseIdentity(input.production.dataPlaneUrl)
  ];
  if (production.some((identity) => sandbox.has(identity))) {
    throw new Error("LIP sandbox and production must use independent databases and roles");
  }
}
