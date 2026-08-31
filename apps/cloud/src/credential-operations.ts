import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { CloudError } from "./service.js";

const HANDOFF_AAD_PREFIX = "lip-cloud-credential-handoff/v1";
const HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type CredentialOperationKind = "create" | "rotate";
export type CredentialOperationState = "pending" | "issued" | "failed";

/** What a caller receives, and what is re-served verbatim on an honest retry. */
export interface MerchantCredentialHandoff {
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  admin_url: string;
  merchant_api_key: string;
  merchant_api_key_id: string;
  replaced_api_key_expires_at?: string;
  issued_at: string;
}

export interface CredentialHandoffEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  key_id: string;
  iv: string;
  authentication_tag: string;
  ciphertext: string;
}

export interface CredentialOperationRecord {
  credential_operation_id: string;
  environment_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  operation: CredentialOperationKind;
  state: CredentialOperationState;
  actor_subject: string;
  issued_key_id?: string;
  replaced_key_expires_at?: string;
  handoff_envelope?: CredentialHandoffEnvelope;
  handoff_expires_at?: string;
  last_error?: string;
  created_at: string;
  completed_at?: string;
}

export interface CredentialOperationStore {
  /**
   * Claims the idempotency key, or returns the record that already owns it.
   * The insert and the read must be one atomic step: two concurrent first
   * attempts that both "checked then inserted" would both mint a key.
   */
  claim(record: CredentialOperationRecord): Promise<
    { status: "claimed"; record: CredentialOperationRecord } |
    { status: "existing"; record: CredentialOperationRecord }
  >;
  recordIssuedKey(input: {
    credentialOperationId: string;
    issuedKeyId: string;
  }): Promise<void>;
  complete(input: {
    credentialOperationId: string;
    issuedKeyId: string;
    replacedKeyExpiresAt?: string;
    handoffEnvelope: CredentialHandoffEnvelope;
    handoffExpiresAt: string;
    completedAt: string;
  }): Promise<void>;
  fail(input: {
    credentialOperationId: string;
    message: string;
    completedAt: string;
  }): Promise<void>;
  /** Re-opens a recovered operation for another attempt, clearing the orphan reference. */
  reopen(input: { credentialOperationId: string }): Promise<void>;
  findById(credentialOperationId: string): Promise<CredentialOperationRecord | undefined>;
  /** Erases expired handoffs, keeping the operation and audit metadata. Returns the count. */
  purgeExpiredHandoffs(now: string): Promise<number>;
}

/** Mints or rotates the environment's merchant credential and can revoke an orphan. */
export interface MerchantCredentialIssuer {
  issueMerchantCredential(
    environmentId: string,
    options: { subject: string; overlap_seconds?: number }
  ): Promise<{
    environment_id: string;
    tenant_id: string;
    program_id: string;
    api_url: string;
    admin_url: string;
    merchant_api_key: string;
    merchant_api_key_id: string;
    replaced_api_key_expires_at?: string;
  }>;
  revokeMerchantKey(environmentId: string, keyId: string): Promise<void>;
}

export function credentialEncryptionKey(value: string | Buffer): Buffer {
  if (typeof value === "string" && !/^[A-Za-z0-9_-]{43}$/.test(value.trim())) {
    throw new Error("LIP_CLOUD_CREDENTIAL_KEY must be an unpadded 32-byte base64url value");
  }
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value.trim(), "base64url");
  if (key.length !== 32) {
    throw new Error("LIP_CLOUD_CREDENTIAL_KEY must be exactly 32 bytes");
  }
  return key;
}

function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Binds the ciphertext to the environment and the operation that produced it.
 *
 * Without this, an envelope lifted from one row and pasted into another would
 * still decrypt: the retry path would hand environment A's live merchant key to
 * whoever asked about environment B.
 */
function handoffAad(environmentId: string, credentialOperationId: string): Buffer {
  return Buffer.from(`${HANDOFF_AAD_PREFIX}:${environmentId}:${credentialOperationId}`);
}

export function encryptHandoff(input: {
  handoff: MerchantCredentialHandoff;
  key: Buffer;
  credentialOperationId: string;
}): CredentialHandoffEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(handoffAad(input.handoff.environment_id, input.credentialOperationId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.handoff), "utf8"),
    cipher.final()
  ]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    key_id: keyFingerprint(input.key),
    iv: iv.toString("base64url"),
    authentication_tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

