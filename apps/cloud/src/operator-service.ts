import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_ROTATION_OVERLAP_SECONDS,
  MAX_ROTATION_OVERLAP_SECONDS
} from "@loyalty-interchange/server";
import { CloudError } from "./service.js";
import {
  CloudRepositoryConflictError,
  LastPlatformAdminError,
  TRUSTED_GATEWAY_ISSUER,
  type CloudOperator,
  type CloudOperatorApiKey,
  type CloudOperatorAuditEntry,
  type CloudOperatorRole,
  type CloudPrincipal,
  type CloudRepository
} from "./types.js";

/**
 * Fail-fast guard for boot: a control plane with zero
 * operators and no way to create the first one can never be administered.
 * Throws with an actionable message so the service refuses to start rather
 * than silently stranding operator management.
 */
export function assertOperatorManagementReachable(input: {
  operatorCount: number;
  sharedKeyBootstrap: boolean;
  oidcBootstrap: boolean;
}): void {
  if (input.operatorCount > 0) return;
  if (input.sharedKeyBootstrap || input.oidcBootstrap) return;
  throw new Error(
    "Operator management is unreachable: zero operators exist and no bootstrap " +
    "path is configured. Provide an enabled shared LIP_CLOUD_API_KEY, or set " +
    "LIP_CLOUD_BOOTSTRAP_SUBJECT(S) with OIDC, to create the first operator."
  );
}

/** Issuer stamped on principals resolved from operator credentials. */
export const OPERATOR_ISSUER = "urn:lip:operator";

/** Prefix that routes a bearer secret to operator-key authentication. */
export const OPERATOR_KEY_PREFIX = "lip_ok_";

export type PublicOperatorApiKey = Omit<CloudOperatorApiKey, "secret_hash">;

export interface CloudOperatorServiceOptions {
  repository: CloudRepository;
  now?: () => Date;
}

