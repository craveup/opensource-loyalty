import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  CredentialHandoffEnvelope,
  CredentialOperationKind,
  CredentialOperationRecord,
  CredentialOperationState,
  CredentialOperationStore
} from "./credential-operations.js";

interface CredentialOperationRow extends QueryResultRow {
  credential_operation_id: string;
  environment_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  operation: CredentialOperationKind;
  state: CredentialOperationState;
  actor_subject: string;
  issued_key_id: string | null;
  replaced_key_expires_at: Date | null;
  handoff_envelope: CredentialHandoffEnvelope | null;
  handoff_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function toRecord(row: CredentialOperationRow): CredentialOperationRecord {
  return {
    credential_operation_id: row.credential_operation_id,
    environment_id: row.environment_id,
    idempotency_key: row.idempotency_key,
    request_fingerprint: row.request_fingerprint,
    operation: row.operation,
    state: row.state,
    actor_subject: row.actor_subject,
    ...(row.issued_key_id ? { issued_key_id: row.issued_key_id } : {}),
    ...(row.replaced_key_expires_at
      ? { replaced_key_expires_at: row.replaced_key_expires_at.toISOString() }
      : {}),
    ...(row.handoff_envelope ? { handoff_envelope: row.handoff_envelope } : {}),
    ...(row.handoff_expires_at
      ? { handoff_expires_at: row.handoff_expires_at.toISOString() }
      : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    created_at: row.created_at.toISOString(),
    ...(row.completed_at ? { completed_at: row.completed_at.toISOString() } : {})
  };
}

export interface PostgresCredentialOperationStoreOptions {
  connectionString?: string;
  pool?: Pool;
}

export class PostgresCredentialOperationStore implements CredentialOperationStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  public constructor(options: PostgresCredentialOperationStoreOptions) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
      return;
    }
    this.pool = new Pool(
      options.connectionString ? { connectionString: options.connectionString } : {}
    );
    this.ownsPool = true;
  }

  /**
   * One statement decides the race.
   *
   * `ON CONFLICT DO NOTHING` returning no row is the signal that someone else
   * owns this idempotency key; the follow-up read then reports whose. Doing this
   * as a check-then-insert would let two concurrent first attempts both find
   * nothing and both mint a merchant key.
   */
  public async claim(record: CredentialOperationRecord): Promise<
    { status: "claimed"; record: CredentialOperationRecord } |
    { status: "existing"; record: CredentialOperationRecord }
  > {
    const inserted = await this.pool.query<CredentialOperationRow>(`
      INSERT INTO lip_cloud_credential_operations (
        credential_operation_id, environment_id, idempotency_key, request_fingerprint,
        operation, state, actor_subject, created_at
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
      ON CONFLICT (environment_id, idempotency_key) DO NOTHING
      RETURNING *
    `, [
      record.credential_operation_id,
      record.environment_id,
      record.idempotency_key,
      record.request_fingerprint,
      record.operation,
      record.actor_subject,
      record.created_at
    ]);
    const claimed = inserted.rows[0];
    if (claimed) return { status: "claimed", record: toRecord(claimed) };
    const existing = await this.pool.query<CredentialOperationRow>(`
      SELECT * FROM lip_cloud_credential_operations
      WHERE environment_id = $1 AND idempotency_key = $2
    `, [record.environment_id, record.idempotency_key]);
    const found = existing.rows[0];
    if (!found) {
      // The conflicting row was deleted between the two statements (a cascade
      // from an environment removal). Treat it as a lost race rather than
      // inventing a claim we do not hold.
      throw new Error("The credential operation disappeared while being claimed");
    }
    return { status: "existing", record: toRecord(found) };
  }

  public async recordIssuedKey(input: {
    credentialOperationId: string;
    issuedKeyId: string;
  }): Promise<void> {
    await this.pool.query(`
      UPDATE lip_cloud_credential_operations
      SET issued_key_id = $2
      WHERE credential_operation_id = $1
    `, [input.credentialOperationId, input.issuedKeyId]);
  }

  public async complete(input: {
    credentialOperationId: string;
    issuedKeyId: string;
    replacedKeyExpiresAt?: string;
    handoffEnvelope: CredentialHandoffEnvelope;
    handoffExpiresAt: string;
    completedAt: string;
  }): Promise<void> {
    await this.pool.query(`
      UPDATE lip_cloud_credential_operations
      SET state = 'issued',
          issued_key_id = $2,
          replaced_key_expires_at = $3,
          handoff_envelope = $4::jsonb,
          handoff_expires_at = $5,
          completed_at = $6,
          last_error = NULL
      WHERE credential_operation_id = $1
    `, [
      input.credentialOperationId,
      input.issuedKeyId,
      input.replacedKeyExpiresAt ?? null,
      JSON.stringify(input.handoffEnvelope),
      input.handoffExpiresAt,
      input.completedAt
    ]);
  }

  public async fail(input: {
    credentialOperationId: string;
    message: string;
    completedAt: string;
  }): Promise<void> {
    await this.pool.query(`
      UPDATE lip_cloud_credential_operations
      SET state = 'failed', last_error = $2, completed_at = $3
      WHERE credential_operation_id = $1
    `, [input.credentialOperationId, input.message.slice(0, 500), input.completedAt]);
  }

  public async reopen(input: { credentialOperationId: string }): Promise<void> {
    await this.pool.query(`
      UPDATE lip_cloud_credential_operations
      SET state = 'pending', issued_key_id = NULL, last_error = NULL, completed_at = NULL
      WHERE credential_operation_id = $1
    `, [input.credentialOperationId]);
  }

  public async findById(
    credentialOperationId: string
  ): Promise<CredentialOperationRecord | undefined> {
    const result = await this.pool.query<CredentialOperationRow>(
      "SELECT * FROM lip_cloud_credential_operations WHERE credential_operation_id = $1",
      [credentialOperationId]
    );
    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }

  public async purgeExpiredHandoffs(now: string): Promise<number> {
    const result = await this.pool.query(`
      UPDATE lip_cloud_credential_operations
      SET handoff_envelope = NULL
      WHERE handoff_envelope IS NOT NULL AND handoff_expires_at <= $1
    `, [now]);
    return result.rowCount ?? 0;
  }

  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

