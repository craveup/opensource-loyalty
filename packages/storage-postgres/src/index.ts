import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import {
  LoyaltyEngine,
  type LoyaltyEngineState
} from "@loyalty-interchange/reference";
import {
  StateRevisionConflictError,
  type AsyncStateStore,
  type StateStoreStatus,
  type VersionedState
} from "@loyalty-interchange/storage";
import { assertSessionLeaseCompatibleUrl } from "./connection-policy.js";

export { assertSessionLeaseCompatibleUrl } from "./connection-policy.js";

const migrations = [
  {
    version: 1,
    name: "normalized_engine",
    url: new URL("../migrations/001_normalized_engine.sql", import.meta.url)
  },
  {
    version: 2,
    name: "tenant_isolation",
    url: new URL("../migrations/002_tenant_isolation.sql", import.meta.url)
  },
  {
    version: 3,
    name: "tenant_runtime_role",
    url: new URL("../migrations/003_tenant_runtime_role.sql", import.meta.url)
  }
] as const;

/** The non-bypassing role every tenant transaction assumes. See migration 003. */
export const TENANT_RUNTIME_ROLE = "lip_tenant_runtime";
const engineTables = [
  "lip_engine_identities",
  "lip_engine_balance_lots",
  "lip_engine_lot_consumptions",
  "lip_engine_reservations",
  "lip_engine_ledger",
  "lip_engine_balances",
  "lip_engine_idempotency",
  "lip_engine_accruals",
  "lip_engine_adjustments",
  "lip_engine_redemptions",
  "lip_engine_issued_rewards",
  "lip_engine_members"
] as const;

export interface PostgresStorageOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: PoolConfig;
}

export interface PostgresEngineStateOptions extends PostgresStorageOptions {
  tenantId: string;
  programId: string;
}

interface RevisionRow extends QueryResultRow {
  revision: string;
}