export interface CreatedOperatorKey {
  api_key: PublicOperatorApiKey;
  /** Returned exactly once at mint time; only a sha256 hash is stored. */
  secret: string;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Mints a fresh operator-key secret with its stored prefix and hash. */
function mintOperatorKeySecret(): {
  secret: string;
  prefix: string;
  secret_hash: string;
} {
  const secret = `${OPERATOR_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 15), secret_hash: hashSecret(secret) };
}

function publicKey(key: CloudOperatorApiKey): PublicOperatorApiKey {
  const { secret_hash: _secretHash, ...value } = key;
  return structuredClone(value);
}

function normalizeOrganizationIds(input: string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  const normalized = [...new Set(
    input.map((value) => value.trim()).filter((value) => value.length > 0)
  )];
  return normalized.length > 0 ? normalized : undefined;
}

function assertFutureExpiry(expiresAt: string | undefined, now: Date): void {
  if (
    expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= now.getTime())
  ) {
    throw new CloudError(
      422,
      "validation_failed",
      "Operator key expiration must be a future ISO timestamp"
    );
  }
}

/**
 * Directory and credential service for control-plane operators.
 * Mirrors the tenant access-control patterns from
 * `packages/server/src/access-control.ts`: sha256-hashed secrets, expiring
 * keys, revocation, and rotation with a bounded overlap window whose
 * replacement inherits (and can never extend) the rotated key's expiry.
 */
export class CloudOperatorService {
  private readonly repository: CloudRepository;
  private readonly clock: () => Date;

  public constructor(options: CloudOperatorServiceOptions) {
    this.repository = options.repository;
    this.clock = options.now ?? (() => new Date());
  }

  /**
   * Resolves an operator principal from a bearer secret. Returns undefined
   * for unknown, expired, or revoked keys and for inactive operators — the
   * caller maps that to 401.
   */
  public async authenticate(secret: string): Promise<CloudPrincipal | undefined> {
    if (!secret.startsWith(OPERATOR_KEY_PREFIX)) return undefined;
    const resolved = await this.repository.operatorByApiKeyHash(hashSecret(secret));
    if (!resolved) return undefined;
    const { operator, api_key: key } = resolved;
    const now = this.clock();
    if (!operator.active || !key.active || key.revoked_at) return undefined;
    if (key.expires_at && Date.parse(key.expires_at) <= now.getTime()) {
      return undefined;
    }
    await this.repository.markOperatorApiKeyUsed(key.key_id, now.toISOString());
    return this.principalFor(operator);
  }

  /** Number of operator records — drives shared-key/OIDC bootstrap gating. */
  public async countOperators(): Promise<number> {
    return this.repository.countOperators();
  }

  /** Active operator for a verified external subject (OIDC mapping). */
  public async operatorForSubject(subject: string): Promise<CloudOperator | undefined> {
    const operator = await this.repository.operatorBySubject(subject);
    return operator?.active ? operator : undefined;
  }

  public principalFor(operator: CloudOperator): CloudPrincipal {
    return {
      issuer: OPERATOR_ISSUER,
      subject: operator.subject,
      ...(operator.email ? { email: operator.email } : {}),
      operator: {
        operator_id: operator.operator_id,
        role: operator.role,
        ...(operator.organization_ids
          ? { organization_ids: [...operator.organization_ids] }
          : {})
      }
    };
  }

  /**
   * Creates an operator plus its first API key. Authorized for platform-admin
   * operators; the legacy shared gateway may create ONLY the first operator
   * (which must be a platform-admin) — the bootstrap path.
   */
  public async createOperator(
    actor: CloudPrincipal,
    input: {
      subject: string;
      email?: string;
      role: CloudOperatorRole;
      organization_ids?: string[];
      key?: { name?: string; expires_at?: string };
    }
  ): Promise<{ operator: CloudOperator } & CreatedOperatorKey> {
    const { bootstrap } = await this.authorizeOperatorManagement(actor, {
      allowBootstrap: input.role,
      subject: input.subject.trim()
    });
    const subject = input.subject.trim();
    if (!subject || subject.length > 200) {
      throw new CloudError(422, "validation_failed", "A valid operator subject is required");
    }
    if (!["platform-admin", "org-scoped"].includes(input.role)) {
      throw new CloudError(422, "validation_failed", "Unknown operator role");
    }
    const organizationIds = normalizeOrganizationIds(input.organization_ids);
    if ((input.role === "org-scoped") !== Boolean(organizationIds)) {
      throw new CloudError(
        422,
        "validation_failed",
        "org-scoped operators require organization_ids; platform-admins must not carry them"
      );
    }
    const email = input.email?.trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new CloudError(422, "validation_failed", "Operator email is invalid");
    }
    const now = this.clock();
    assertFutureExpiry(input.key?.expires_at, now);
    const timestamp = now.toISOString();
    const operator: CloudOperator = {
      operator_id: `op_${randomUUID()}`,
      subject,
      role: input.role,
      active: true,
      created_at: timestamp,
      updated_at: timestamp,
      ...(email ? { email } : {}),
      ...(organizationIds ? { organization_ids: organizationIds } : {})
    };
    const { secret, key } = this.mintKey(operator.operator_id, {
      name: input.key?.name ?? "default",
      ...(input.key?.expires_at
        ? { expires_at: new Date(input.key.expires_at).toISOString() }
        : {})
    });
    try {
      await this.repository.createOperator({
        operator,
        key,
        bootstrap,
        audit: this.auditEntry(actor, "cloud.operator.created", "operator", operator.operator_id, {
          subject,
          role: input.role,
          key_id: key.key_id,
          prefix: key.prefix,
          ...(organizationIds ? { organization_ids: organizationIds } : {})
        })
      });
    } catch (error) {
      if (error instanceof CloudRepositoryConflictError) {
        throw new CloudError(409, "operator_conflict", "Operator subject already exists");
      }
      throw error;
    }
    return { operator, api_key: publicKey(key), secret };
  }

  public async listOperators(actor: CloudPrincipal): Promise<CloudOperator[]> {
    await this.authorizeOperatorManagement(actor);
    return this.repository.listOperators();
  }

  /** Activates or deactivates an operator; never strands the platform. */
  public async updateOperator(
    actor: CloudPrincipal,
    operatorId: string,
    input: { active: boolean }
  ): Promise<CloudOperator> {
    await this.authorizeOperatorManagement(actor);
    const existing = await this.requiredOperator(operatorId);
    // The last-admin lockout guard is enforced atomically in the repository
    // — a naive count-then-deactivate here would be TOCTOU.
    const guardLastPlatformAdmin =
      !input.active && existing.active && existing.role === "platform-admin";
    let updated: CloudOperator | undefined;
    try {
      updated = await this.repository.updateOperator({
        operatorId,
        active: input.active,
        updatedAt: this.clock().toISOString(),
        guardLastPlatformAdmin,
        audit: this.auditEntry(actor, "cloud.operator.updated", "operator", operatorId, {
          active: input.active
        })
      });
    } catch (error) {
      if (error instanceof LastPlatformAdminError) {
        throw new CloudError(
          409,
          "operator_lockout",
          "The last active platform-admin operator cannot be deactivated"
        );
      }
      throw error;
    }
    if (!updated) throw new CloudError(404, "not_found", "Operator was not found");
    return updated;
  }

  public async createOperatorKey(
    actor: CloudPrincipal,
    operatorId: string,
    input: { name?: string; expires_at?: string } = {}
  ): Promise<CreatedOperatorKey> {
    await this.authorizeOperatorManagement(actor);
    await this.requiredOperator(operatorId);
    const now = this.clock();
    assertFutureExpiry(input.expires_at, now);
    const { secret, key } = this.mintKey(operatorId, {
      name: input.name?.trim() || "default",
      ...(input.expires_at
        ? { expires_at: new Date(input.expires_at).toISOString() }
        : {})
    });
    await this.repository.createOperatorApiKey({
      key,
      audit: this.auditEntry(
        actor,
        "cloud.operator.api_key.created",
        "operator_api_key",
        key.key_id,
        { operator_id: operatorId, prefix: key.prefix }
      )
    });
    return { api_key: publicKey(key), secret };
  }

  /**
   * Rotates an operator key: fresh secret, same name; the replaced key stays
   * valid for a bounded overlap window (default 24 h, 0 = immediate cutover)
   * and the replacement inherits the rotated key's expiry — an explicit
   * `expires_at` may shorten it, never extend it. Audit lands as one pair.
   */
  public async rotateOperatorKey(
    actor: CloudPrincipal,
    operatorId: string,
    input: { key_id: string; overlap_seconds?: number; expires_at?: string }
  ): Promise<CreatedOperatorKey & { replaced_api_key: PublicOperatorApiKey }> {
    await this.authorizeOperatorManagement(actor);
    await this.requiredOperator(operatorId);
    const overlapSeconds = input.overlap_seconds ?? DEFAULT_ROTATION_OVERLAP_SECONDS;
    if (
      !Number.isInteger(overlapSeconds) ||
      overlapSeconds < 0 ||
      overlapSeconds > MAX_ROTATION_OVERLAP_SECONDS
    ) {
      throw new CloudError(
        422,
        "validation_failed",
        `overlap_seconds must be an integer between 0 and ${MAX_ROTATION_OVERLAP_SECONDS}`
      );
    }
    const now = this.clock();
    assertFutureExpiry(input.expires_at, now);
    const existing = (await this.repository.operatorApiKeys(operatorId)).find(
      (candidate) => candidate.key_id === input.key_id
    );
    if (!existing) throw new CloudError(404, "not_found", "Operator API key was not found");
    if (
      !existing.active ||
      existing.revoked_at ||
      (existing.expires_at && Date.parse(existing.expires_at) <= now.getTime())
    ) {
      throw new CloudError(409, "key_inactive", "Operator API key is not active");
    }
    if (
      input.expires_at &&
      existing.expires_at &&
      Date.parse(input.expires_at) > Date.parse(existing.expires_at)
    ) {
      throw new CloudError(
        422,
        "validation_failed",
        "Rotation may shorten an operator key's expiration but never extend it"
      );
    }
    const replacementExpiresAt = input.expires_at
      ? new Date(input.expires_at).toISOString()
      : existing.expires_at;
    const { secret, key: replacement } = this.mintKey(operatorId, {
      name: existing.name,
      ...(replacementExpiresAt ? { expires_at: replacementExpiresAt } : {})
    });
    const overlapExpiry = new Date(now.getTime() + overlapSeconds * 1_000).toISOString();
    const replacedExpiresAt =
      existing.expires_at && Date.parse(existing.expires_at) < Date.parse(overlapExpiry)
        ? existing.expires_at
        : overlapExpiry;
    await this.repository.rotateOperatorApiKey({
      replacement,
      replacedKeyId: existing.key_id,
      replacedExpiresAt,
      audits: [
        this.auditEntry(
          actor,
          "cloud.operator.api_key.created",
          "operator_api_key",
          replacement.key_id,
          { operator_id: operatorId, prefix: replacement.prefix, rotated_from: existing.key_id }
        ),
        this.auditEntry(
          actor,
          "cloud.operator.api_key.rotated",
          "operator_api_key",
          existing.key_id,
          { operator_id: operatorId, replacement_key_id: replacement.key_id, overlap_expires_at: replacedExpiresAt }
        )
      ]
    });
    return {
      api_key: publicKey(replacement),
      secret,
      replaced_api_key: publicKey({ ...existing, expires_at: replacedExpiresAt })
    };
  }

  public async revokeOperatorKey(
    actor: CloudPrincipal,
    operatorId: string,
    input: { key_id: string }
  ): Promise<void> {
    await this.authorizeOperatorManagement(actor);
    await this.requiredOperator(operatorId);
    const existing = (await this.repository.operatorApiKeys(operatorId)).find(
      (candidate) => candidate.key_id === input.key_id
    );
    if (!existing) throw new CloudError(404, "not_found", "Operator API key was not found");
    if (!existing.active) return;
    await this.repository.revokeOperatorApiKey({
      keyId: existing.key_id,
      revokedAt: this.clock().toISOString(),
      audit: this.auditEntry(
        actor,
        "cloud.operator.api_key.revoked",
        "operator_api_key",
        existing.key_id,
        { operator_id: operatorId }
      )
    });
  }

  private mintKey(
    operatorId: string,
    input: { name: string; expires_at?: string }
  ): { secret: string; key: CloudOperatorApiKey } {
    const { secret, prefix, secret_hash } = mintOperatorKeySecret();
    const timestamp = this.clock().toISOString();
    return {
      secret,
      key: {
        key_id: `opkey_${randomUUID()}`,
        operator_id: operatorId,
        name: input.name,
        prefix,
        active: true,
        created_at: timestamp,
        ...(input.expires_at ? { expires_at: input.expires_at } : {}),
        secret_hash
      }
    };
  }

  private async requiredOperator(operatorId: string): Promise<CloudOperator> {
    const operator = await this.repository.operatorById(operatorId);
    if (!operator) throw new CloudError(404, "not_found", "Operator was not found");
    return operator;
  }

  /**
   * Operator management requires a platform-admin operator. Two bootstrap
   * credentials may create only the FIRST operator (a platform-admin): the
   * legacy shared gateway and an OIDC-verified subject in the
   * configured bootstrap allowlist. An OIDC bootstrap may only mint an
   * operator for its own verified subject. Returns whether this call is a
   * bootstrap so the repository can serialize it atomically.
   */
  private async authorizeOperatorManagement(
    actor: CloudPrincipal,
    bootstrap?: { allowBootstrap: CloudOperatorRole; subject: string }
  ): Promise<{ bootstrap: boolean }> {
    if (actor.operator?.role === "platform-admin") return { bootstrap: false };
    const gatewayBootstrap = actor.issuer === TRUSTED_GATEWAY_ISSUER;
    const oidcBootstrap = actor.bootstrap_admin === true;
    if (bootstrap && (gatewayBootstrap || oidcBootstrap)) {
      if (await this.repository.countOperators() > 0) {
        throw new CloudError(
          403,
          "operator_bootstrap_exhausted",
          "The shared key may only create the first operator; use an operator key"
        );
      }
      if (bootstrap.allowBootstrap !== "platform-admin") {
        throw new CloudError(
          422,
          "validation_failed",
          "The bootstrap operator must be a platform-admin"
        );
      }
      if (oidcBootstrap && !gatewayBootstrap && bootstrap.subject !== actor.subject) {
        throw new CloudError(
          403,
          "forbidden",
          "OIDC bootstrap may only create the first operator for the verified subject"
        );
      }
      return { bootstrap: true };
    }
    throw new CloudError(
      403,
      "forbidden",
      "Operator management requires a platform-admin operator credential"
    );
  }

  private auditEntry(
    actor: CloudPrincipal,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata?: Record<string, unknown>
  ): CloudOperatorAuditEntry {
    return {
      audit_id: `op-audit_${randomUUID()}`,
      actor: actor.subject,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      occurred_at: this.clock().toISOString(),
      ...(metadata ? { metadata: structuredClone(metadata) } : {})
    };
  }
}
