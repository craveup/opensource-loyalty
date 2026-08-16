import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertStrongApiKey,
  createDemoPlatform,
  createPostgresProtocolPlatform,
  startReferenceServer,
  type AccessControlService,
  type TenantPrincipal
} from "@loyalty-interchange/server";
import { EngineError, type ProgramDefinition } from "@loyalty-interchange/reference";
import type { CloudProvisioner } from "./provisioning.js";
import type {
  CloudEnvironment,
  CloudProvisioningJob,
  CloudProvisioningResult,
  EnvironmentCredentialRotationOptions
} from "./types.js";

export interface LocalDataPlaneProvisionerOptions {
  /**
   * Directory containing one `<program_id>.json` program definition per
   * provisionable program. Provisioning fails when the environment's program
   * has no definition here.
   */
  programDirectory: string;
  /**
   * Directory for per-environment SQLite databases, credential files, and the
   * port registry. Created on demand.
   */
  dataDirectory: string;
  /** 32-byte base64url key (or a 32-byte Buffer) used for AES-256-GCM. */
  credentialEncryptionKey: string | Buffer;
  /**
   * One-time migration switch for v1/v2 plaintext files. A restored legacy
   * file is immediately rewritten as an encrypted v3 envelope.
   */
  allowLegacyPlaintextCredentials?: boolean;
  /**
   * Optional Postgres connection string. When set, environments run against
   * tenant-scoped Postgres tables instead of per-environment SQLite files.
   */
  connectionString?: string;
  /** Listen host for provisioned runtimes. Defaults to 127.0.0.1. */
  host?: string;
  /**
   * First port in the stable allocation range. Defaults to 13210. Ports are
   * persisted in `<dataDirectory>/ports.json` so restarts reuse the same URL.
   */
  basePort?: number;
  /** Inclusive port range size starting at basePort. Defaults to 1000. */
  portRange?: number;
  /** Public base URL host used when writing credentials (defaults to host). */
  publicHost?: string;
  /** Called with the generated credential after a runtime starts. */
  onProvisioned?: (runtime: ProvisionedRuntime) => void;
}

export interface ProvisionedRuntime {
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  admin_url: string;
  /** DEPRECATED root runtime key. Hand out merchant_api_key instead. */
  api_key: string;
  /** Owner-role access-control key — the credential merchants receive. */
  merchant_api_key: string;
  merchant_api_key_id: string;
  credentials_path: string;
  port: number;
}

/**
 * v1 files carry only the root `api_key`; v2 adds the merchant access-control
 * key and marks the root key deprecated. v1 files are accepted on restore and
 * upgraded in place.
 */
export interface LocalCredentialFile {
  version?: number;
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  api_key: string;
  api_key_deprecated?: boolean;
  merchant_api_key?: string;
  merchant_api_key_id?: string;
  port: number;
}

export interface EncryptedCredentialEnvelope {
  version: 3;
  algorithm: "aes-256-gcm";
  key_id: string;
  environment_id: string;
  iv: string;
  authentication_tag: string;
  ciphertext: string;
}

export interface EncryptedBackupDatabase {
  algorithm: "aes-256-gcm";
  key_id: string;
  iv: string;
  authentication_tag: string;
  ciphertext: string;
}

export interface LocalEnvironmentBackup {
  format: "lip-cloud-local-backup";
  format_version: 1;
  created_at: string;
  environment_id: string;
  tenant_id: string;
  program_id: string;
  credential: EncryptedCredentialEnvelope;
  sqlite_database: EncryptedBackupDatabase;
  checksum: { algorithm: "sha256"; value: string };
}

interface RunningRuntime {
  runtime: ProvisionedRuntime;
  access: AccessControlService;
  close: () => Promise<void>;
}

const MERCHANT_KEY_NAME = "cloud-merchant";
const CREDENTIAL_AAD_PREFIX = "lip-cloud-credentials/v3";
const BACKUP_DATABASE_AAD_PREFIX = "lip-cloud-backup-database/v1";

