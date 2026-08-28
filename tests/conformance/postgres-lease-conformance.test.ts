import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresEngineRepository } from "@loyalty-interchange/storage-postgres";

const postgresUrl = process.env["LIP_TEST_POSTGRES_URL"];

describe.skipIf(!postgresUrl)("PostgreSQL session advisory lease conformance", () => {
  it("keeps acquire/work/unlock on one session and releases after failure", async () => {
    const scope = randomUUID();
    const first = new PostgresEngineRepository({
      connectionString: postgresUrl!,
      tenantId: `lease-${scope}`,
      programId: "program",
      poolConfig: { application_name: `lip-lease-first-${scope}` }
    });
    const contender = new PostgresEngineRepository({
      connectionString: postgresUrl!,
      tenantId: `lease-${scope}`,
      programId: "program",
      poolConfig: { application_name: `lip-lease-contender-${scope}` }
    });
    try {
      await expect(first.withLease("scheduler", async () =>
        contender.withLease("scheduler", () => "unexpected")))
        .resolves.toEqual({ acquired: true, result: { acquired: false } });

      await expect(first.withLease("scheduler", () => {
        throw new Error("abort scheduled work");
      })).rejects.toThrow("abort scheduled work");
      await expect(contender.withLease("scheduler", () => "recovered"))
        .resolves.toEqual({ acquired: true, result: "recovered" });
    } finally {
      await Promise.allSettled([first.close(), contender.close()]);
    }
  });

  it("allows a new worker to acquire after the lease connection is lost", async () => {
    const scope = randomUUID();
    const applicationName = `lip-lease-loss-${scope}`;
    const tenantId = `lease-loss-${scope}`;
    const first = new PostgresEngineRepository({
      connectionString: postgresUrl!,
      tenantId,
      programId: "program",
      poolConfig: { application_name: applicationName }
    });
    const recovered = new PostgresEngineRepository({
      connectionString: postgresUrl!,
      tenantId,
      programId: "program",
      poolConfig: { application_name: `lip-lease-recovered-${scope}` }
    });
    const control = new Client({ connectionString: postgresUrl });
    let entered!: () => void;
    const enteredLease = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const finishWork = new Promise<void>((resolve) => { finish = resolve; });
    try {
      await control.connect();
      const interrupted = first.withLease("scheduler", async () => {
        entered();
        await finishWork;
      });
      await enteredLease;
      const terminated = await control.query<{ terminated: boolean }>(
        `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
         WHERE application_name = $1 AND pid <> pg_backend_pid()`,
        [applicationName]
      );
      expect(terminated.rows.some((row) => row.terminated)).toBe(true);
      finish();
      await expect(interrupted).rejects.toThrow();
      await expect(recovered.withLease("scheduler", () => "recovered"))
        .resolves.toEqual({ acquired: true, result: "recovered" });
    } finally {
      finish?.();
      await control.end().catch(() => undefined);
      await Promise.allSettled([first.close(), recovered.close()]);
    }
  });
});
