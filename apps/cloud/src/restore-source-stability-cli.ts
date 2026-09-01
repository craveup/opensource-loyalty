#!/usr/bin/env node

import { Pool } from "pg";
import { assertSessionLeaseCompatibleUrl } from "@loyalty-interchange/storage-postgres";
import {
  captureRestoreEvidence,
  captureStableRestoreSourceEvidence,
} from "./restore-verification.js";

const sourceUrl = process.env["LIP_BACKUP_SOURCE_DATABASE_URL"];
if (!sourceUrl) {
  throw new Error("LIP_BACKUP_SOURCE_DATABASE_URL is required");
}
assertSessionLeaseCompatibleUrl(sourceUrl, "LIP_BACKUP_SOURCE_DATABASE_URL");

const source = new Pool({ connectionString: sourceUrl, max: 1 });
try {
  const evidence = await captureStableRestoreSourceEvidence(() =>
    captureRestoreEvidence(source),
  );
  console.log(
    JSON.stringify({
      event: "loyalty_backup_source_stable",
      interval_ms: 5_000,
      cloud_schema_version_count: evidence.cloud_schema_versions.length,
      engine_schema_version_count: evidence.engine_schema_versions.length,
      relations_compared: Object.keys(evidence.relations).length,
    }),
  );
} finally {
  await source.end();
}
