import type { Pool, PoolClient } from "pg";
import {
  CloudRepositoryConflictError,
  LastPlatformAdminError,
  type CloudOperator,
  type CloudOperatorApiKey,
  type CloudOperatorAuditEntry
} from "./types.js";

/** Advisory-lock key serializing operator bootstrap + last-admin guards. */
const OPERATOR_LOCK_KEY = "lip:cloud:operators:admin";

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function operatorRow(row: Record<string, unknown>): CloudOperator {
  return {
    operator_id: String(row["operator_id"]),
    subject: String(row["subject"]),
    role: row["role"] as CloudOperator["role"],
    active: Boolean(row["active"]),
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string),
    ...(row["email"] ? { email: String(row["email"]) } : {}),
    ...(row["organization_ids"]
      ? { organization_ids: (row["organization_ids"] as string[]).map(String) }
      : {})
  };
}

function operatorKeyRow(row: Record<string, unknown>): CloudOperatorApiKey {
  return {
    key_id: String(row["key_id"]),
    operator_id: String(row["operator_id"]),
    name: String(row["name"]),
    prefix: String(row["prefix"]),
    active: Boolean(row["active"]),
    created_at: iso(row["created_at"] as Date | string),
    secret_hash: String(row["secret_hash"]),
    ...(row["expires_at"] ? { expires_at: iso(row["expires_at"] as Date | string) } : {}),
    ...(row["last_used_at"] ? { last_used_at: iso(row["last_used_at"] as Date | string) } : {}),
    ...(row["revoked_at"] ? { revoked_at: iso(row["revoked_at"] as Date | string) } : {})
  };
}

