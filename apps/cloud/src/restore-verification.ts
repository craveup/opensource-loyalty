import type { Pool } from "pg";

export interface RestoreEvidence {
  cloud_schema_versions: number[];
  engine_schema_versions: number[];
  relations: Record<string, { checksum: string; row_count: number }>;
}

function databaseIdentity(value: string): string {
  const parsed = new URL(value);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}${parsed.pathname}`;
}

export function assertDistinctRestoreDatabases(sourceUrl: string, restoredUrl: string): void {
  if (databaseIdentity(sourceUrl) === databaseIdentity(restoredUrl)) {
    throw new Error("Backup source and restored databases must be distinct");
  }
}

const relations = [
  "lip_cloud_environments",
  "lip_cloud_organizations",
  "lip_cloud_projects",
  "lip_engine_accruals",
  "lip_engine_adjustments",
  "lip_engine_balances",
  "lip_engine_idempotency",
  "lip_engine_ledger",
  "lip_engine_members",
  "lip_engine_states",
  "lip_platform_state"
] as const;

async function schemaVersions(pool: Pool, table: string): Promise<number[]> {
  const result = await pool.query<{ version: number }>(
    `SELECT version FROM ${table} ORDER BY version`
  );
  return result.rows.map((row) => row.version);
}

async function relationEvidence(
  pool: Pool,
  table: typeof relations[number]
): Promise<{ checksum: string; row_count: number }> {
  const result = await pool.query<{ checksum: string; row_count: string }>(`
    SELECT
      count(*)::text AS row_count,
      coalesce(sum(hashtextextended(to_jsonb(row_value)::text, 0)::numeric), 0)::text AS checksum
    FROM ${table} AS row_value
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`Restore evidence query returned no row for ${table}`);
  return { checksum: row.checksum, row_count: Number.parseInt(row.row_count, 10) };
}

export async function captureRestoreEvidence(pool: Pool): Promise<RestoreEvidence> {
  const relationEntries = await Promise.all(
    relations.map(async (table) => [table, await relationEvidence(pool, table)] as const)
  );
  return {
    cloud_schema_versions: await schemaVersions(pool, "lip_cloud_schema_migrations"),
    engine_schema_versions: await schemaVersions(pool, "lip_schema_migrations"),
    relations: Object.fromEntries(relationEntries)
  };
}

export function compareRestoreEvidence(
  source: RestoreEvidence,
  restored: RestoreEvidence
): void {
  if (JSON.stringify(source) !== JSON.stringify(restored)) {
    throw new Error("Restored loyalty database does not match the frozen source evidence");
  }
}