interface HeaderRow extends RevisionRow {
  state_version: number;
  program_fingerprint: string;
  saved_at: Date | string;
}

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds the JavaScript safe integer range`);
  }
  return parsed;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Creates a standalone pg pool for callers that wire several Postgres-backed
 * stores against one shared pool (pass it via PostgresStorageOptions.pool and
 * end it after every store is closed).
 */
export function createPostgresPool(options: Omit<PostgresStorageOptions, "pool"> = {}): Pool {
  if (options.connectionString) {
    assertSessionLeaseCompatibleUrl(options.connectionString, "Postgres connectionString");
  }
  return new Pool({
    ...(options.poolConfig ?? {}),
    ...(options.connectionString ? { connectionString: options.connectionString } : {})
  });
}

function createPool(options: PostgresStorageOptions): { pool: Pool; ownsPool: boolean } {
  if (options.pool) return { pool: options.pool, ownsPool: false };
  if (options.connectionString) {
    assertSessionLeaseCompatibleUrl(options.connectionString, "Postgres connectionString");
  }
  return {
    pool: new Pool({
      ...(options.poolConfig ?? {}),
      ...(options.connectionString ? { connectionString: options.connectionString } : {})
    }),
    ownsPool: true
  };
}

async function inTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockTransaction(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

/**
 * Runs `run` in one transaction whose tenant scope is set for that transaction
 * only, so row-level security can enforce the isolation the query predicates
 * merely assert (see migrations/002_tenant_isolation.sql).
 *
 * The `true` third argument to set_config is what makes this safe on a pooled
 * connection: the setting is reverted on COMMIT or ROLLBACK, so the next
 * transaction on the same socket starts with no tenant and can read nothing
 * until it declares its own.
 */
export async function withTenantTransaction<T>(
  pool: Pool,
  tenantId: string,
  run: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!tenantId.trim()) throw new Error("A tenant id is required to open a tenant transaction");
  return inTransaction(pool, async (client) => {
    // Assume the non-bypassing role first. PostgreSQL checks BYPASSRLS on the
    // current role, and managed providers hand out owner roles that have it --
    // without this, the policies are present, forced, and completely inert.
    // SET LOCAL reverts on COMMIT/ROLLBACK, like the setting below.
    await client.query(`SET LOCAL ROLE ${TENANT_RUNTIME_ROLE}`);
    await client.query("SELECT set_config('lip.tenant_id', $1, true)", [tenantId]);
    return run(client);
  });
}

export interface TenantIsolationStatus {
  /** Both probes held: no tenant context reads nothing, and one tenant cannot read another. */
  enforced: boolean;
  current_role: string;
  runtime_role_available: boolean;
  /**
   * True when the *connecting* role could read every tenant's rows if it issued
   * a query without assuming the runtime role.
   *
   * This is expected on a managed provider: the service connects as the
   * database owner because it runs its own migrations, and Neon grants that
   * role BYPASSRLS. It is not an application bypass — every tenant-data path
   * assumes `lip_tenant_runtime` first — but it does mean that whoever holds
   * the connection string holds administrator access to the database, which is
   * true of any owner credential and is worth stating rather than implying.
   */
  owner_bypasses_row_level_security: boolean;
  detail?: string;
}

/**
 * Proves tenant isolation is in force on this database, by trying to break it.
 *
 * Static checks cannot answer this. Whether RLS actually filters depends on an
 * attribute of the connecting role that no amount of correct SQL in a migration
 * can guarantee, and the failure mode is silent: every query succeeds and
 * returns other tenants' rows. So the check writes a row under one scope and
 * reads it back with none, and reports isolation as enforced only when that
 * read comes back empty.
 *
 * Managed startup calls this and refuses to serve if it fails. A deployment
 * that cannot prove isolation must not accept tenant traffic.
 */
export async function assertTenantIsolationEnforced(pool: Pool): Promise<TenantIsolationStatus> {
  const probeTenant = `lip-isolation-probe-${randomUUID()}`;
  const otherTenant = `lip-isolation-other-${randomUUID()}`;
  const probeKey = `isolation-probe-${randomUUID()}`;
  const identity = await pool.query<{
    current_role: string;
    bypasses: boolean;
    runtime_role_available: boolean;
  }>(`
    SELECT current_user AS current_role,
           COALESCE((SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user), false)
             AS bypasses,
           EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS runtime_role_available
  `, [TENANT_RUNTIME_ROLE]);
  const row = identity.rows[0];
  const base = {
    current_role: row?.current_role ?? "unknown",
    runtime_role_available: Boolean(row?.runtime_role_available),
    owner_bypasses_row_level_security: Boolean(row?.bypasses)
  };

  try {
    await withTenantTransaction(pool, probeTenant, async (client) => {
      await client.query(`
        INSERT INTO lip_platform_state (tenant_id, state_key, value, revision, updated_at)
        VALUES ($1, $2, '{}'::jsonb, 1, now())
      `, [probeTenant, probeKey]);
    });

    // A request that declares no tenant. This is the shape of a code path that
    // forgot to scope itself, and it must come back empty rather than
    // returning every tenant's rows.
    const unscoped = await inTransaction(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${TENANT_RUNTIME_ROLE}`);
      return client.query("SELECT 1 FROM lip_platform_state WHERE state_key = $1", [probeKey]);
    });

    // A request that declares the wrong tenant, which is the shape of a
    // credential used against someone else's environment.
    const crossTenant = await withTenantTransaction(pool, otherTenant, (client) =>
      client.query("SELECT 1 FROM lip_platform_state WHERE state_key = $1", [probeKey]));

    const enforced = unscoped.rowCount === 0 && crossTenant.rowCount === 0;
    return {
      ...base,
      enforced,
      ...(enforced
        ? {}
        : {
            detail:
              "Row-level security is not filtering tenant rows " +
              `(unscoped read ${unscoped.rowCount ?? 0} row(s), cross-tenant read ` +
              `${crossTenant.rowCount ?? 0} row(s)). Apply migration 003 so ${base.current_role} ` +
              `can assume ${TENANT_RUNTIME_ROLE}, or connect as a role without BYPASSRLS.`
          })
    };
  } catch (error) {
    return {
      ...base,
      enforced: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    // Remove the probe row as its owner, and again unscoped, so no residue
    // survives whichever of the two paths this database actually permits.
    await withTenantTransaction(pool, probeTenant, async (client) => {
      await client.query("DELETE FROM lip_platform_state WHERE state_key = $1", [probeKey]);
    }).catch(() => undefined);
    await pool
      .query("DELETE FROM lip_platform_state WHERE state_key = $1", [probeKey])
      .catch(() => undefined);
  }
}