export function decryptHandoff(input: {
  envelope: CredentialHandoffEnvelope;
  key: Buffer;
  environmentId: string;
  credentialOperationId: string;
}): MerchantCredentialHandoff {
  if (input.envelope.key_id !== keyFingerprint(input.key)) {
    // A rotated encryption key cannot decrypt older handoffs. That is not an
    // error to paper over: the credential is unreachable and the caller must
    // issue a new one.
    throw new CloudError(
      410,
      "credential_handoff_expired",
      "The stored credential handoff was encrypted with a different key"
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      input.key,
      Buffer.from(input.envelope.iv, "base64url")
    );
    decipher.setAAD(handoffAad(input.environmentId, input.credentialOperationId));
    decipher.setAuthTag(Buffer.from(input.envelope.authentication_tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(input.envelope.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext) as MerchantCredentialHandoff;
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError(
      410,
      "credential_handoff_expired",
      "The stored credential handoff could not be authenticated"
    );
  }
}

/** A stable hash of everything that makes this request the request it is. */
export function requestFingerprint(input: {
  environmentId: string;
  operation: CredentialOperationKind;
  overlapSeconds?: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      environment_id: input.environmentId,
      operation: input.operation,
      overlap_seconds: input.overlapSeconds ?? null
    }))
    .digest("hex");
}

export function assertIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!key) {
    throw new CloudError(
      400,
      "idempotency_key_required",
      "Idempotency-Key is required for merchant credential operations"
    );
  }
  if (key.length > 255 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new CloudError(
      400,
      "idempotency_key_invalid",
      "Idempotency-Key must be at most 255 characters of [A-Za-z0-9._:-]"
    );
  }
  return key;
}

export interface ManagedCredentialServiceOptions {
  store: CredentialOperationStore;
  issuer: MerchantCredentialIssuer;
  encryptionKey: string | Buffer;
  now?: () => Date;
  newId?: () => string;
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * Makes merchant-credential issuance survive the failures that actually happen
 * to it: a lost response, a duplicate submit, a crash mid-issue, and two
 * operators clicking at once.
 */
export class ManagedCredentialService {
  private readonly store: CredentialOperationStore;
  private readonly issuer: MerchantCredentialIssuer;
  private readonly key: Buffer;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly onEvent: (event: Record<string, unknown>) => void;
  /**
   * One in-flight issuance per (environment, idempotency key).
   *
   * Without this, six concurrent submissions of the same request all find the
   * row in `pending`, all conclude a previous attempt crashed, and all mint --
   * six live owner keys for one intent. Sharing the promise makes them share
   * the answer instead.
   *
   * This is also what makes the crash-recovery rule below sound: because a
   * concurrent caller in this process never reaches the store, a `pending`
   * record observed by a fresh call can only be the residue of a process that
   * died. That reasoning depends on `instance_policy: "single"` and must be
   * replaced by a database lease before this service runs on more than one
   * instance.
   */
  private readonly inFlight = new Map<string, Promise<MerchantCredentialHandoff>>();

  public constructor(options: ManagedCredentialServiceOptions) {
    this.store = options.store;
    this.issuer = options.issuer;
    this.key = credentialEncryptionKey(options.encryptionKey);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.onEvent = options.onEvent ?? ((event) => console.log(JSON.stringify(event)));
  }

  public async issue(input: {
    environmentId: string;
    idempotencyKey: string;
    operation: CredentialOperationKind;
    subject: string;
    overlapSeconds?: number;
  }): Promise<MerchantCredentialHandoff> {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    // The fingerprint belongs in the key. Sharing a flight on the idempotency
    // key alone would hand a caller whose payload *differs* the other request's
    // credential, silently, instead of the 409 the store would have raised --
    // the conflict check lives behind the claim, so a joined flight never
    // reaches it. Including the fingerprint means identical requests still
    // share one mint while a conflicting one goes to the store and is refused.
    const flightKey = `${input.environmentId}:${idempotencyKey}:${requestFingerprint({
      environmentId: input.environmentId,
      operation: input.operation,
      ...(input.overlapSeconds === undefined ? {} : { overlapSeconds: input.overlapSeconds })
    })}`;
    const existing = this.inFlight.get(flightKey);
    if (existing) return existing;
    const flight = this.issueExclusive({ ...input, idempotencyKey }).finally(() => {
      if (this.inFlight.get(flightKey) === flight) this.inFlight.delete(flightKey);
    });
    this.inFlight.set(flightKey, flight);
    return flight;
  }

  private async issueExclusive(input: {
    environmentId: string;
    idempotencyKey: string;
    operation: CredentialOperationKind;
    subject: string;
    overlapSeconds?: number;
  }): Promise<MerchantCredentialHandoff> {
    const idempotencyKey = input.idempotencyKey;
    const fingerprint = requestFingerprint({
      environmentId: input.environmentId,
      operation: input.operation,
      ...(input.overlapSeconds === undefined ? {} : { overlapSeconds: input.overlapSeconds })
    });
    const claimed = await this.store.claim({
      credential_operation_id: this.newId(),
      environment_id: input.environmentId,
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      operation: input.operation,
      state: "pending",
      actor_subject: input.subject,
      created_at: this.now().toISOString()
    });

    if (claimed.status === "claimed") {
      return this.mint({
        environmentId: input.environmentId,
        subject: input.subject,
        record: claimed.record,
        ...(input.overlapSeconds === undefined ? {} : { overlapSeconds: input.overlapSeconds })
      });
    }

    const existing = claimed.record;
    if (existing.request_fingerprint !== fingerprint) {
      throw new CloudError(
        409,
        "idempotency_conflict",
        "This Idempotency-Key was already used for a different credential request"
      );
    }
    if (existing.state === "issued") return this.replay(existing);
    // A pending record means an earlier attempt did not finish. It may have
    // minted a live owner key that nobody ever received; recovery has to
    // destroy that key before minting its replacement, or the environment ends
    // up with a valid credential outside anyone's control.
    return this.recover(existing);
  }

