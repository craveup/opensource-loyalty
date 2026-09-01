import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { StateStoreStatus } from "@loyalty-interchange/storage";
import {
  createPostgresProtocolPlatform,
  createReferenceRequestHandler,
  type AccessControlService,
  type PostgresProtocolPlatform,
  type ReferenceRequestHandler,
  type TenantPrincipal
} from "@loyalty-interchange/server";
import { EngineError } from "@loyalty-interchange/reference";
import { createBootstrapProgram, isBootstrapProgram } from "./bootstrap-program.js";
import type { CloudProvisioner } from "./provisioning.js";
import { CloudError } from "./service.js";
import type {
  CloudEnvironment,
  CloudProvisioningJob,
  CloudProvisioningResult,
  EnvironmentCredentialRotationOptions
} from "./types.js";

const MERCHANT_KEY_NAME = "cloud-merchant";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUNTIME_PREFIX = "/runtime/v1/environments/";

export interface ManagedDataPlaneOptions {
  /**
   * The environment's Neon database. Every tenant runtime stores its state in
   * row-scoped tables here; there is no per-tenant database and no disk.
   */
  connectionString: string;
  /**
   * Public origin of this deployment, used to build the path-scoped URLs handed
   * to merchants. Required: a managed runtime that guesses its own address
   * hands out URLs nobody can reach.
   */
  publicBaseUrl: string;
  /** Reads the authoritative environment record. Never cached across requests. */
  environmentById: (environmentId: string) => Promise<CloudEnvironment | undefined>;
  /** Every environment this process must have running. Used on boot. */
  readyEnvironments: () => Promise<CloudEnvironment[]>;
  /** Shared pg pool. Supplying one keeps a many-tenant process inside Neon's connection budget. */
  pool?: Pool;
  /**
   * Builds the tenant platform. Overridden only by tests, which exercise
   * routing, single-flight, restoration and eviction without a database; the
   * production path is the Postgres platform below.
   */
  createPlatform?: (environment: CloudEnvironment) => Promise<ManagedTenantPlatform>;
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * What a tenant runtime needs from its platform, stated structurally so the
 * managed manager does not depend on the storage driver underneath. The
 * Postgres platform is what production supplies; the narrower type is what lets
 * a test mount a real, working runtime without a database.
 */
export type ManagedTenantPlatform =
  Omit<PostgresProtocolPlatform, "store" | "telemetry" | "close"> & {
    store: { status: StateStoreStatus };
    close(): Promise<void> | void;
  };

export interface ManagedRuntimeDescriptor {
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  admin_url: string;
}

export interface IssuedMerchantCredential extends ManagedRuntimeDescriptor {
  merchant_api_key: string;
  merchant_api_key_id: string;
  replaced_api_key_expires_at?: string;
}

interface ManagedRuntime {
  descriptor: ManagedRuntimeDescriptor;
  handler: ReferenceRequestHandler;
  access: AccessControlService;
  platform: ManagedTenantPlatform;
  close(): Promise<void>;
}

/** The environment segment plus the remainder of the path, or undefined when the prefix does not match. */
export function parseRuntimePath(
  rawUrl: string
): { environmentId: string; forwarded: string } | undefined {
  const url = new URL(rawUrl, "http://runtime.local");
  if (!url.pathname.startsWith(RUNTIME_PREFIX)) return undefined;
  const remainder = url.pathname.slice(RUNTIME_PREFIX.length);
  const separator = remainder.indexOf("/");
  const environmentId = separator === -1 ? remainder : remainder.slice(0, separator);
  if (!SAFE_ID.test(environmentId)) return undefined;
  // Only the validated prefix is removed. Everything after it -- including a
  // path that itself contains "/runtime/v1/environments/" -- is forwarded
  // verbatim, so a crafted path cannot re-enter routing as another tenant.
  const path = separator === -1 ? "/" : remainder.slice(separator) || "/";
  return { environmentId, forwarded: `${path}${url.search}` };
}

/**
 * Runs every managed tenant runtime in this process against one shared Neon
 * database, behind one shared listener.
 *
 * What this replaces is worth stating plainly: the previous managed provisioner
 * gave each environment its own TCP port, its own SQLite file, its own
 * credentials file on disk, and a JSON port registry to remember it all. That
 * design needs a Render disk, cannot survive a filesystem it does not own, and
 * makes the URL a merchant depends on a function of local state. Here the
 * environment id *is* the address, every byte of durable state is a row, and a
 * cold process rebuilds itself from the database alone.
 */
export class ManagedPostgresDataPlaneManager implements CloudProvisioner {
  private readonly options: ManagedDataPlaneOptions;
  private readonly runtimes = new Map<string, Promise<ManagedRuntime>>();
  /** Runtimes that finished starting, for callers that cannot await (see runtimeDescriptors). */
  private readonly started = new Map<string, ManagedRuntime>();
  private readonly rotations = new Map<string, Promise<unknown>>();
  private closed = false;

