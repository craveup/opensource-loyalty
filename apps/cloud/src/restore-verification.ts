import { setTimeout as waitFor } from "node:timers/promises";
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

export function assertDistinctRestoreDatabases(
  sourceUrl: string,
  restoredUrl: string,
): void {
  if (databaseIdentity(sourceUrl) === databaseIdentity(restoredUrl)) {
    throw new Error("Backup source and restored databases must be distinct");
  }
}

const relations = [
  "lip_cloud_credential_operations",
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
  "lip_platform_state",
] as const;

async function schemaVersions(pool: Pool, table: string): Promise<number[]> {
  const result = await pool.query<{ version: number }>(
    `SELECT version FROM ${table} ORDER BY version`,
  );
  return result.rows.map((row) => row.version);
}

async function relationEvidence(
  pool: Pool,
  table: (typeof relations)[number],
): Promise<{ checksum: string; row_count: number }> {
  const evidenceRow = table === "lip_cloud_credential_operations"
    ? "to_jsonb(row_value) - 'handoff_envelope'"
    : "to_jsonb(row_value)";
  const result = await pool.query<{ checksum: string; row_count: string }>(`
    SELECT
      count(*)::text AS row_count,
      coalesce(sum(hashtextextended((${evidenceRow})::text, 0)::numeric), 0)::text AS checksum
    FROM ${table} AS row_value
  `);
  const row = result.rows[0];
  if (!row)
    throw new Error(`Restore evidence query returned no row for ${table}`);
  return {
    checksum: row.checksum,
    row_count: Number.parseInt(row.row_count, 10),
  };
}

export async function captureRestoreEvidence(
  pool: Pool,
): Promise<RestoreEvidence> {
  const relationEntries = await Promise.all(
    relations.map(
      async (table) => [table, await relationEvidence(pool, table)] as const,
    ),
  );
  return {
    cloud_schema_versions: await schemaVersions(
      pool,
      "lip_cloud_schema_migrations",
    ),
    engine_schema_versions: await schemaVersions(pool, "lip_schema_migrations"),
    relations: Object.fromEntries(relationEntries),
  };
}

export function compareRestoreEvidence(
  source: RestoreEvidence,
  restored: RestoreEvidence,
): void {
  const differences: string[] = [];
  if (
    JSON.stringify(source.cloud_schema_versions) !==
    JSON.stringify(restored.cloud_schema_versions)
  ) {
    differences.push("cloud_schema_versions");
  }
  if (
    JSON.stringify(source.engine_schema_versions) !==
    JSON.stringify(restored.engine_schema_versions)
  ) {
    differences.push("engine_schema_versions");
  }

  const relationNames = new Set([
    ...Object.keys(source.relations),
    ...Object.keys(restored.relations),
  ]);
  for (const relation of [...relationNames].sort()) {
    const sourceRelation = source.relations[relation];
    const restoredRelation = restored.relations[relation];
    if (!sourceRelation || !restoredRelation) {
      differences.push(`relations.${relation}`);
      continue;
    }
    if (sourceRelation.checksum !== restoredRelation.checksum) {
      differences.push(`relations.${relation}.checksum`);
    }
    if (sourceRelation.row_count !== restoredRelation.row_count) {
      differences.push(`relations.${relation}.row_count`);
    }
  }

  if (differences.length > 0) {
    // Field paths are safe release evidence. Never include row values, URLs,
    // roles, passwords, or credentials in a restore mismatch.
    throw new Error(
      `Restored loyalty database does not match the frozen source evidence: ${differences.join(", ")}`,
    );
  }
}

export async function captureStableRestoreSourceEvidence(
  capture: () => Promise<RestoreEvidence>,
  options: {
    intervalMs?: number;
    wait?: (intervalMs: number) => Promise<void>;
  } = {},
): Promise<RestoreEvidence> {
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000) {
    throw new Error(
      "Restore source stability interval must be at least 5000 milliseconds",
    );
  }

  const first = await capture();
  await (options.wait ?? waitFor)(intervalMs);
  const second = await capture();
  compareRestoreEvidence(first, second);
  return second;
}