  private replay(record: CredentialOperationRecord): MerchantCredentialHandoff {
    if (!record.handoff_envelope || !record.handoff_expires_at) {
      throw new CloudError(
        410,
        "credential_handoff_expired",
        "The credential for this Idempotency-Key is no longer retrievable; issue a new one"
      );
    }
    if (Date.parse(record.handoff_expires_at) <= this.now().getTime()) {
      throw new CloudError(
        410,
        "credential_handoff_expired",
        "The credential for this Idempotency-Key is no longer retrievable; issue a new one"
      );
    }
    return decryptHandoff({
      envelope: record.handoff_envelope,
      key: this.key,
      environmentId: record.environment_id,
      credentialOperationId: record.credential_operation_id
    });
  }

  private async recover(record: CredentialOperationRecord): Promise<MerchantCredentialHandoff> {
    if (record.issued_key_id) {
      // Best effort: the key may already be gone (a previous recovery, a
      // tenant-side revocation). What must not happen is minting a
      // replacement while an unclaimed one is still live, so a revocation
      // failure aborts rather than continuing.
      await this.issuer.revokeMerchantKey(record.environment_id, record.issued_key_id);
      this.onEvent({
        event: "cloud_credential_orphan_revoked",
        credential_operation_id: record.credential_operation_id,
        environment_id: record.environment_id,
        key_id: record.issued_key_id
      });
    }
    await this.store.reopen({ credentialOperationId: record.credential_operation_id });
    // Zero overlap on recovery: any predecessor is an orphan nobody holds, and
    // keeping it alive "just in case" keeps an unclaimed credential working.
    return this.mint({
      environmentId: record.environment_id,
      subject: record.actor_subject,
      record,
      overlapSeconds: 0
    });
  }

  private async mint(input: {
    environmentId: string;
    subject: string;
    record: CredentialOperationRecord;
    overlapSeconds?: number;
  }): Promise<MerchantCredentialHandoff> {
    const record = input.record;
    let issued;
    try {
      issued = await this.issuer.issueMerchantCredential(input.environmentId, {
        subject: input.subject,
        ...(input.overlapSeconds === undefined ? {} : { overlap_seconds: input.overlapSeconds })
      });
    } catch (error) {
      await this.store.fail({
        credentialOperationId: record.credential_operation_id,
        message: error instanceof Error ? error.message : String(error),
        completedAt: this.now().toISOString()
      });
      throw error;
    }
    // Record the identity first and separately. If the process dies before the
    // response is persisted, this is what makes the live key findable.
    await this.store.recordIssuedKey({
      credentialOperationId: record.credential_operation_id,
      issuedKeyId: issued.merchant_api_key_id
    });
    const issuedAt = this.now();
    const handoff: MerchantCredentialHandoff = {
      environment_id: issued.environment_id,
      tenant_id: issued.tenant_id,
      program_id: issued.program_id,
      api_url: issued.api_url,
      admin_url: issued.admin_url,
      merchant_api_key: issued.merchant_api_key,
      merchant_api_key_id: issued.merchant_api_key_id,
      ...(issued.replaced_api_key_expires_at
        ? { replaced_api_key_expires_at: issued.replaced_api_key_expires_at }
        : {}),
      issued_at: issuedAt.toISOString()
    };
    await this.store.complete({
      credentialOperationId: record.credential_operation_id,
      issuedKeyId: issued.merchant_api_key_id,
      ...(issued.replaced_api_key_expires_at
        ? { replacedKeyExpiresAt: issued.replaced_api_key_expires_at }
        : {}),
      handoffEnvelope: encryptHandoff({
        handoff,
        key: this.key,
        credentialOperationId: record.credential_operation_id
      }),
      handoffExpiresAt: new Date(issuedAt.getTime() + HANDOFF_RETENTION_MS).toISOString(),
      completedAt: issuedAt.toISOString()
    });
    this.onEvent({
      event: "cloud_credential_issued",
      credential_operation_id: record.credential_operation_id,
      environment_id: issued.environment_id,
      key_id: issued.merchant_api_key_id,
      operation: record.operation
    });
    return handoff;
  }

  /** Erases handoffs past their retention window, keeping the audit record. */
  public async purgeExpiredHandoffs(): Promise<number> {
    return this.store.purgeExpiredHandoffs(this.now().toISOString());
  }
}

export const CREDENTIAL_HANDOFF_RETENTION_MS = HANDOFF_RETENTION_MS;
