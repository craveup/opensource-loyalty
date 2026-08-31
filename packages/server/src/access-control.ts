import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { EngineError } from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";
import { assertLocationId } from "./location-ids.js";

export type TenantRole = "owner" | "admin" | "operator" | "developer" | "viewer" | "integration";
export type TenantPermission =
  | "admin:read"
  | "admin:write"
  | "program:publish"
  | "access:manage"
  | "platform:read"
  | "platform:write"
  | "protocol:read"
  | "protocol:write";

const rolePermissions: Record<TenantRole, TenantPermission[]> = {
  owner: [
    "admin:read", "admin:write", "program:publish", "access:manage",
    "platform:read", "platform:write",
    "protocol:read", "protocol:write"
  ],
  admin: [
    "admin:read", "admin:write", "program:publish", "access:manage",
    "platform:read", "platform:write",
    "protocol:read", "protocol:write"
  ],
  operator: [
    "admin:read", "admin:write", "platform:read", "platform:write",
    "protocol:read", "protocol:write"
  ],
  developer: [
    "admin:read", "platform:read", "platform:write", "protocol:read", "protocol:write"
  ],
  viewer: ["admin:read", "platform:read"],
  integration: ["platform:read", "platform:write", "protocol:read", "protocol:write"]
};

export interface Tenant {
  tenant_id: string;
  name: string;
  created_at: string;
}

export interface TenantUser {
  user_id: string;
  tenant_id: string;
  email: string;
  name?: string;
  role: TenantRole;
  active: boolean;
  created_at: string;
  updated_at: string;
  /** Locations this user may see in scoped Admin views. Absent = all locations. */
  allowed_location_ids?: string[];
}

export interface TenantApiKey {
  key_id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  role: TenantRole;
  active: boolean;
  created_at: string;
  expires_at?: string;
  last_used_at?: string;
  revoked_at?: string;
  /** Locations this key may see in scoped Admin views. Absent = all locations. */
  allowed_location_ids?: string[];
  secret_hash: string;
}

export interface TenantPrincipal {
  tenant_id: string;
  actor_id: string;
  actor_type: "root" | "api_key" | "user";
  role: TenantRole;
  permissions: TenantPermission[];
  /** Location scope resolved from the user or API key. Absent = all locations. */
  allowed_location_ids?: string[];
}

