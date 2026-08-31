import {
  PostgresMigrator,
  assertSessionLeaseCompatibleUrl,
  createPostgresPool
} from "@loyalty-interchange/storage-postgres";
import { PostgresCloudRepository } from "./postgres-repository.js";

export interface SharedClusterMigrationOptions {
  /**
   * Control-plane database (the `lip_cloud_*` tables). Required.
   */
  controlPlaneUrl: string;
  /**
   * Data-plane engine database (the `lip_engine_*` / `lip_platform_state`
   * tables). Defaults to `controlPlaneUrl`, which is the shared-cluster
   * topology: one Postgres serving both the control plane and every tenant's
   * row-scoped engine state.
   */
  dataPlaneUrl?: string;
}

export interface SharedClusterMigrationResult {
  /** True when both schemas share one database (the default topology). */
  shared_database: boolean;
  engine_schema: "applied";
  control_plane_schema: "applied";
}

/**
 * Applies every schema the shared LIP cluster needs, in dependency order:
 *
 * 1. the engine schema from `@loyalty-interchange/storage-postgres`
 *    (tenant-scoped normalized tables shared by all brands); then
 * 2. the control-plane schema from `apps/cloud/migrations`
 *    (organizations, projects, environments, provisioning jobs, usage).
 *
 * Both migrators take a Postgres advisory lock and record applied versions,
 * so this is safe to run repeatedly and safe as a release/preDeploy step —
 * concurrent runs serialize instead of racing.
 */
export async function runSharedClusterMigrations(
  options: SharedClusterMigrationOptions
): Promise<SharedClusterMigrationResult> {
  const controlPlaneUrl = options.controlPlaneUrl.trim();
  if (!controlPlaneUrl) throw new Error("A control-plane connection string is required");
  assertSessionLeaseCompatibleUrl(controlPlaneUrl, "controlPlaneUrl");
  const dataPlaneUrl = options.dataPlaneUrl?.trim() || controlPlaneUrl;
  assertSessionLeaseCompatibleUrl(dataPlaneUrl, "dataPlaneUrl");

  const enginePool = createPostgresPool({ connectionString: dataPlaneUrl });
  try {
    await new PostgresMigrator(enginePool).migrate();
  } finally {
    await enginePool.end();
  }

  const repository = new PostgresCloudRepository({ connectionString: controlPlaneUrl });
  try {
    await repository.migrate();
  } finally {
    await repository.close();
  }

  return {
    shared_database: dataPlaneUrl === controlPlaneUrl,
    engine_schema: "applied",
    control_plane_schema: "applied"
  };
}