export class PostgresMigrator {
  private readonly pool: Pool;

  public constructor(pool: Pool) {
    this.pool = pool;
  }

  public async migrate(): Promise<void> {
    const pending = await Promise.all(
      migrations.map(async (migration) => ({
        ...migration,
        sql: await readFile(fileURLToPath(migration.url), "utf8")
      }))
    );
    await inTransaction(this.pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS lip_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await lockTransaction(client, "lip:schema-migrations");
      const existing = await client.query<{ version: number }>(
        "SELECT version FROM lip_schema_migrations"
      );
      const applied = new Set(existing.rows.map((row) => row.version));
      for (const migration of pending) {
        if (applied.has(migration.version)) continue;
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO lip_schema_migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name]
        );
      }
    });
  }
}

export class PostgresJsonStateStore<T> implements AsyncStateStore<T> {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly tenantId: string;
  private readonly key: string;
  public readonly status: StateStoreStatus;

  public constructor(options: PostgresStorageOptions & { tenantId: string; key: string }) {
    if (!options.tenantId.trim() || !options.key.trim()) {
      throw new Error("Postgres tenant id and state key are required");
    }
    const created = createPool(options);
    this.pool = created.pool;
    this.ownsPool = created.ownsPool;
    this.tenantId = options.tenantId;
    this.key = options.key;
    this.status = {
      driver: "postgres",
      location: options.connectionString ? "configured connection" : "shared pool",
      persistent: true
    };
  }

  public async migrate(): Promise<void> {
    await new PostgresMigrator(this.pool).migrate();
  }

  public async load(): Promise<VersionedState<T> | null> {
    const row = await this.inTenantTransaction(async (client) => {
      const result = await client.query<RevisionRow & { value: T }>(`
        SELECT value, revision
        FROM lip_platform_state
        WHERE tenant_id = $1 AND state_key = $2
      `, [this.tenantId, this.key]);
      return result.rows[0];
    });
    return row
      ? { state: structuredClone(row.value), revision: safeInteger(row.revision, "State revision") }
      : null;
  }

  public async save(state: T, expectedRevision?: number): Promise<number> {
    return this.inTenantTransaction(async (client) => {
      await lockTransaction(client, `lip:state:${this.tenantId}:${this.key}`);
      const current = await client.query<RevisionRow>(`
        SELECT revision
        FROM lip_platform_state
        WHERE tenant_id = $1 AND state_key = $2
      `, [this.tenantId, this.key]);
      const actual = current.rows[0] ? safeInteger(current.rows[0].revision, "State revision") : 0;
      if (expectedRevision !== undefined && actual !== expectedRevision) {
        throw new StateRevisionConflictError(expectedRevision, actual);
      }
      const next = actual + 1;
      await client.query(`
        INSERT INTO lip_platform_state (tenant_id, state_key, value, revision, updated_at)
        VALUES ($1, $2, $3::jsonb, $4, now())
        ON CONFLICT (tenant_id, state_key) DO UPDATE SET
          value = excluded.value,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `, [this.tenantId, this.key, json(state), String(next)]);
      return next;
    });
  }

  public async clear(): Promise<void> {
    await this.inTenantTransaction(async (client) => {
      await client.query(
        "DELETE FROM lip_platform_state WHERE tenant_id = $1 AND state_key = $2",
        [this.tenantId, this.key]
      );
    });
  }

  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async inTenantTransaction<R>(run: (client: PoolClient) => Promise<R>): Promise<R> {
    return withTenantTransaction(this.pool, this.tenantId, run);
  }
}