/** In-memory equivalent for tests and the memory control plane. */
export class MemoryCredentialOperationStore implements CredentialOperationStore {
  private readonly records = new Map<string, CredentialOperationRecord>();

  public async claim(record: CredentialOperationRecord): Promise<
    { status: "claimed"; record: CredentialOperationRecord } |
    { status: "existing"; record: CredentialOperationRecord }
  > {
    const existing = [...this.records.values()].find((candidate) =>
      candidate.environment_id === record.environment_id &&
      candidate.idempotency_key === record.idempotency_key
    );
    if (existing) return { status: "existing", record: { ...existing } };
    this.records.set(record.credential_operation_id, { ...record });
    return { status: "claimed", record: { ...record } };
  }

  public async recordIssuedKey(input: {
    credentialOperationId: string;
    issuedKeyId: string;
  }): Promise<void> {
    this.update(input.credentialOperationId, (record) => ({
      ...record,
      issued_key_id: input.issuedKeyId
    }));
  }

  public async complete(input: {
    credentialOperationId: string;
    issuedKeyId: string;
    replacedKeyExpiresAt?: string;
    handoffEnvelope: CredentialHandoffEnvelope;
    handoffExpiresAt: string;
    completedAt: string;
  }): Promise<void> {
    this.update(input.credentialOperationId, (record) => {
      const { last_error: _ignored, ...rest } = record;
      return {
        ...rest,
        state: "issued",
        issued_key_id: input.issuedKeyId,
        ...(input.replacedKeyExpiresAt
          ? { replaced_key_expires_at: input.replacedKeyExpiresAt }
          : {}),
        handoff_envelope: input.handoffEnvelope,
        handoff_expires_at: input.handoffExpiresAt,
        completed_at: input.completedAt
      };
    });
  }

  public async fail(input: {
    credentialOperationId: string;
    message: string;
    completedAt: string;
  }): Promise<void> {
    this.update(input.credentialOperationId, (record) => ({
      ...record,
      state: "failed",
      last_error: input.message,
      completed_at: input.completedAt
    }));
  }

  public async reopen(input: { credentialOperationId: string }): Promise<void> {
    this.update(input.credentialOperationId, (record) => {
      const {
        issued_key_id: _key,
        last_error: _error,
        completed_at: _completed,
        ...rest
      } = record;
      return { ...rest, state: "pending" };
    });
  }

  public async findById(
    credentialOperationId: string
  ): Promise<CredentialOperationRecord | undefined> {
    const record = this.records.get(credentialOperationId);
    return record ? { ...record } : undefined;
  }

  public async purgeExpiredHandoffs(now: string): Promise<number> {
    let purged = 0;
    for (const [id, record] of this.records) {
      if (!record.handoff_envelope || !record.handoff_expires_at) continue;
      if (Date.parse(record.handoff_expires_at) > Date.parse(now)) continue;
      const { handoff_envelope: _envelope, ...rest } = record;
      this.records.set(id, rest);
      purged += 1;
    }
    return purged;
  }

  private update(
    credentialOperationId: string,
    change: (record: CredentialOperationRecord) => CredentialOperationRecord
  ): void {
    const record = this.records.get(credentialOperationId);
    if (!record) throw new Error(`Unknown credential operation ${credentialOperationId}`);
    this.records.set(credentialOperationId, change(record));
  }
}

export type { PoolClient };
