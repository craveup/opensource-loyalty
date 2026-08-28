/**
 * Session advisory leases require the same checked-out PostgreSQL connection
 * from acquisition through unlock. Transaction-pooler endpoints cannot
 * preserve that ownership and are rejected before any network access.
 */
export function assertSessionLeaseCompatibleUrl(value: string, variableName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${variableName} must be a PostgreSQL connection string`);
  }
  if (!value.trim() || !["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${variableName} must be a PostgreSQL connection string`);
  }
  const pooledHostname = /(^|[.-])pooler([.-]|$)/iu.test(parsed.hostname);
  const pgbouncer = parsed.searchParams.get("pgbouncer")?.toLowerCase() === "true";
  if (pooledHostname || pgbouncer) {
    throw new Error(
      `${variableName} must use a direct endpoint for session advisory lease ownership`
    );
  }
}