function credentialKey(value: string | Buffer): Buffer {
  if (typeof value === "string" && !/^[A-Za-z0-9_-]{43}$/.test(value.trim())) {
    throw new Error(
      "credentialEncryptionKey text must be an unpadded 32-byte base64url value"
    );
  }
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value.trim(), "base64url");
  if (key.length !== 32) {
    throw new Error(
      "credentialEncryptionKey must be exactly 32 bytes (base64url when supplied as text)"
    );
  }
  return key;
}

function credentialKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function isEncryptedCredential(value: unknown): value is EncryptedCredentialEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["version"] === 3 &&
    record["algorithm"] === "aes-256-gcm" &&
    typeof record["key_id"] === "string" &&
    typeof record["environment_id"] === "string" &&
    typeof record["iv"] === "string" &&
    typeof record["authentication_tag"] === "string" &&
    typeof record["ciphertext"] === "string";
}

function encryptCredential(
  credential: LocalCredentialFile,
  key: Buffer
): EncryptedCredentialEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${CREDENTIAL_AAD_PREFIX}:${credential.environment_id}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), "utf8"),
    cipher.final()
  ]);
  return {
    version: 3,
    algorithm: "aes-256-gcm",
    key_id: credentialKeyId(key),
    environment_id: credential.environment_id,
    iv: iv.toString("base64url"),
    authentication_tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

function decryptCredential(
  envelope: EncryptedCredentialEnvelope,
  key: Buffer
): LocalCredentialFile {
  if (envelope.key_id !== credentialKeyId(key)) {
    throw new Error(`Credential key ${envelope.key_id} is not the configured key`);
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64url")
    );
    decipher.setAAD(Buffer.from(`${CREDENTIAL_AAD_PREFIX}:${envelope.environment_id}`));
    decipher.setAuthTag(Buffer.from(envelope.authentication_tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
    const credential = JSON.parse(plaintext) as LocalCredentialFile;
    if (credential.environment_id !== envelope.environment_id) {
      throw new Error("Credential environment binding does not match its envelope");
    }
    return credential;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Credential authentication failed: ${detail}`);
  }
}

function isEncryptedBackupDatabase(value: unknown): value is EncryptedBackupDatabase {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["algorithm"] === "aes-256-gcm" &&
    typeof record["key_id"] === "string" &&
    typeof record["iv"] === "string" &&
    typeof record["authentication_tag"] === "string" &&
    typeof record["ciphertext"] === "string";
}

function encryptBackupDatabase(
  database: Buffer,
  key: Buffer,
  environmentId: string,
  tenantId: string
): EncryptedBackupDatabase {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${BACKUP_DATABASE_AAD_PREFIX}:${environmentId}:${tenantId}`));
  const ciphertext = Buffer.concat([cipher.update(database), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    key_id: credentialKeyId(key),
    iv: iv.toString("base64url"),
    authentication_tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

function decryptBackupDatabase(
  database: EncryptedBackupDatabase,
  key: Buffer,
  environmentId: string,
  tenantId: string
): Buffer {
  if (database.key_id !== credentialKeyId(key)) {
    throw new Error(`Backup key ${database.key_id} is not the configured key`);
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(database.iv, "base64url")
    );
    decipher.setAAD(Buffer.from(`${BACKUP_DATABASE_AAD_PREFIX}:${environmentId}:${tenantId}`));
    decipher.setAuthTag(Buffer.from(database.authentication_tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(database.ciphertext, "base64url")),
      decipher.final()
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Backup database authentication failed: ${detail}`);
  }
}

/** Operator recovery helper; callers must protect the returned secrets. */
export async function readLocalCredential(
  path: string,
  encryptionKey: string | Buffer,
  options: { allowLegacyPlaintext?: boolean } = {}
): Promise<LocalCredentialFile> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (isEncryptedCredential(parsed)) {
    return decryptCredential(parsed, credentialKey(encryptionKey));
  }
  if (!options.allowLegacyPlaintext) {
    throw new Error(
      "Plaintext Cloud credentials are disabled; opt into one-time legacy migration"
    );
  }
  return parsed as LocalCredentialFile;
}

function generateApiKey(): string {
  return `lip_sk_${randomBytes(32).toString("base64url")}`;
}

function backupChecksum(value: Omit<LocalEnvironmentBackup, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeLocalId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid for local recovery`);
  }
  return value;
}

function preferredPort(environmentId: string, basePort: number, portRange: number): number {
  const digest = createHash("sha256").update(environmentId).digest();
  return basePort + (digest.readUInt32BE(0) % portRange);
}

/**
 * Runs LIP data-plane runtimes inside the control-plane process: one HTTP
 * server and one isolated store per environment. Ports and API keys are
 * persisted under the data directory so `restore()` can bring environments
 * back on the same URLs after a control-plane restart.
 */
export class LocalDataPlaneProvisioner implements CloudProvisioner {
  private readonly options: LocalDataPlaneProvisionerOptions;
  private readonly running = new Map<string, RunningRuntime>();
  /** Per-environment rotation mutex: concurrent rotations run one at a time. */
  private readonly rotationQueues = new Map<string, Promise<void>>();
  private readonly portsPath: string;
  private readonly basePort: number;
  private readonly portRange: number;
  private portAssignments = new Map<string, number>();
  private readonly encryptionKey: Buffer;

  public constructor(options: LocalDataPlaneProvisionerOptions) {
    if (!options.programDirectory.trim() || !options.dataDirectory.trim()) {
      throw new Error("Program and data directories are required");
    }
    this.options = options;
    this.encryptionKey = credentialKey(options.credentialEncryptionKey);
    this.basePort = options.basePort ?? 13_210;
    this.portRange = options.portRange ?? 1_000;
    if (this.portRange < 1) throw new Error("portRange must be at least 1");
    mkdirSync(resolve(options.dataDirectory), { recursive: true });
    this.portsPath = join(resolve(options.dataDirectory), "ports.json");
  }

  public async restore(): Promise<ProvisionedRuntime[]> {
    await this.loadPortRegistry();
    const restored: ProvisionedRuntime[] = [];
    const dataDir = resolve(this.options.dataDirectory);
    for (const name of readdirSync(dataDir)) {
      if (!name.endsWith(".credentials.json")) continue;
      // One weak, tampered, or unreadable credentials file must never abort
      // the loop and keep every other tenant offline: log it and move on.
      try {
        const runtime = await this.restoreCredentialFile(join(dataDir, name));
        if (runtime) restored.push(runtime);
      } catch (error) {
        console.error(JSON.stringify({
          event: "cloud_environment_restore_failed",
          credentials_file: name,
          environment_id: name.slice(0, -".credentials.json".length),
          message: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    return restored;
  }

  private async restoreCredentialFile(path: string): Promise<ProvisionedRuntime | undefined> {
    const credential = await readLocalCredential(path, this.encryptionKey, {
      allowLegacyPlaintext: Boolean(this.options.allowLegacyPlaintextCredentials)
    });
    if (!credential.environment_id || !credential.tenant_id || !credential.program_id) {
      return undefined;
    }
    if (this.running.has(credential.environment_id)) return undefined;
    const environment: CloudEnvironment = {
      environment_id: credential.environment_id,
      project_id: "restored",
      slug: credential.environment_id,
      name: credential.environment_id,
      kind: "development",
      region: "local",
      tenant_id: credential.tenant_id,
      program_id: credential.program_id,
      status: "ready",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
    const port = credential.port || this.portAssignments.get(credential.environment_id);
    return this.startRuntime(environment, {
      apiKey: credential.api_key,
      ...(credential.merchant_api_key && credential.merchant_api_key_id
        ? {
            merchantApiKey: credential.merchant_api_key,
            merchantApiKeyId: credential.merchant_api_key_id
          }
        : {}),
      ...(port ? { port } : {})
    });
  }

  public async provision(input: {
    environment: CloudEnvironment;
    job: CloudProvisioningJob;
  }): Promise<CloudProvisioningResult> {
    const { environment, job } = input;
    if (job.operation !== "create") {
      throw new Error(
        `The local data-plane provisioner only supports create operations (received ${job.operation})`
      );
    }
    const existing = this.running.get(environment.environment_id);
    if (existing) {
      return {
        api_url: existing.runtime.api_url,
        admin_url: existing.runtime.admin_url
      };
    }
    await this.loadPortRegistry();
    const credentialsPath = join(
      resolve(this.options.dataDirectory),
      `${environment.environment_id}.credentials.json`
    );
    let existingCredential: LocalCredentialFile | undefined;
    try {
      existingCredential = await readLocalCredential(credentialsPath, this.encryptionKey, {
        allowLegacyPlaintext: Boolean(this.options.allowLegacyPlaintextCredentials)
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existingCredential = undefined;
    }
    const port =
      existingCredential?.port ?? this.portAssignments.get(environment.environment_id);
    const runtime = await this.startRuntime(environment, {
      ...(existingCredential?.api_key ? { apiKey: existingCredential.api_key } : {}),
      ...(existingCredential?.merchant_api_key && existingCredential.merchant_api_key_id
        ? {
            merchantApiKey: existingCredential.merchant_api_key,
            merchantApiKeyId: existingCredential.merchant_api_key_id
          }
        : {}),
      ...(port ? { port } : {})
    });
    return { api_url: runtime.api_url, admin_url: runtime.admin_url };
  }

  public runtimes(): ProvisionedRuntime[] {
    return [...this.running.values()].map((entry) => ({ ...entry.runtime }));
  }

  /** Stops a local runtime without deleting its database or credentials. */
  public async suspend(environmentId: string): Promise<ProvisionedRuntime> {
    const entry = this.running.get(environmentId);
    if (!entry) throw new Error(`No running data-plane runtime exists for ${environmentId}`);
    this.running.delete(environmentId);
    try {
      await entry.close();
    } catch (error) {
      this.running.set(environmentId, entry);
      throw error;
    }
    return { ...entry.runtime };
  }

  /** Restarts a suspended local runtime from its authenticated credential file. */
  public async resume(environmentId: string): Promise<ProvisionedRuntime> {
    if (this.running.has(environmentId)) {
      throw new Error(`Data-plane runtime ${environmentId} is already running`);
    }
    await this.loadPortRegistry();
    const path = join(
      resolve(this.options.dataDirectory),
      `${safeLocalId(environmentId, "environment_id")}.credentials.json`
    );
    const runtime = await this.restoreCredentialFile(path);
    if (!runtime) throw new Error(`No credentials exist for ${environmentId}`);
    return runtime;
  }

  /**
   * Writes a checksummed, encrypted, point-in-time local SQLite backup. The
   * runtime is quiesced while the database is read and is resumed in `finally`.
   */
  public async backup(
    environmentId: string,
    outputPath: string,
    options: { force?: boolean; now?: () => Date } = {}
  ): Promise<LocalEnvironmentBackup> {
    if (this.options.connectionString) {
      throw new Error("Local backup is SQLite-only; use managed Postgres backups for this runtime");
    }
    const wasRunning = this.running.has(environmentId);
    if (wasRunning) await this.suspend(environmentId);
    try {
      const credentialPath = join(
        resolve(this.options.dataDirectory),
        `${safeLocalId(environmentId, "environment_id")}.credentials.json`
      );
      const rawEnvelope: unknown = JSON.parse(await readFile(credentialPath, "utf8"));
      if (!isEncryptedCredential(rawEnvelope)) {
        throw new Error("Backup requires an encrypted v3 credential file");
      }
      const credential = decryptCredential(rawEnvelope, this.encryptionKey);
      const databasePath = join(
        resolve(this.options.dataDirectory),
        `${safeLocalId(credential.tenant_id, "tenant_id")}.db`
      );
      const withoutChecksum = {
        format: "lip-cloud-local-backup" as const,
        format_version: 1 as const,
        created_at: (options.now ?? (() => new Date()))().toISOString(),
        environment_id: credential.environment_id,
        tenant_id: credential.tenant_id,
        program_id: credential.program_id,
        credential: rawEnvelope,
        sqlite_database: encryptBackupDatabase(
          await readFile(databasePath),
          this.encryptionKey,
          credential.environment_id,
          credential.tenant_id
        )
      };
      const backup: LocalEnvironmentBackup = {
        ...withoutChecksum,
        checksum: { algorithm: "sha256", value: backupChecksum(withoutChecksum) }
      };
      const target = resolve(outputPath);
      if (!options.force && existsSync(target)) {
        throw new Error(`Backup target already exists: ${target}`);
      }
      const temporary = `${target}.tmp-${randomBytes(6).toString("hex")}`;
      await writeFile(temporary, `${JSON.stringify(backup, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx"
      });
      try {
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      return backup;
    } finally {
      if (wasRunning) await this.resume(environmentId);
    }
  }

  /** Restores both SQLite data and encrypted credentials, then starts the runtime. */
  public async restoreBackup(
    backupPath: string,
    options: { force?: boolean } = {}
  ): Promise<ProvisionedRuntime> {
    const parsed: unknown = JSON.parse(await readFile(resolve(backupPath), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Local backup must be a JSON object");
    }
    const backup = parsed as LocalEnvironmentBackup;
    if (
      backup.format !== "lip-cloud-local-backup" ||
      backup.format_version !== 1 ||
      backup.checksum?.algorithm !== "sha256" ||
      !isEncryptedCredential(backup.credential) ||
      !isEncryptedBackupDatabase(backup.sqlite_database)
    ) {
      throw new Error("Local backup format is invalid or unsupported");
    }
    const { checksum, ...withoutChecksum } = backup;
    if (backupChecksum(withoutChecksum) !== checksum.value) {
      throw new Error("Local backup checksum does not match its contents");
    }
    const environmentId = safeLocalId(backup.environment_id, "environment_id");
    const tenantId = safeLocalId(backup.tenant_id, "tenant_id");
    if (this.running.has(environmentId)) {
      throw new Error(`Suspend ${environmentId} before restoring its backup`);
    }
    const decrypted = decryptCredential(backup.credential, this.encryptionKey);
    if (
      decrypted.environment_id !== environmentId ||
      decrypted.tenant_id !== tenantId ||
      decrypted.program_id !== backup.program_id
    ) {
      throw new Error("Backup metadata does not match its encrypted credentials");
    }
    const dataDirectory = resolve(this.options.dataDirectory);
    const databasePath = join(dataDirectory, `${tenantId}.db`);
    const credentialPath = join(dataDirectory, `${environmentId}.credentials.json`);
    if (!options.force && (existsSync(databasePath) || existsSync(credentialPath))) {
      throw new Error("Restore target exists; pass force only after preserving the current files");
    }
    const nonce = randomBytes(6).toString("hex");
    const databaseTemp = `${databasePath}.restore-${nonce}`;
    const credentialTemp = `${credentialPath}.restore-${nonce}`;
    const databasePrevious = `${databasePath}.previous-${nonce}`;
    const credentialPrevious = `${credentialPath}.previous-${nonce}`;
    await writeFile(databaseTemp, decryptBackupDatabase(
      backup.sqlite_database,
      this.encryptionKey,
      environmentId,
      tenantId
    ), {
      mode: 0o600,
      flag: "wx"
    });
    await writeFile(credentialTemp, `${JSON.stringify(backup.credential, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    let databaseMoved = false;
    let credentialMoved = false;
    try {
      if (existsSync(databasePath)) await rename(databasePath, databasePrevious);
      if (existsSync(credentialPath)) await rename(credentialPath, credentialPrevious);
      await rename(databaseTemp, databasePath);
      databaseMoved = true;
      await rename(credentialTemp, credentialPath);
      credentialMoved = true;
      await rm(databasePrevious, { force: true });
      await rm(credentialPrevious, { force: true });
    } catch (error) {
      if (databaseMoved) await rm(databasePath, { force: true });
      if (credentialMoved) await rm(credentialPath, { force: true });
      if (existsSync(databasePrevious)) await rename(databasePrevious, databasePath);
      if (existsSync(credentialPrevious)) await rename(credentialPrevious, credentialPath);
      throw error;
    } finally {
      await rm(databaseTemp, { force: true });
      await rm(credentialTemp, { force: true });
    }
    return this.resume(environmentId);
  }

  /**
   * Mints a replacement merchant key through the tenant's own access-control
   * service (bounded overlap on the old key, fully audited) and rewrites the
   * credentials file. This is the control-plane rotation surface: operators
   * receive the returned merchant key and never touch the root key.
   *
   * Rotations are serialized per environment (two concurrent calls would
   * otherwise both rotate the same pinned key and mint an orphaned lineage),
   * and a stale pinned key id — the tenant self-rotated, or the key expired —
   * recovers by re-adopting the live `cloud-merchant` lineage instead of
   * failing forever.
   */
  public async rotateCredentials(
    environmentId: string,
    options: EnvironmentCredentialRotationOptions | { subject?: undefined } = {}
  ): Promise<ProvisionedRuntime & { replaced_api_key_expires_at?: string }> {
    const previous = this.rotationQueues.get(environmentId) ?? Promise.resolve();
    const next = previous.then(
      () => this.rotateCredentialsExclusive(environmentId, options),
      () => this.rotateCredentialsExclusive(environmentId, options)
    );
    this.rotationQueues.set(environmentId, next.then(() => undefined, () => undefined));
    return next;
  }

  private async rotateCredentialsExclusive(
    environmentId: string,
    options: EnvironmentCredentialRotationOptions | { subject?: undefined }
  ): Promise<ProvisionedRuntime & { replaced_api_key_expires_at?: string }> {
    const entry = this.running.get(environmentId);
    if (!entry) {
      throw new Error(`No running data-plane runtime exists for ${environmentId}`);
    }
    // Attribute tenant-side audit entries to the acting cloud operator.
    const principal: TenantPrincipal = options.subject
      ? { ...entry.access.rootPrincipal(), actor_id: `cloud:${options.subject}` }
      : entry.access.rootPrincipal();
    const overlap = "overlap_seconds" in options && options.overlap_seconds !== undefined
      ? { overlap_seconds: options.overlap_seconds }
      : {};
    let rotated;
    try {
      rotated = await entry.access.rotateApiKey(
        { key_id: entry.runtime.merchant_api_key_id, ...overlap },
        principal
      );
    } catch (error) {
      // Validation problems (for example a bad overlap) are the caller's to
      // fix; only a dead pinned key falls back to lineage recovery.
      if (error instanceof EngineError && error.code === "validation_failed") throw error;
      rotated = await this.adoptMerchantLineage(entry.access, principal, overlap);
    }
    const runtime: ProvisionedRuntime = {
      ...entry.runtime,
      merchant_api_key: rotated.secret,
      merchant_api_key_id: rotated.api_key.key_id
    };
    await this.writeCredentials(runtime);
    this.running.set(environmentId, { ...entry, runtime });
    return {
      ...runtime,
      ...(rotated.replaced_api_key?.expires_at
        ? { replaced_api_key_expires_at: rotated.replaced_api_key.expires_at }
        : {})
    };
  }

  /**
   * Re-adopts the tenant's live `cloud-merchant` lineage: rotate the standing
   * (no-expiry) key when one exists; otherwise mint a fresh owner key — the
   * recovery path for self-rotated, expired, or lost credentials. Overlap
   * remnants (active but expiry-bounded keys) age out on their own, keeping
   * at most one standing lineage alive.
   */
  private async adoptMerchantLineage(
    access: AccessControlService,
    principal: TenantPrincipal,
    overlap: { overlap_seconds?: number } = {}
  ): Promise<{
    api_key: { key_id: string; expires_at?: string };
    secret: string;
    replaced_api_key?: { expires_at?: string };
  }> {
    const standing = access.snapshot().api_keys.find((key) =>
      key.name === MERCHANT_KEY_NAME && key.active && !key.expires_at
    );
    if (standing) {
      return access.rotateApiKey({ key_id: standing.key_id, ...overlap }, principal);
    }
    const minted = await access.createApiKey(
      { name: MERCHANT_KEY_NAME, role: "owner" },
      principal
    );
    return { api_key: minted.api_key, secret: minted.secret };
  }

  public async close(): Promise<void> {
    const entries = [...this.running.values()];
    this.running.clear();
    for (const entry of entries) await entry.close();
  }

  private async startRuntime(
    environment: CloudEnvironment,
    options: {
      apiKey?: string;
      merchantApiKey?: string;
      merchantApiKeyId?: string;
      port?: number;
    }
  ): Promise<ProvisionedRuntime> {
    const apiKey = options.apiKey?.trim() || generateApiKey();
    // Shared-cluster runtimes must never boot on a weak or default key, even
    // one smuggled in through a tampered or legacy credentials file.
    assertStrongApiKey(apiKey);
    const program = await this.loadProgram(environment.program_id);
    const port = await this.allocatePort(environment.environment_id, options.port);
    const host = this.options.host ?? "127.0.0.1";
    const publicHost = this.options.publicHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
    // webhooks: [] keeps host-level LIP_WEBHOOK_URL/SECRET env config out of
    // tenant runtimes — webhook subscriptions (and their signing secrets) are
    // always tenant-owned, created through each runtime's admin API.
    const platform = this.options.connectionString
      ? await createPostgresProtocolPlatform({
          connectionString: this.options.connectionString,
          tenantId: environment.tenant_id,
          program,
          seed: false,
          webhooks: []
        })
      : await createDemoPlatform({
          databasePath: join(
            resolve(this.options.dataDirectory),
            `${environment.tenant_id}.db`
          ),
          program,
          seed: false,
          webhooks: []
        });
    let server;
    try {
      server = await startReferenceServer(platform.engine, {
        apiKey,
        host,
        port,
        reservationTtlSeconds: program.reservation_ttl_seconds ?? 120,
        ...("executeEngineOperation" in platform
          ? {
              executeEngineOperation: platform.executeEngineOperation,
              readEngineSnapshot: platform.readEngineSnapshot
            }
          : { persistState: (state) => platform.store.save(state) }),
        // Credentials advertise admin_url, so wire the full Admin service
        // suite the platform constructed (mirrors the server CLI wiring).
        admin: {
          ...(platform.adminAssetRoot ? { assetRoot: platform.adminAssetRoot } : {}),
          storage: platform.store.status,
          programs: platform.programs,
          campaigns: platform.campaigns,
          memberships: platform.memberships,
          access: platform.access,
          engagement: platform.engagement,
          locations: platform.locations,
          webhookManager: platform.webhooks
        }
      });
    } catch (error) {
      await Promise.resolve(platform.close());
      throw error;
    }
    // The merchant key is minted only after the runtime is actually up: a
    // failed server start must never leave an orphaned owner key behind.
    let merchantApiKey = options.merchantApiKey;
    let merchantApiKeyId = options.merchantApiKeyId;
    let adoptedKeyId: string | undefined;
    if (!merchantApiKey || !merchantApiKeyId) {
      try {
        // Re-adopt the persisted lineage (rotate) when one exists — a lost
        // credentials file must not accumulate parallel owner keys.
        const adopted = await this.adoptMerchantLineage(
          platform.access,
          platform.access.rootPrincipal()
        );
        merchantApiKey = adopted.secret;
        merchantApiKeyId = adopted.api_key.key_id;
        adoptedKeyId = adopted.api_key.key_id;
      } catch (error) {
        await server.close();
        await Promise.resolve(platform.close());
        throw error;
      }
    }
    const apiUrl = `http://${publicHost}:${port}`;
    const runtime: ProvisionedRuntime = {
      environment_id: environment.environment_id,
      tenant_id: environment.tenant_id,
      program_id: environment.program_id,
      api_url: apiUrl,
      admin_url: `${apiUrl}/admin/`,
      api_key: apiKey,
      merchant_api_key: merchantApiKey,
      merchant_api_key_id: merchantApiKeyId,
      credentials_path: join(
        resolve(this.options.dataDirectory),
        `${environment.environment_id}.credentials.json`
      ),
      port
    };
    try {
      await this.writeCredentials(runtime);
      await this.savePortRegistry();
    } catch (error) {
      // Compensation: a credential that was never persisted or handed out
      // must not survive as a live orphan key.
      if (adoptedKeyId) {
        try {
          await platform.access.revokeApiKey(adoptedKeyId, platform.access.rootPrincipal());
        } catch (revokeError) {
          console.error(JSON.stringify({
            event: "cloud_merchant_key_revocation_failed",
            environment_id: environment.environment_id,
            key_id: adoptedKeyId,
            message: revokeError instanceof Error ? revokeError.message : String(revokeError)
          }));
        }
      }
      await server.close();
      await Promise.resolve(platform.close());
      throw error;
    }
    this.running.set(environment.environment_id, {
      runtime,
      access: platform.access,
      close: async () => {
        await server.close();
        await Promise.resolve(platform.close());
      }
    });
    this.options.onProvisioned?.(runtime);
    return runtime;
  }

  private async writeCredentials(runtime: ProvisionedRuntime): Promise<void> {
    const credential: Required<Omit<LocalCredentialFile, "version">> & { version: number } = {
      version: 2,
      environment_id: runtime.environment_id,
      tenant_id: runtime.tenant_id,
      program_id: runtime.program_id,
      api_url: runtime.api_url,
      api_key: runtime.api_key,
      api_key_deprecated: true,
      merchant_api_key: runtime.merchant_api_key,
      merchant_api_key_id: runtime.merchant_api_key_id,
      port: runtime.port
    };
    // Atomic replace (temp file + rename): a crash mid-write must never leave
    // a truncated or corrupted credentials file behind.
    const tempPath = `${runtime.credentials_path}.tmp`;
    await writeFile(
      tempPath,
      `${JSON.stringify(encryptCredential(credential, this.encryptionKey), undefined, 2)}\n`,
      { mode: 0o600 }
    );
    try {
      await rename(tempPath, runtime.credentials_path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async allocatePort(environmentId: string, preferred?: number): Promise<number> {
    const used = new Set(this.portAssignments.values());
    for (const entry of this.running.values()) used.add(entry.runtime.port);
    const candidates = [
      ...(preferred && preferred >= this.basePort && preferred < this.basePort + this.portRange
        ? [preferred]
        : []),
      preferredPort(environmentId, this.basePort, this.portRange),
      ...Array.from({ length: this.portRange }, (_, index) => this.basePort + index)
    ];
    for (const candidate of candidates) {
      if (this.portAssignments.get(environmentId) === candidate || !used.has(candidate)) {
        this.portAssignments.set(environmentId, candidate);
        return candidate;
      }
    }
    throw new Error(
      `No free data-plane ports remain in ${this.basePort}-${this.basePort + this.portRange - 1}`
    );
  }

  private async loadPortRegistry(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.portsPath, "utf8")) as Record<string, number>;
      this.portAssignments = new Map(
        Object.entries(raw).filter((entry): entry is [string, number] =>
          typeof entry[1] === "number"
        )
      );
    } catch {
      this.portAssignments = new Map();
    }
  }

  private async savePortRegistry(): Promise<void> {
    await writeFile(
      this.portsPath,
      `${JSON.stringify(Object.fromEntries(this.portAssignments), undefined, 2)}\n`,
      { mode: 0o600 }
    );
  }

  private async loadProgram(programId: string): Promise<ProgramDefinition> {
    const path = join(resolve(this.options.programDirectory), `${programId}.json`);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new Error(
        `No program definition exists for ${programId}; add ${path} before provisioning`
      );
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Program file ${path} must contain a JSON object`);
    }
    const program = parsed as ProgramDefinition;
    if (program.program_id !== programId) {
      throw new Error(
        `Program file ${path} defines ${program.program_id}, expected ${programId}`
      );
    }
    return program;
  }
}