function operatorAuditRow(row: Record<string, unknown>): CloudOperatorAuditEntry {
  return {
    audit_id: String(row["audit_id"]),
    actor: String(row["actor"]),
    action: String(row["action"]),
    resource_type: String(row["resource_type"]),
    resource_id: String(row["resource_id"]),
    occurred_at: iso(row["occurred_at"] as Date | string),
    ...(row["metadata"]
      ? { metadata: row["metadata"] as Record<string, unknown> }
      : {})
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  );
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertOperatorAudit(
  client: PoolClient,
  entry: CloudOperatorAuditEntry
): Promise<void> {
  await client.query(`
    INSERT INTO lip_cloud_operator_audit (
      audit_id, actor, action, resource_type, resource_id, metadata, occurred_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [
    entry.audit_id,
    entry.actor,
    entry.action,
    entry.resource_type,
    entry.resource_id,
    JSON.stringify(entry.metadata ?? null),
    entry.occurred_at
  ]);
}

async function insertOperatorKey(
  client: PoolClient,
  key: CloudOperatorApiKey
): Promise<void> {
  await client.query(`
    INSERT INTO lip_cloud_operator_api_keys (
      key_id, operator_id, name, prefix, secret_hash, active,
      created_at, expires_at, last_used_at, revoked_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    key.key_id,
    key.operator_id,
    key.name,
    key.prefix,
    key.secret_hash,
    key.active,
    key.created_at,
    key.expires_at ?? null,
    key.last_used_at ?? null,
    key.revoked_at ?? null
  ]);
}

/** Postgres persistence for control-plane operators. */
export class PostgresOperatorStore {
  public constructor(private readonly pool: Pool) {}

  public async createOperator(input: {
    operator: CloudOperator;
    key: CloudOperatorApiKey;
    audit: CloudOperatorAuditEntry;
    bootstrap?: boolean;
  }): Promise<void> {
    try {
      await transaction(this.pool, async (client) => {
        const { operator } = input;
        if (input.bootstrap) {
          // Bootstrap atomicity: serialize the count + insert
          // under an advisory lock so two concurrent bootstraps cannot both see
          // an empty directory and both mint platform-admins.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [OPERATOR_LOCK_KEY]
          );
          const count = await client.query<{ count: string }>(
            "SELECT count(*) AS count FROM lip_cloud_operators"
          );
          if (Number(count.rows[0]?.count ?? 0) > 0) {
            throw new CloudRepositoryConflictError(
              "The first operator was already bootstrapped"
            );
          }
        }
        await client.query(`
          INSERT INTO lip_cloud_operators (
            operator_id, subject, email, role, organization_ids, active,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
        `, [
          operator.operator_id,
          operator.subject,
          operator.email ?? null,
          operator.role,
          operator.organization_ids
            ? JSON.stringify(operator.organization_ids)
            : null,
          operator.active,
          operator.created_at,
          operator.updated_at
        ]);
        await insertOperatorKey(client, input.key);
        await insertOperatorAudit(client, input.audit);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CloudRepositoryConflictError("Operator already exists");
      }
      throw error;
    }
  }

  public async operatorById(operatorId: string): Promise<CloudOperator | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_operators WHERE operator_id = $1",
      [operatorId]
    );
    return result.rows[0] ? operatorRow(result.rows[0]) : undefined;
  }

  public async operatorBySubject(subject: string): Promise<CloudOperator | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_operators WHERE subject = $1",
      [subject]
    );
    return result.rows[0] ? operatorRow(result.rows[0]) : undefined;
  }

  public async listOperators(): Promise<CloudOperator[]> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_operators ORDER BY created_at"
    );
    return result.rows.map(operatorRow);
  }

  public async countOperators(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM lip_cloud_operators"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  public async updateOperator(input: {
    operatorId: string;
    active?: boolean;
    updatedAt: string;
    audit: CloudOperatorAuditEntry;
    guardLastPlatformAdmin?: boolean;
  }): Promise<CloudOperator | undefined> {
    return transaction(this.pool, async (client) => {
      if (input.guardLastPlatformAdmin && input.active === false) {
        // Atomic last-admin guard: lock, then refuse to
        // deactivate an active platform-admin unless another remains.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [OPERATOR_LOCK_KEY]
        );
        const target = await client.query<{ role: string; active: boolean }>(
          "SELECT role, active FROM lip_cloud_operators WHERE operator_id = $1",
          [input.operatorId]
        );
        const current = target.rows[0];
        if (current?.active && current.role === "platform-admin") {
          const admins = await client.query<{ count: string }>(
            "SELECT count(*) AS count FROM lip_cloud_operators " +
            "WHERE active AND role = 'platform-admin'"
          );
          if (Number(admins.rows[0]?.count ?? 0) <= 1) {
            throw new LastPlatformAdminError();
          }
        }
      }
      const result = await client.query(`
        UPDATE lip_cloud_operators
        SET active = COALESCE($2, active), updated_at = $3
        WHERE operator_id = $1
        RETURNING *
      `, [input.operatorId, input.active ?? null, input.updatedAt]);
      const row = result.rows[0];
      if (!row) return undefined;
      await insertOperatorAudit(client, input.audit);
      return operatorRow(row);
    });
  }

  public async operatorApiKeys(operatorId: string): Promise<CloudOperatorApiKey[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_operator_api_keys
      WHERE operator_id = $1
      ORDER BY created_at
    `, [operatorId]);
    return result.rows.map(operatorKeyRow);
  }

  public async createOperatorApiKey(input: {
    key: CloudOperatorApiKey;
    audit: CloudOperatorAuditEntry;
  }): Promise<void> {
    await transaction(this.pool, async (client) => {
      await insertOperatorKey(client, input.key);
      await insertOperatorAudit(client, input.audit);
    });
  }

  public async rotateOperatorApiKey(input: {
    replacement: CloudOperatorApiKey;
    replacedKeyId: string;
    replacedExpiresAt: string;
    audits: CloudOperatorAuditEntry[];
  }): Promise<void> {
    await transaction(this.pool, async (client) => {
      const replaced = await client.query(`
        UPDATE lip_cloud_operator_api_keys
        SET expires_at = $2
        WHERE key_id = $1
        RETURNING key_id
      `, [input.replacedKeyId, input.replacedExpiresAt]);
      if (!replaced.rows[0]) throw new Error("Rotated operator key was not found");
      await insertOperatorKey(client, input.replacement);
      for (const audit of input.audits) {
        await insertOperatorAudit(client, audit);
      }
    });
  }

  public async revokeOperatorApiKey(input: {
    keyId: string;
    revokedAt: string;
    audit: CloudOperatorAuditEntry;
  }): Promise<CloudOperatorApiKey | undefined> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE lip_cloud_operator_api_keys
        SET active = false, revoked_at = $2
        WHERE key_id = $1
        RETURNING *
      `, [input.keyId, input.revokedAt]);
      const row = result.rows[0];
      if (!row) return undefined;
      await insertOperatorAudit(client, input.audit);
      return operatorKeyRow(row);
    });
  }

  public async operatorByApiKeyHash(secretHash: string): Promise<
    { operator: CloudOperator; api_key: CloudOperatorApiKey } | undefined
  > {
    const result = await this.pool.query(`
      SELECT
        key.*,
        operator.subject, operator.email, operator.role,
        operator.organization_ids,
        operator.active AS operator_active,
        operator.created_at AS operator_created_at,
        operator.updated_at AS operator_updated_at
      FROM lip_cloud_operator_api_keys key
      JOIN lip_cloud_operators operator
        ON operator.operator_id = key.operator_id
      WHERE key.secret_hash = $1
        -- Defense in depth: the store never surfaces a
        -- revoked, expired, or inactive key, or a key on an inactive operator,
        -- independent of the service-layer checks.
        AND key.active
        AND key.revoked_at IS NULL
        AND (key.expires_at IS NULL OR key.expires_at > now())
        AND operator.active
    `, [secretHash]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      operator: operatorRow({
        operator_id: row["operator_id"],
        subject: row["subject"],
        email: row["email"],
        role: row["role"],
        organization_ids: row["organization_ids"],
        active: row["operator_active"],
        created_at: row["operator_created_at"],
        updated_at: row["operator_updated_at"]
      }),
      api_key: operatorKeyRow(row)
    };
  }

  public async markOperatorApiKeyUsed(keyId: string, usedAt: string): Promise<void> {
    await this.pool.query(`
      UPDATE lip_cloud_operator_api_keys
      SET last_used_at = $2
      WHERE key_id = $1
    `, [keyId, usedAt]);
  }

  public async operatorAuditEntries(): Promise<CloudOperatorAuditEntry[]> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_operator_audit ORDER BY occurred_at DESC"
    );
    return result.rows.map(operatorAuditRow);
  }
}
