#!/usr/bin/env node

import { Pool } from "pg";
import { assertSessionLeaseCompatibleUrl } from "@loyalty-interchange/storage-postgres";
import { captureRestoreEvidence, compareRestoreEvidence } from "./restore-verification.js";

const sourceUrl = process.env["LIP_BACKUP_SOURCE_DATABASE_URL"];
const restoredUrl = process.env["LIP_BACKUP_RESTORE_DATABASE_URL"];
if (!sourceUrl || !restoredUrl) {
  throw new Error(
    "LIP_BACKUP_SOURCE_DATABASE_URL and LIP_BACKUP_RESTORE_DATABASE_URL are required"
  );
}
assertSessionLeaseCompatibleUrl(sourceUrl, "LIP_BACKUP_SOURCE_DATABASE_URL");
assertSessionLeaseCompatibleUrl(restoredUrl, "LIP_BACKUP_RESTORE_DATABASE_URL");
if (sourceUrl === restoredUrl) {
  throw new Error("Backup source and restored database URLs must be distinct");
}

const source = new Pool({ connectionString: sourceUrl, max: 1 });
const restored = new Pool({ connectionString: restoredUrl, max: 1 });
try {
  const [sourceEvidence, restoredEvidence] = await Promise.all([
    captureRestoreEvidence(source),
    captureRestoreEvidence(restored)
  ]);
  compareRestoreEvidence(sourceEvidence, restoredEvidence);
  console.log(JSON.stringify({
    event: "loyalty_backup_restore_verified",
    evidence: restoredEvidence
  }));
} finally {
  await Promise.allSettled([source.end(), restored.end()]);
}
