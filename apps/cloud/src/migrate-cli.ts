#!/usr/bin/env node

/**
 * Release-phase migration runner for the shared LIP cluster.
 *
 * Intended to run as the Render `preDeployCommand` (or any release step)
 * before the control-plane process boots:
 *
 *   node apps/cloud/dist/migrate-cli.js
 *
 * Environment:
 * - `LIP_CLOUD_DATABASE_URL` — required direct control-plane URL.
 * - `LIP_CLOUD_DATA_PLANE_DATABASE_URL` — required direct data-plane URL.
 *
 * The two values may identify the same database inside one environment, but
 * sandbox and production use independent Neon databases/roles.
 */

import { managedDatabaseConfiguration } from "./database-configuration.js";
import { runSharedClusterMigrations } from "./migrate.js";

try {
  const database = managedDatabaseConfiguration(process.env);
  const result = await runSharedClusterMigrations({
    controlPlaneUrl: database.controlPlaneUrl,
    dataPlaneUrl: database.dataPlaneUrl
  });
  console.log(JSON.stringify({ event: "shared_cluster_migrations_applied", ...result }));
} catch (error) {
  console.error(JSON.stringify({
    event: "shared_cluster_migrations_failed",
    message: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
}