  public constructor(options: ManagedDataPlaneOptions) {
    if (!options.connectionString.trim()) {
      throw new Error("A managed data-plane connection string is required");
    }
    this.options = { ...options, publicBaseUrl: normalizeBaseUrl(options.publicBaseUrl) };
  }

  public apiUrlFor(environmentId: string): string {
    if (!SAFE_ID.test(environmentId)) throw new Error("environment_id is invalid");
    return `${this.options.publicBaseUrl}${RUNTIME_PREFIX}${environmentId}`;
  }

  public async provision(input: {
    environment: CloudEnvironment;
    job: CloudProvisioningJob;
  }): Promise<CloudProvisioningResult> {
    if (input.job.operation !== "create") {
      throw new Error(
        `The managed data-plane manager only provisions create operations (received ${input.job.operation})`
      );
    }
    const runtime = await this.runtimeFor(input.environment);
    return { api_url: runtime.descriptor.api_url, admin_url: runtime.descriptor.admin_url };
  }

  /**
   * Brings every ready environment back up.
   *
   * This is not an optimisation. Campaign, membership and engagement schedulers
   * and the webhook dispatcher's pending queue only run inside a live runtime,
   * so an environment nobody has sent a request to yet would silently stop
   * delivering until someone happened to touch it.
   */
  public async restore(): Promise<ManagedRuntimeDescriptor[]> {
    const restored: ManagedRuntimeDescriptor[] = [];
    for (const environment of await this.options.readyEnvironments()) {
      // One tenant whose state cannot be loaded must not keep every other
      // tenant offline: record it and continue.
      try {
        const runtime = await this.runtimeFor(environment);
        restored.push(runtime.descriptor);
      } catch (error) {
        this.emit({
          event: "managed_runtime_restore_failed",
          environment_id: environment.environment_id,
          tenant_id: environment.tenant_id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return restored;
  }

  /** True when the request was a runtime request and has been answered. */
  public async handleRuntimeRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    const parsed = parseRuntimePath(request.url ?? "/");
    if (!parsed) return false;
    let runtime: ManagedRuntime;
    try {
      runtime = await this.runtimeForRequest(parsed.environmentId);
    } catch (error) {
      const failure = error instanceof CloudError
        ? error
        : new CloudError(503, "runtime_unavailable", "The environment runtime is unavailable");
      if (!(error instanceof CloudError)) {
        this.emit({
          event: "managed_runtime_request_failed",
          environment_id: parsed.environmentId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      sendRuntimeProblem(response, failure);
      return true;
    }
    request.url = parsed.forwarded;
    runtime.handler(request, response);
    return true;
  }

  private async runtimeForRequest(environmentId: string): Promise<ManagedRuntime> {
    const environment = await this.options.environmentById(environmentId);
    // A suspended, failed, deleted or never-provisioned environment is refused
    // on the authoritative record, re-read per request. A cached runtime must
    // never outlive the status that authorized it.
    if (!environment) {
      throw new CloudError(404, "environment_not_found", "The environment does not exist");
    }
    if (environment.status !== "ready") {
      throw new CloudError(
        409,
        "environment_not_ready",
        `The environment is ${environment.status}`
      );
    }
    return this.runtimeFor(environment);
  }

  public runtimeDescriptors(): ManagedRuntimeDescriptor[] {
    return [...this.started.values()].map((runtime) => ({ ...runtime.descriptor }));
  }

  /** Enrolls a Crave customer through the same transactional tenant runtime as HTTP traffic. */
  public async enrollCustomer(input: {
    tenantId: string;
    programId: string;
    customerId: string;
    idempotencyKey: string;
  }): Promise<{ member_id: string }> {
    const matches = (await this.options.readyEnvironments()).filter((candidate) =>
      candidate.tenant_id === input.tenantId &&
      candidate.program_id === input.programId
    );
    if (matches.length !== 1) {
      throw new CloudError(
        503,
        "customer_loyalty_runtime_unavailable",
        matches.length === 0
          ? "Customer loyalty runtime is unavailable"
          : "Customer loyalty runtime ownership is ambiguous"
      );
    }
    const runtime = await this.runtimeFor(matches[0]!);
    if (isBootstrapProgram(runtime.platform.programs.activeProgram())) {
      throw new CloudError(
        409,
        "program_not_configured",
        "Publish a loyalty program before enrolling customers"
      );
    }
    const enrolled = await runtime.platform.executeEngineOperation(() =>
      runtime.platform.engine.enroll({
        context: {
          protocol_version: "1.0",
          profile: "foodservice/1.0",
          request_id: input.idempotencyKey.slice(0, 128),
          idempotency_key: input.idempotencyKey,
          occurred_at: new Date().toISOString(),
          source: { system: "lip-cloud-customer-gateway", instance: "server" }
        },
        program_id: input.programId,
        identity: { type: "external", value: input.customerId },
        member_id: input.customerId
      })
    );
    return { member_id: enrolled.member.member_id };
  }

  /** Stops a runtime without touching its rows; a later request restarts it. */
  public async suspend(environmentId: string): Promise<void> {
    const pending = this.runtimes.get(environmentId);
    if (!pending) return;
    this.runtimes.delete(environmentId);
    this.started.delete(environmentId);
    const runtime = await pending.catch(() => undefined);
    await runtime?.close();
  }

  /**
   * Mints a replacement merchant key through the environment's own
   * access-control service and returns the secret exactly once.
   *
   * Serialized per environment: two concurrent rotations would each rotate the
   * key the other just replaced and leave an orphaned lineage nobody holds.
   */
  public async issueMerchantCredential(
    environmentId: string,
    options: Pick<EnvironmentCredentialRotationOptions, "subject"> & { overlap_seconds?: number }
  ): Promise<IssuedMerchantCredential> {
    const previous = this.rotations.get(environmentId) ?? Promise.resolve();
    const next = previous.then(
      () => this.issueExclusive(environmentId, options),
      () => this.issueExclusive(environmentId, options)
    );
    this.rotations.set(environmentId, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * Revokes a key the control plane failed to hand back.
   *
   * A crash between minting and persisting the response leaves a live owner key
   * nobody has ever seen. It is not enough to forget it: it authenticates.
   */
  public async revokeMerchantKey(environmentId: string, keyId: string): Promise<void> {
    const runtime = await this.runtimeForRequest(environmentId);
    await runtime.access.revokeApiKey(keyId, runtime.access.rootPrincipal());
  }

  private async issueExclusive(
    environmentId: string,
    options: Pick<EnvironmentCredentialRotationOptions, "subject"> & { overlap_seconds?: number }
  ): Promise<IssuedMerchantCredential> {
    const runtime = await this.runtimeForRequest(environmentId);
    const principal: TenantPrincipal = options.subject
      ? { ...runtime.access.rootPrincipal(), actor_id: `cloud:${options.subject}` }
      : runtime.access.rootPrincipal();
    const overlap = options.overlap_seconds === undefined
      ? {}
      : { overlap_seconds: options.overlap_seconds };
    const rotated = await this.rotateOrAdopt(runtime.access, principal, overlap);
    return {
      ...runtime.descriptor,
      merchant_api_key: rotated.secret,
      merchant_api_key_id: rotated.api_key.key_id,
      ...(rotated.replaced_api_key?.expires_at
        ? { replaced_api_key_expires_at: rotated.replaced_api_key.expires_at }
        : {})
    };
  }

  /**
   * Rotates the standing `cloud-merchant` lineage, or mints it the first time.
   *
   * Adopting rather than always minting is what keeps a lost or self-rotated
   * credential from accumulating parallel owner keys: at most one standing
   * (no-expiry) key survives, and overlap remnants age out on their own.
   */
  private async rotateOrAdopt(
    access: AccessControlService,
    principal: TenantPrincipal,
    overlap: { overlap_seconds?: number }
  ): Promise<{
    api_key: { key_id: string; expires_at?: string };
    secret: string;
    replaced_api_key?: { expires_at?: string };
  }> {
    const standing = access.snapshot().api_keys.find((key) =>
      key.name === MERCHANT_KEY_NAME && key.active && !key.expires_at
    );
    if (!standing) {
      const minted = await access.createApiKey(
        { name: MERCHANT_KEY_NAME, role: "owner" },
        principal
      );
      return { api_key: minted.api_key, secret: minted.secret };
    }
    try {
      return await access.rotateApiKey({ key_id: standing.key_id, ...overlap }, principal);
    } catch (error) {
      // A bad overlap is the caller's to fix; a key that vanished between the
      // snapshot and the rotation is ours, and minting recovers it.
      if (error instanceof EngineError && error.code === "validation_failed") throw error;
      const minted = await access.createApiKey(
        { name: MERCHANT_KEY_NAME, role: "owner" },
        principal
      );
      return { api_key: minted.api_key, secret: minted.secret };
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.runtimes.values()];
    this.runtimes.clear();
    this.started.clear();
    for (const entry of pending) {
      const runtime = await entry.catch(() => undefined);
      await runtime?.close();
    }
  }

  /**
   * Single-flight start: concurrent first requests for one environment share
   * one initialization instead of each building a platform, a scheduler set and
   * a webhook dispatcher against the same rows.
   *
   * A failed start is evicted rather than cached, so a transient database
   * outage during boot does not pin the environment to a rejected promise for
   * the life of the process.
   */
  private async runtimeFor(environment: CloudEnvironment): Promise<ManagedRuntime> {
    if (this.closed) {
      throw new CloudError(503, "runtime_unavailable", "The managed runtime is shutting down");
    }
    const existing = this.runtimes.get(environment.environment_id);
    if (existing) return existing;
    const starting: Promise<ManagedRuntime> = this.startRuntime(environment).then(
      (runtime) => {
        if (this.runtimes.get(environment.environment_id) === starting) {
          this.started.set(environment.environment_id, runtime);
        }
        return runtime;
      },
      (error: unknown) => {
        if (this.runtimes.get(environment.environment_id) === starting) {
          this.runtimes.delete(environment.environment_id);
        }
        throw error;
      }
    );
    this.runtimes.set(environment.environment_id, starting);
    return starting;
  }

  private async startRuntime(environment: CloudEnvironment): Promise<ManagedRuntime> {
    if (!SAFE_ID.test(environment.tenant_id) || !SAFE_ID.test(environment.program_id)) {
      throw new Error(`Environment ${environment.environment_id} has an unsafe tenant or program id`);
    }
    // The root key is generated per process and never persisted, logged or
    // returned. Merchants authenticate through the tenant's own access-control
    // keys; nothing outside this process can present root authority.
    const rootKey = `lip_sk_${randomBytes(32).toString("base64url")}`;
    // webhooks: [] keeps host-level LIP_WEBHOOK_URL/SECRET out of tenant
    // runtimes -- subscriptions and their signing secrets are tenant-owned.
    const platform = await (this.options.createPlatform ?? ((target: CloudEnvironment) =>
      createPostgresProtocolPlatform({
        connectionString: this.options.connectionString,
        ...(this.options.pool ? { pool: this.options.pool } : {}),
        tenantId: target.tenant_id,
        program: createBootstrapProgram(target.program_id),
        seed: false,
        webhooks: []
      })))(environment);
    try {
      const active = platform.programs.activeProgram();
      if (active.program_id !== environment.program_id) {
        throw new Error(
          `Environment ${environment.environment_id} is bound to ${environment.program_id} but its stored program is ${active.program_id}`
        );
      }
      const handler = createReferenceRequestHandler(platform.engine, {
        apiKey: rootKey,
        mountPath: `${RUNTIME_PREFIX}${environment.environment_id}`,
        reservationTtlSeconds: active.reservation_ttl_seconds ?? 120,
        executeEngineOperation: platform.executeEngineOperation,
        readEngineSnapshot: platform.readEngineSnapshot,
        protocolWriteGuard: () => isBootstrapProgram(platform.programs.activeProgram())
          ? {
              status: 409,
              code: "program_not_configured",
              title: "Loyalty program not configured",
              detail: "Publish a loyalty program before accepting protocol mutations"
            }
          : undefined,
        admin: {
          ...(platform.adminAssetRoot ? { assetRoot: platform.adminAssetRoot } : {}),
          storage: platform.store.status,
          programs: platform.programs,
          campaigns: platform.campaigns,
          customerData: platform.customerData,
          memberships: platform.memberships,
          access: platform.access,
          engagement: platform.engagement,
          locations: platform.locations,
          webhookManager: platform.webhooks
        }
      });
      const apiUrl = this.apiUrlFor(environment.environment_id);
      const runtime: ManagedRuntime = {
        descriptor: {
          environment_id: environment.environment_id,
          tenant_id: environment.tenant_id,
          program_id: environment.program_id,
          // Protocol and Admin share one base URL because they share one
          // listener and one path prefix; the routes below it differ.
          api_url: apiUrl,
          admin_url: apiUrl
        },
        handler,
        access: platform.access,
        platform,
        close: () => Promise.resolve(platform.close())
      };
      this.emit({
        event: "managed_runtime_started",
        environment_id: environment.environment_id,
        tenant_id: environment.tenant_id,
        program_id: environment.program_id,
        api_url: apiUrl
      });
      return runtime;
    } catch (error) {
      await Promise.resolve(platform.close());
      throw error;
    }
  }

  private emit(event: Record<string, unknown>): void {
    if (this.options.onEvent) {
      this.options.onEvent(event);
      return;
    }
    console.log(JSON.stringify(event));
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error("LIP_CLOUD_PUBLIC_BASE_URL is required for managed provisioning");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The managed public base URL must be http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The managed public base URL must not carry credentials, a query or a fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function sendRuntimeProblem(response: ServerResponse, error: CloudError): void {
  const payload = JSON.stringify({
    type: `https://opensource-loyalty.dev/problems/${error.code}`,
    title: error.code.replace(/_/g, " "),
    status: error.status,
    detail: error.message,
    code: error.code
  });
  response.writeHead(error.status, {
    "content-type": "application/problem+json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  response.end(payload);
}