export class PostgresEngineRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly tenantId: string;
  private readonly programId: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  public readonly status: StateStoreStatus;

  public constructor(options: PostgresEngineStateOptions) {
    if (!options.tenantId.trim() || !options.programId.trim()) {
      throw new Error("Postgres tenant id and program id are required");
    }
    const created = createPool(options);
    this.pool = created.pool;
    this.ownsPool = created.ownsPool;
    this.tenantId = options.tenantId;
    this.programId = options.programId;
    this.status = {
      driver: "postgres",
      location: options.connectionString ? "configured connection" : "shared pool",
      persistent: true
    };
  }

  public async migrate(): Promise<void> {
    await new PostgresMigrator(this.pool).migrate();
  }

  public async load(): Promise<VersionedState<LoyaltyEngineState> | null> {
    return this.inTenantTransaction((client) => this.loadWithClient(client));
  }

  public async save(state: LoyaltyEngineState, expectedRevision?: number): Promise<number> {
    return this.inTenantTransaction(async (client) => {
      await this.lockEngine(client);
      return this.saveWithClient(client, state, expectedRevision);
    });
  }

  public async mutate<T>(
    engine: LoyaltyEngine,
    operation: () => T | Promise<T>
  ): Promise<T> {
    return this.serialized(async () => this.inTenantTransaction(async (client) => {
      await this.lockEngine(client);
      const current = await this.loadWithClient(client);
      if (current) engine.replaceState(current.state);
      const result = await operation();
      await this.saveWithClient(client, engine.exportState(), current?.revision ?? 0);
      return result;
    }));
  }

  public async withLease<T>(
    leaseName: string,
    operation: () => T | Promise<T>
  ): Promise<{ acquired: boolean; result?: T }> {
    const client = await this.pool.connect();
    const key = `lip:lease:${this.tenantId}:${this.programId}:${leaseName}`;
    let connectionError: Error | undefined;
    const rememberConnectionError = (error: Error): void => {
      connectionError = error;
    };
    client.on("error", rememberConnectionError);
    try {
      const acquired = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [key]
      );
      if (!acquired.rows[0]?.acquired) return { acquired: false };
      try {
        return { acquired: true, result: await operation() };
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      }
    } catch (error) {
      if (error instanceof Error) connectionError ??= error;
      throw error;
    } finally {
      client.release(connectionError ?? undefined);
      // Broken clients can emit again while the socket finishes closing.
      if (!connectionError) client.removeListener("error", rememberConnectionError);
    }
  }

  public async clear(): Promise<void> {
    await this.inTenantTransaction(async (client) => {
      await this.lockEngine(client);
      await client.query(
        "DELETE FROM lip_engine_states WHERE tenant_id = $1 AND program_id = $2",
        [this.tenantId, this.programId]
      );
    });
  }

  public async close(): Promise<void> {
    await Promise.allSettled(this.queues.values());
    if (this.ownsPool) await this.pool.end();
  }

  private async inTenantTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.pool, this.tenantId, run);
  }

  private async lockEngine(client: PoolClient): Promise<void> {
    await lockTransaction(client, `lip:engine:${this.tenantId}:${this.programId}`);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const key = `${this.tenantId}:${this.programId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }

  private async loadWithClient(
    client: PoolClient
  ): Promise<VersionedState<LoyaltyEngineState> | null> {
    const scope = [this.tenantId, this.programId];
    const headerResult = await client.query<HeaderRow>(`
      SELECT state_version, program_fingerprint, saved_at, revision
      FROM lip_engine_states
      WHERE tenant_id = $1 AND program_id = $2
    `, scope);
    const header = headerResult.rows[0];
    if (!header) return null;

    const members = await client.query<{ member_id: string; payload: unknown }>(
      "SELECT member_id, payload FROM lip_engine_members WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const identities = await client.query<{ identity_key: string; member_id: string }>(
      "SELECT identity_key, member_id FROM lip_engine_identities WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const balances = await client.query<{ balance_key: string; amount: string }>(
      "SELECT balance_key, amount FROM lip_engine_balances WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const reservations = await client.query<{ reservation_id: string; payload: unknown }>(
      "SELECT reservation_id, payload FROM lip_engine_reservations WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const ledger = await client.query<{ entry_id: string; payload: unknown }>(
      "SELECT entry_id, payload FROM lip_engine_ledger WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const lots = await client.query<{ entry_id: string; payload: unknown }>(
      "SELECT entry_id, payload FROM lip_engine_balance_lots WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const consumptions = await client.query<{ consumption_id: string; payload: unknown }>(
      "SELECT consumption_id, payload FROM lip_engine_lot_consumptions WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const idempotency = await client.query<{
      operation_key: string;
      fingerprint: string;
      response: unknown;
    }>(`
      SELECT operation_key, fingerprint, response
      FROM lip_engine_idempotency
      WHERE tenant_id = $1 AND program_id = $2
    `, scope);
    const accruals = await client.query<{ order_id: string; payload: unknown }>(
      "SELECT order_id, payload FROM lip_engine_accruals WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const adjustments = await client.query<{ adjustment_id: string; payload: unknown }>(
      "SELECT adjustment_id, payload FROM lip_engine_adjustments WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const redemptions = await client.query<{ redemption_id: string; payload: unknown }>(
      "SELECT redemption_id, payload FROM lip_engine_redemptions WHERE tenant_id = $1 AND program_id = $2",
      scope
    );
    const issuedRewards = await client.query<{ issued_reward_id: string; payload: unknown }>(
      "SELECT issued_reward_id, payload FROM lip_engine_issued_rewards WHERE tenant_id = $1 AND program_id = $2",
      scope
    );

    const state = {
      version: header.state_version,
      program_id: this.programId,
      program_fingerprint: header.program_fingerprint,
      saved_at: new Date(header.saved_at).toISOString(),
      members: members.rows.map(({ member_id, payload }) => [member_id, payload]),
      identity_index: identities.rows.map(({ identity_key, member_id }) => [identity_key, member_id]),
      points: balances.rows.map(({ balance_key, amount }) => [
        balance_key,
        safeInteger(amount, `Balance ${balance_key}`)
      ]),
      reservations: reservations.rows.map(({ reservation_id, payload }) => [reservation_id, payload]),
      ledger: ledger.rows.map(({ entry_id, payload }) => [entry_id, payload]),
      point_lots: lots.rows.map(({ entry_id, payload }) => [entry_id, payload]),
      point_lot_consumptions: consumptions.rows.map(
        ({ consumption_id, payload }) => [consumption_id, payload]
      ),
      idempotency: idempotency.rows.map(({ operation_key, fingerprint, response }) => [
        operation_key,
        { fingerprint, response }
      ]),
      accruals_by_order: accruals.rows.map(({ order_id, payload }) => [order_id, payload]),
      adjustments: adjustments.rows.map(({ adjustment_id, payload }) => [adjustment_id, payload]),
      reservations_by_redemption: redemptions.rows.map(
        ({ redemption_id, payload }) => [redemption_id, payload]
      ),
      issued_rewards: issuedRewards.rows.map(
        ({ issued_reward_id, payload }) => [issued_reward_id, payload]
      )
    } as LoyaltyEngineState;
    return {
      state,
      revision: safeInteger(header.revision, "Engine revision")
    };
  }

  private async saveWithClient(
    client: PoolClient,
    state: LoyaltyEngineState,
    expectedRevision?: number
  ): Promise<number> {
    if (state.program_id !== this.programId) {
      throw new Error(`Engine state belongs to ${state.program_id}, expected ${this.programId}`);
    }
    const scope = [this.tenantId, this.programId];
    const current = await client.query<RevisionRow>(`
      SELECT revision
      FROM lip_engine_states
      WHERE tenant_id = $1 AND program_id = $2
    `, scope);
    const actual = current.rows[0] ? safeInteger(current.rows[0].revision, "Engine revision") : 0;
    if (expectedRevision !== undefined && actual !== expectedRevision) {
      throw new StateRevisionConflictError(expectedRevision, actual);
    }
    const next = actual + 1;
    await client.query(`
      INSERT INTO lip_engine_states (
        tenant_id, program_id, state_version, program_fingerprint, saved_at, revision
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, program_id) DO UPDATE SET
        state_version = excluded.state_version,
        program_fingerprint = excluded.program_fingerprint,
        saved_at = excluded.saved_at,
        revision = excluded.revision
    `, [
      this.tenantId,
      this.programId,
      state.version,
      state.program_fingerprint,
      state.saved_at,
      String(next)
    ]);
    for (const table of engineTables) {
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND program_id = $2`,
        scope
      );
    }
    for (const [memberId, member] of state.members) {
      await client.query(`
        INSERT INTO lip_engine_members (tenant_id, program_id, member_id, status, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `, [...scope, memberId, member.status, json(member)]);
    }
    for (const [identityKey, memberId] of state.identity_index) {
      await client.query(`
        INSERT INTO lip_engine_identities (tenant_id, program_id, identity_key, member_id)
        VALUES ($1, $2, $3, $4)
      `, [...scope, identityKey, memberId]);
    }
    for (const [balanceKey, amount] of state.points) {
      await client.query(`
        INSERT INTO lip_engine_balances (tenant_id, program_id, balance_key, amount)
        VALUES ($1, $2, $3, $4)
      `, [...scope, balanceKey, String(amount)]);
    }
    for (const [reservationId, reservation] of state.reservations) {
      await client.query(`
        INSERT INTO lip_engine_reservations (
          tenant_id, program_id, reservation_id, member_id, status, expires_at, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `, [
        ...scope,
        reservationId,
        reservation.member_id,
        reservation.status,
        reservation.expires_at,
        json(reservation)
      ]);
    }
    for (const [entryId, entry] of state.ledger) {
      await client.query(`
        INSERT INTO lip_engine_ledger (
          tenant_id, program_id, entry_id, member_id, account_id, operation,
          unit, amount, occurred_at, order_id, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      `, [
        ...scope,
        entryId,
        entry.member_id,
        entry.account_id,
        entry.operation,
        entry.unit,
        String(entry.amount),
        entry.occurred_at,
        entry.order_id ?? null,
        json(entry)
      ]);
    }
    for (const [entryId, lot] of state.point_lots) {
      const unit = lot.unit ??
        state.ledger.find(([candidateId]) => candidateId === entryId)?.[1].unit ??
        "points";
      await client.query(`
        INSERT INTO lip_engine_balance_lots (
          tenant_id, program_id, entry_id, member_id, unit, remaining, expires_at, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `, [
        ...scope,
        entryId,
        lot.memberId,
        unit,
        String(lot.remaining),
        lot.expiresAt,
        json(lot)
      ]);
    }
    for (const [consumptionId, payload] of state.point_lot_consumptions) {
      await client.query(`
        INSERT INTO lip_engine_lot_consumptions (
          tenant_id, program_id, consumption_id, payload
        )
        VALUES ($1, $2, $3, $4::jsonb)
      `, [...scope, consumptionId, json(payload)]);
    }
    for (const [operationKey, record] of state.idempotency) {
      await client.query(`
        INSERT INTO lip_engine_idempotency (
          tenant_id, program_id, operation_key, fingerprint, response
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `, [...scope, operationKey, record.fingerprint, json(record.response)]);
    }
    for (const [orderId, payload] of state.accruals_by_order) {
      await client.query(`
        INSERT INTO lip_engine_accruals (tenant_id, program_id, order_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `, [...scope, orderId, json(payload)]);
    }
    for (const [adjustmentId, payload] of state.adjustments) {
      await client.query(`
        INSERT INTO lip_engine_adjustments (tenant_id, program_id, adjustment_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `, [...scope, adjustmentId, json(payload)]);
    }
    for (const [redemptionId, payload] of state.reservations_by_redemption) {
      await client.query(`
        INSERT INTO lip_engine_redemptions (tenant_id, program_id, redemption_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `, [...scope, redemptionId, json(payload)]);
    }
    for (const [issuedRewardId, reward] of state.issued_rewards ?? []) {
      await client.query(`
        INSERT INTO lip_engine_issued_rewards (
          tenant_id, program_id, issued_reward_id, member_id, reward_id,
          status, expires_at, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `, [
        ...scope,
        issuedRewardId,
        reward.member_id,
        reward.reward_id,
        reward.status,
        reward.expires_at ?? null,
        json(reward)
      ]);
    }
    return next;
  }
}