export interface TenantAuditEntry {
  audit_id: string;
  tenant_id: string;
  actor_id: string;
  actor_type: TenantPrincipal["actor_type"];
  action: string;
  resource_type: string;
  resource_id?: string;
  request_id?: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

export interface AccessControlState {
  version: 1;
  tenant: Tenant;
  users: TenantUser[];
  api_keys: TenantApiKey[];
  audit: TenantAuditEntry[];
}

export interface AccessControlSnapshot {
  tenant: Tenant;
  users: TenantUser[];
  api_keys: Array<Omit<TenantApiKey, "secret_hash">>;
  audit: TenantAuditEntry[];
  role_permissions: Record<TenantRole, TenantPermission[]>;
}

export interface AccessControlServiceOptions {
  store: AsyncStateStore<AccessControlState>;
  tenantId: string;
  tenantName: string;
  reset?: boolean;
}

/** Default validity overlap for a replaced key after rotation. */
export const DEFAULT_ROTATION_OVERLAP_SECONDS = 86_400;
/** Upper bound on the rotation overlap window (7 days). */
export const MAX_ROTATION_OVERLAP_SECONDS = 604_800;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Mints a fresh API-key secret with its stored prefix and hash. */
function mintApiKeySecret(): { secret: string; prefix: string; secret_hash: string } {
  const secret = `lip_sk_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 15), secret_hash: hashSecret(secret) };
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Normalizes an optional allowed-location list: trims entries, removes
 * duplicates, validates each id against the protocol id constraints, and
 * rejects lists that resolve to nothing (an empty scope would silently lock
 * the principal out of every scoped view).
 */
function normalizeAllowedLocationIds(input: string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  const normalized = [...new Set(input.map((value) => value.trim()).filter((value) => value.length > 0))];
  if (normalized.length === 0) {
    throw new EngineError(
      "validation_failed",
      "allowed_location_ids must contain at least one non-empty location id",
      422
    );
  }
  for (const locationId of normalized) {
    assertLocationId(locationId, "allowed_location_ids entries");
  }
  return normalized;
}

export class AccessControlService {
  private readonly store: AsyncStateStore<AccessControlState>;
  private state: AccessControlState;
  private revision: number;

  private constructor(
    options: AccessControlServiceOptions,
    state: AccessControlState,
    revision: number
  ) {
    this.store = options.store;
    this.state = state;
    this.revision = revision;
  }

  public static async create(options: AccessControlServiceOptions): Promise<AccessControlService> {
    if (options.reset) await options.store.clear();
    const loaded = await options.store.load();
    const state = loaded?.state ?? {
      version: 1 as const,
      tenant: {
        tenant_id: options.tenantId,
        name: options.tenantName,
        created_at: now()
      },
      users: [],
      api_keys: [],
      audit: []
    };
    if (state.version !== 1 || state.tenant.tenant_id !== options.tenantId) {
      await options.store.close();
      throw new Error("Access-control state is incompatible with this tenant");
    }
    const service = new AccessControlService(options, state, loaded?.revision ?? 0);
    await service.save();
    return service;
  }

  public rootPrincipal(): TenantPrincipal {
    return {
      tenant_id: this.state.tenant.tenant_id,
      actor_id: "root",
      actor_type: "root",
      role: "owner",
      permissions: [...rolePermissions.owner]
    };
  }

  public async authenticate(secret: string): Promise<TenantPrincipal | undefined> {
    const candidateHash = hashSecret(secret);
    const key = this.state.api_keys.find((candidate) =>
      candidate.active &&
      (!candidate.expires_at || Date.parse(candidate.expires_at) > Date.now()) &&
      secretsEqual(candidate.secret_hash, candidateHash)
    );
    if (!key) return undefined;
    const used: TenantApiKey = { ...key, last_used_at: now() };
    this.state = {
      ...this.state,
      api_keys: this.state.api_keys.map((candidate) =>
        candidate.key_id === used.key_id ? used : candidate
      )
    };
    await this.save();
    return {
      tenant_id: used.tenant_id,
      actor_id: used.key_id,
      actor_type: "api_key",
      role: used.role,
      permissions: [...rolePermissions[used.role]],
      ...(used.allowed_location_ids
        ? { allowed_location_ids: [...used.allowed_location_ids] }
        : {})
    };
  }

  public hasPermission(
    principal: TenantPrincipal,
    permission: TenantPermission
  ): boolean {
    return principal.tenant_id === this.state.tenant.tenant_id &&
      principal.permissions.includes(permission);
  }

  public snapshot(): AccessControlSnapshot {
    return structuredClone({
      tenant: this.state.tenant,
      users: this.state.users,
      api_keys: this.state.api_keys.map(({ secret_hash: _secretHash, ...key }) => key),
      audit: this.state.audit,
      role_permissions: rolePermissions
    });
  }

  public principalForUser(userId: string): TenantPrincipal | undefined {
    const user = this.state.users.find((candidate) =>
      candidate.user_id === userId && candidate.active
    );
    if (!user) return undefined;
    return {
      tenant_id: user.tenant_id,
      actor_id: user.user_id,
      actor_type: "user",
      role: user.role,
      permissions: [...rolePermissions[user.role]],
      ...(user.allowed_location_ids
        ? { allowed_location_ids: [...user.allowed_location_ids] }
        : {})
    };
  }

  /**
   * Location scope for Admin queries and reporting: undefined means the
   * principal may see every location; otherwise only the returned location
   * ids. Root principals and principals from another tenant are never scoped
   * down here — cross-tenant callers are rejected by permission checks.
   */
  public locationScopeFor(principal: TenantPrincipal): string[] | undefined {
    if (principal.actor_type === "root") return undefined;
    return principal.allowed_location_ids
      ? [...principal.allowed_location_ids]
      : undefined;
  }

  public async upsertUser(input: {
    user_id?: string;
    email: string;
    name?: string;
    role: TenantRole;
    active?: boolean;
    /** Omit to preserve the stored scope; null clears it explicitly. */
    allowed_location_ids?: string[] | null;
  }, principal: TenantPrincipal): Promise<TenantUser> {
    this.requirePermission(principal, "access:manage");
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) {
      throw new EngineError("validation_failed", "A valid user email is required", 422);
    }
    this.assertRole(input.role);
    const timestamp = now();
    const userId = input.user_id ?? `user_${randomUUID()}`;
    const existing = this.state.users.find((user) => user.user_id === userId);
    const duplicate = this.state.users.find((user) =>
      user.user_id !== userId && user.email === email
    );
    if (duplicate) throw new EngineError("conflict", "User email already exists", 409);
    const allowedLocationIds = input.allowed_location_ids === undefined
      ? existing?.allowed_location_ids
      : input.allowed_location_ids === null
        ? undefined
        : normalizeAllowedLocationIds(input.allowed_location_ids);
    this.assertWithinPrincipalScope(principal, allowedLocationIds);
    const user: TenantUser = {
      user_id: userId,
      tenant_id: this.state.tenant.tenant_id,
      email,
      role: input.role,
      active: input.active ?? existing?.active ?? true,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(allowedLocationIds ? { allowed_location_ids: allowedLocationIds } : {})
    };
    this.state = {
      ...this.state,
      users: existing
        ? this.state.users.map((candidate) =>
            candidate.user_id === userId ? user : candidate
          )
        : [user, ...this.state.users]
    };
    await this.recordAudit(principal, "access.user.upserted", "user", userId, {
      role: user.role,
      active: user.active,
      ...(user.allowed_location_ids
        ? { allowed_location_ids: user.allowed_location_ids }
        : input.allowed_location_ids === null
          ? { allowed_location_ids: null }
          : {})
    });
    return structuredClone(user);
  }

  public async createApiKey(input: {
    name: string;
    role: TenantRole;
    expires_at?: string;
    allowed_location_ids?: string[];
  }, principal: TenantPrincipal): Promise<{
    api_key: Omit<TenantApiKey, "secret_hash">;
    secret: string;
  }> {
    this.requirePermission(principal, "access:manage");
    this.assertRole(input.role);
    if (!input.name.trim()) {
      throw new EngineError("validation_failed", "API key name is required", 422);
    }
    if (
      input.expires_at &&
      (!Number.isFinite(Date.parse(input.expires_at)) ||
        Date.parse(input.expires_at) <= Date.now())
    ) {
      throw new EngineError("validation_failed", "API key expiration must be in the future", 422);
    }
    const allowedLocationIds = normalizeAllowedLocationIds(input.allowed_location_ids);
    this.assertWithinPrincipalScope(principal, allowedLocationIds);
    const { secret, prefix, secret_hash } = mintApiKeySecret();
    const timestamp = now();
    const key: TenantApiKey = {
      key_id: `key_${randomUUID()}`,
      tenant_id: this.state.tenant.tenant_id,
      name: input.name.trim(),
      prefix,
      role: input.role,
      active: true,
      created_at: timestamp,
      ...(input.expires_at
        ? { expires_at: new Date(input.expires_at).toISOString() }
        : {}),
      ...(allowedLocationIds ? { allowed_location_ids: allowedLocationIds } : {}),
      secret_hash
    };
    this.state = {
      ...this.state,
      api_keys: [key, ...this.state.api_keys]
    };
    await this.recordAudit(principal, "access.api_key.created", "api_key", key.key_id, {
      role: key.role,
      prefix: key.prefix,
      ...(key.allowed_location_ids
        ? { allowed_location_ids: key.allowed_location_ids }
        : {})
    });
    const { secret_hash: _secretHash, ...publicKey } = key;
    return { api_key: structuredClone(publicKey), secret };
  }

  /**
   * Mints a replacement for an active API key (same name, role, and location
   * scope; fresh secret) and bounds the old key's remaining validity to an
   * overlap window so consumers can swap credentials without a flag-day
   * cutover. `overlap_seconds: 0` expires the old key immediately; an
   * existing sooner expiry is never widened. The replacement inherits the
   * rotated key's expiry unless an explicit earlier `expires_at` shortens
   * it — rotation can never extend a key's lifetime. Both keys are audited.
   */
  public async rotateApiKey(input: {
    key_id: string;
    /** Old-key validity after rotation, 0..604800 s. Defaults to 24 h. */
    overlap_seconds?: number;
    /** Optional replacement expiry; must not be later than the existing one. */
    expires_at?: string;
  }, principal: TenantPrincipal): Promise<{
    api_key: Omit<TenantApiKey, "secret_hash">;
    secret: string;
    replaced_api_key: Omit<TenantApiKey, "secret_hash">;
  }> {
    this.requirePermission(principal, "access:manage");
    const overlapSeconds = input.overlap_seconds ?? DEFAULT_ROTATION_OVERLAP_SECONDS;
    if (
      !Number.isInteger(overlapSeconds) ||
      overlapSeconds < 0 ||
      overlapSeconds > MAX_ROTATION_OVERLAP_SECONDS
    ) {
      throw new EngineError(
        "validation_failed",
        `overlap_seconds must be an integer between 0 and ${MAX_ROTATION_OVERLAP_SECONDS}`,
        422
      );
    }
    if (
      input.expires_at &&
      (!Number.isFinite(Date.parse(input.expires_at)) ||
        Date.parse(input.expires_at) <= Date.now())
    ) {
      throw new EngineError("validation_failed", "API key expiration must be in the future", 422);
    }
    const existing = this.state.api_keys.find((candidate) => candidate.key_id === input.key_id);
    if (!existing) throw new EngineError("not_found", "API key was not found", 404);
    if (
      !existing.active ||
      (existing.expires_at && Date.parse(existing.expires_at) <= Date.now())
    ) {
      throw new EngineError("conflict", "API key is not active", 409);
    }
    this.assertWithinPrincipalScope(principal, existing.allowed_location_ids);
    if (
      input.expires_at &&
      existing.expires_at &&
      Date.parse(input.expires_at) > Date.parse(existing.expires_at)
    ) {
      throw new EngineError(
        "validation_failed",
        "Rotation may shorten an API key's expiration but never extend it",
        422
      );
    }
    // Inherit the rotated key's expiry: rotating a time-boxed key must never
    // mint an immortal replacement.
    const replacementExpiresAt = input.expires_at
      ? new Date(input.expires_at).toISOString()
      : existing.expires_at;
    const { secret, prefix, secret_hash } = mintApiKeySecret();
    const timestamp = now();
    const replacement: TenantApiKey = {
      key_id: `key_${randomUUID()}`,
      tenant_id: this.state.tenant.tenant_id,
      name: existing.name,
      prefix,
      role: existing.role,
      active: true,
      created_at: timestamp,
      ...(replacementExpiresAt ? { expires_at: replacementExpiresAt } : {}),
      ...(existing.allowed_location_ids
        ? { allowed_location_ids: [...existing.allowed_location_ids] }
        : {}),
      secret_hash
    };
    const overlapExpiry = new Date(Date.now() + overlapSeconds * 1_000).toISOString();
    const replacedExpiresAt =
      existing.expires_at && Date.parse(existing.expires_at) < Date.parse(overlapExpiry)
        ? existing.expires_at
        : overlapExpiry;
    const replaced: TenantApiKey = { ...existing, expires_at: replacedExpiresAt };
    this.state = {
      ...this.state,
      api_keys: [
        replacement,
        ...this.state.api_keys.map((candidate) =>
          candidate.key_id === existing.key_id ? replaced : candidate
        )
      ]
    };
    // Both rotation audit entries land in one state save: the pair is atomic
    // and a crash can never persist half the story.
    this.appendAudit([
      this.makeAuditEntry(principal, "access.api_key.created", "api_key", replacement.key_id, {
        role: replacement.role,
        prefix: replacement.prefix,
        rotated_from: existing.key_id,
        ...(replacement.allowed_location_ids
          ? { allowed_location_ids: replacement.allowed_location_ids }
          : {})
      }),
      this.makeAuditEntry(principal, "access.api_key.rotated", "api_key", existing.key_id, {
        replacement_key_id: replacement.key_id,
        overlap_expires_at: replacedExpiresAt
      })
    ]);
    await this.save();
    const { secret_hash: _replacementHash, ...publicReplacement } = replacement;
    const { secret_hash: _replacedHash, ...publicReplaced } = replaced;
    return {
      api_key: structuredClone(publicReplacement),
      secret,
      replaced_api_key: structuredClone(publicReplaced)
    };
  }

  public async revokeApiKey(keyId: string, principal: TenantPrincipal): Promise<void> {
    this.requirePermission(principal, "access:manage");
    const key = this.state.api_keys.find((candidate) => candidate.key_id === keyId);
    if (!key) throw new EngineError("not_found", "API key was not found", 404);
    if (!key.active) return;
    const revoked: TenantApiKey = { ...key, active: false, revoked_at: now() };
    this.state = {
      ...this.state,
      api_keys: this.state.api_keys.map((candidate) =>
        candidate.key_id === keyId ? revoked : candidate
      )
    };
    await this.recordAudit(principal, "access.api_key.revoked", "api_key", keyId);
  }

  public async recordAudit(
    principal: TenantPrincipal,
    action: string,
    resourceType: string,
    resourceId?: string,
    metadata?: Record<string, unknown>,
    requestId?: string
  ): Promise<void> {
    this.appendAudit([
      this.makeAuditEntry(principal, action, resourceType, resourceId, metadata, requestId)
    ]);
    await this.save();
  }

  private makeAuditEntry(
    principal: TenantPrincipal,
    action: string,
    resourceType: string,
    resourceId?: string,
    metadata?: Record<string, unknown>,
    requestId?: string
  ): TenantAuditEntry {
    return {
      audit_id: `tenant-audit_${randomUUID()}`,
      tenant_id: this.state.tenant.tenant_id,
      actor_id: principal.actor_id,
      actor_type: principal.actor_type,
      action,
      resource_type: resourceType,
      occurred_at: now(),
      ...(resourceId ? { resource_id: resourceId } : {}),
      ...(metadata ? { metadata: structuredClone(metadata) } : {}),
      ...(requestId ? { request_id: requestId } : {})
    };
  }

  /** Prepends audit entries to the in-memory state without persisting. */
  private appendAudit(entries: TenantAuditEntry[]): void {
    this.state = {
      ...this.state,
      audit: [...entries, ...this.state.audit].slice(0, 1_000)
    };
  }

  public async close(): Promise<void> {
    await this.store.close();
  }

  /**
   * A location-scoped principal may only grant access that stays inside its
   * own scope: the effective scope of any user or API key it creates or
   * updates must be a non-empty subset of the creator's. Unscoped creators
   * are unrestricted.
   */
  private assertWithinPrincipalScope(
    principal: TenantPrincipal,
    allowedLocationIds: string[] | undefined
  ): void {
    const creatorScope = this.locationScopeFor(principal);
    if (!creatorScope) return;
    if (!allowedLocationIds || allowedLocationIds.length === 0) {
      throw new EngineError(
        "forbidden",
        "A location-scoped principal must grant a non-empty subset of its own location scope",
        403
      );
    }
    const escaped = allowedLocationIds.filter((locationId) =>
      !creatorScope.includes(locationId)
    );
    if (escaped.length > 0) {
      throw new EngineError(
        "forbidden",
        `Locations outside the caller's scope: ${escaped.join(", ")}`,
        403
      );
    }
  }

  private requirePermission(
    principal: TenantPrincipal,
    permission: TenantPermission
  ): void {
    if (!this.hasPermission(principal, permission)) {
      throw new EngineError("forbidden", `Permission ${permission} is required`, 403);
    }
  }

  private assertRole(role: string): asserts role is TenantRole {
    if (!(role in rolePermissions)) {
      throw new EngineError("validation_failed", `Unknown tenant role: ${role}`, 422);
    }
  }

  private async save(): Promise<void> {
    this.revision = await this.store.save(this.state, this.revision);
  }
}
