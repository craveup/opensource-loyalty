import { createHash } from "node:crypto";
import { assertSessionLeaseCompatibleUrl } from "@loyalty-interchange/storage-postgres";

export interface ManagedDatabaseConfiguration {
  controlPlaneUrl: string;
  dataPlaneUrl: string;
}

export function managedDatabaseConfiguration(
  environment: NodeJS.ProcessEnv
): ManagedDatabaseConfiguration {
  const controlPlaneUrl = environment["LIP_CLOUD_DATABASE_URL"]?.trim() ?? "";
  assertSessionLeaseCompatibleUrl(controlPlaneUrl, "LIP_CLOUD_DATABASE_URL");
  // One managed environment, one database. The separate data-plane variable
  // survives only for a self-hosted deployment that genuinely splits them;
  // requiring an operator to set the same Neon URL twice was a way to get it
  // wrong, not a safeguard.
  const dataPlaneUrl = environment["LIP_CLOUD_DATA_PLANE_DATABASE_URL"]?.trim() || controlPlaneUrl;
  assertSessionLeaseCompatibleUrl(dataPlaneUrl, "LIP_CLOUD_DATA_PLANE_DATABASE_URL");
  // The two URLs are NOT asserted to differ: sharing one endpoint is the
  // intended topology. The independence this deployment has to prove is
  // sandbox against production, and no single process can see both — see
  // databaseIdentityFingerprint.
  return { controlPlaneUrl, dataPlaneUrl };
}

function databaseIdentity(value: string): string {
  const parsed = new URL(value);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}${parsed.pathname}`;
}

/**
 * A non-secret, stable identity for a database, safe to publish on /health.
 *
 * Sandbox and production never share a process, so neither can compare its own
 * URL against the other's. Publishing a fingerprint of host:port/database —
 * never the role or password — lets an operator or a release check prove the
 * two deployments are independent from outside, which is the property managed activation
 * has to certify.
 */
export function databaseIdentityFingerprint(value: string): string {
  return createHash("sha256").update(databaseIdentity(value)).digest("hex").slice(0, 16);
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
