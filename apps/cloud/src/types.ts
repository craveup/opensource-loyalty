export type CloudRole = "owner" | "admin" | "developer" | "billing" | "viewer";
export type EnvironmentKind = "development" | "staging" | "production";
export type ProvisioningStatus = "pending" | "provisioning" | "ready" | "failed" | "suspended";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";
export type UsageMetric =
  | "monthly_active_members"
  | "loyalty_transactions"
  | "messages";

/** Issuer recorded for legacy shared-key (trusted gateway) principals. */
export const TRUSTED_GATEWAY_ISSUER = "urn:lip:trusted-gateway";

export type CloudOperatorRole = "platform-admin" | "org-scoped";

/**
 * Control-plane operator: the verified identity behind /cloud/v1
 * management calls. Platform-admins are unrestricted; org-scoped operators
 * may only touch the organizations listed in `organization_ids`.
 */
export interface CloudOperator {
  operator_id: string;
  /** Stable identity subject; unique across operators. */
  subject: string;
  email?: string;
  role: CloudOperatorRole;
  /** Present exactly when `role` is org-scoped. */
  organization_ids?: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Hashed-at-rest API key credential for one operator. */
export interface CloudOperatorApiKey {
  key_id: string;
  operator_id: string;
  name: string;
  prefix: string;
  active: boolean;
  created_at: string;
  expires_at?: string;
  last_used_at?: string;
  revoked_at?: string;
  secret_hash: string;
}

/** Platform-level audit entry for operator lifecycle events. */
export interface CloudOperatorAuditEntry {
  audit_id: string;
  /** Verified actor subject (or the trusted-gateway issuer at bootstrap). */
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

export interface CloudPrincipal {
  issuer: string;
  subject: string;
  email?: string;
  /** Present when the principal resolved from an operator credential. */
  operator?: {
    operator_id: string;
    role: CloudOperatorRole;
    organization_ids?: string[];
  };
  /**
   * Untrusted caller annotation (the X-LIP-Cloud-Subject header under
   * operator auth). Recorded in audit metadata, never used for authorization.
   */
  on_behalf_of?: string;
  /**
   * Set by the server only for an OIDC-verified subject in the configured
   * bootstrap allowlist while zero operators exist. Authorizes
   * the one-time creation of the first platform-admin (for this same subject);
   * inert once any operator record exists.
   */
  bootstrap_admin?: boolean;
}

export class CloudRepositoryConflictError extends Error {
  public constructor(message = "Cloud resource already exists") {
    super(message);
    this.name = "CloudRepositoryConflictError";
  }
}

/**
 * Raised by the repository when deactivating an operator would strand the
 * control plane by removing its last active platform-admin. The service maps
 * this to a 409 `operator_lockout`. The guard lives in the repository so the
 * count-then-deactivate decision is atomic.
 */
export class LastPlatformAdminError extends Error {
  public constructor(message = "The last active platform-admin cannot be deactivated") {
    super(message);
    this.name = "LastPlatformAdminError";
  }
}

export interface CloudOrganization {
  organization_id: string;
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CloudOrganizationMembership {
  organization_id: string;
  issuer: string;
  subject: string;
  email?: string;
  role: CloudRole;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CloudOrganizationInvitation {
  invitation_id: string;
  organization_id: string;
  email: string;
  role: Exclude<CloudRole, "owner">;
  invited_by: string;
  expires_at: string;
  accepted_at?: string;
  created_at: string;
}

export interface CloudProject {
  project_id: string;
  organization_id: string;
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CloudEnvironment {
  environment_id: string;
  project_id: string;
  slug: string;
  name: string;
  kind: EnvironmentKind;
  region: string;
  tenant_id: string;
  program_id: string;
  status: ProvisioningStatus;
  status_message?: string;
  api_url?: string;
  admin_url?: string;
  api_key_fingerprint?: string;
  created_at: string;
  updated_at: string;
}

export interface CloudPlan {
  plan_id: string;
  name: string;
  active: boolean;
  monthly_price_minor: number;
  currency: string;
  included_usage: Record<UsageMetric, number>;
  hard_limits: Record<UsageMetric, number>;
  created_at: string;
  updated_at: string;
}

export interface CloudSubscription {
  subscription_id: string;
  organization_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  billing_provider: "manual" | "stripe";
  provider_customer_id?: string;
  provider_subscription_id?: string;
  current_period_start: string;
  current_period_end: string;
  created_at: string;
  updated_at: string;
}

export interface CloudUsageEvent {
  usage_event_id: string;
  environment_id: string;
  metric: UsageMetric;
  quantity: number;
  idempotency_key: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

export interface CloudUsageCounter {
  environment_id: string;
  metric: UsageMetric;
  period_start: string;
  period_end: string;
  quantity: number;
  included: number;
  hard_limit: number;
  remaining: number;
  overage: number;
}

export interface CloudAuditEntry {
  audit_id: string;
  organization_id: string;
  actor_subject: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

export interface CloudProvisioningJob {
  provisioning_job_id: string;
  environment_id: string;
  operation: "create" | "upgrade" | "suspend" | "delete";
  status: "pending" | "running" | "succeeded" | "failed";
  attempts: number;
  available_at: string;
  claimed_by?: string;
  claimed_until?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface CloudProvisioningResult {
  api_url: string;
  admin_url?: string;
}

/**
 * Merchant credential handed back by the control-plane rotation surface
 * Deliberately excludes the deprecated root runtime key.
 */
export interface RotatedEnvironmentCredentials {
  environment_id: string;
  tenant_id: string;
  program_id: string;
  api_url: string;
  admin_url: string;
  merchant_api_key: string;
  merchant_api_key_id: string;
  /** When the replaced key stops working (absent when nothing was replaced). */
  replaced_api_key_expires_at?: string;
  rotated_at: string;
}

/**
 * What a data-plane rotation hook must return: the rotated credential without
 * the control-plane timestamp (the control plane stamps `rotated_at` itself).
 */
export type EnvironmentCredentialRotation = Omit<RotatedEnvironmentCredentials, "rotated_at">;

/** Options the control plane threads into a data-plane rotation hook. */
export interface EnvironmentCredentialRotationOptions {
  /** Operator subject, recorded as `cloud:<subject>` in tenant-side audit. */
  subject: string;
  /** Replaced-key validity after rotation, 0..604800 s. Defaults to 24 h. */
  overlap_seconds?: number;
}

export interface CloudDashboard {
  organization: CloudOrganization;
  membership: CloudOrganizationMembership;
  subscription: CloudSubscription;
  plan: CloudPlan;
  projects: CloudProject[];
}

export interface CloudRepository {
  migrate(): Promise<void>;
  createOrganization(input: {
    organization: CloudOrganization;
    owner: CloudOrganizationMembership;
    subscription: CloudSubscription;
    audit: CloudAuditEntry;
  }): Promise<void>;
  organizationById(organizationId: string): Promise<CloudOrganization | undefined>;
  organizationBySlug(slug: string): Promise<CloudOrganization | undefined>;
  organizationsForPrincipal(
    issuer: string,
    subject: string
  ): Promise<CloudOrganization[]>;
  membership(
    organizationId: string,
    issuer: string,
    subject: string
  ): Promise<CloudOrganizationMembership | undefined>;
  membershipsForOrganization(
    organizationId: string
  ): Promise<CloudOrganizationMembership[]>;
  updateMembership(input: {
    organizationId: string;
    issuer: string;
    subject: string;
    role?: Exclude<CloudRole, "owner">;
    active?: boolean;
    updatedAt: string;
    audit: CloudAuditEntry;
  }): Promise<CloudOrganizationMembership | undefined>;
  createInvitation(input: {
    invitation: CloudOrganizationInvitation;
    tokenHash: string;
    audit: CloudAuditEntry;
  }): Promise<void>;
  acceptInvitation(input: {
    tokenHash: string;
    principal: CloudPrincipal;
    acceptedAt: string;
    auditId: string;
  }): Promise<
    | { status: "accepted"; membership: CloudOrganizationMembership }
    | { status: "not_found" | "expired" | "email_mismatch" | "already_accepted" }
  >;
  createProject(project: CloudProject, audit: CloudAuditEntry): Promise<void>;
  projectById(projectId: string): Promise<CloudProject | undefined>;
  projectBySlug(
    organizationId: string,
    slug: string
  ): Promise<CloudProject | undefined>;
  projectsForOrganization(organizationId: string): Promise<CloudProject[]>;
  createEnvironment(
    environment: CloudEnvironment,
    audit: CloudAuditEntry
  ): Promise<void>;
  environmentById(environmentId: string): Promise<CloudEnvironment | undefined>;
  environmentBySlug(
    projectId: string,
    slug: string
  ): Promise<CloudEnvironment | undefined>;
  environmentsForProject(projectId: string): Promise<CloudEnvironment[]>;
  attachEnvironment(
    environmentId: string,
    binding: {
      api_url: string;
      admin_url?: string;
      api_key_fingerprint?: string;
      status: ProvisioningStatus;
      status_message?: string;
    }
  ): Promise<CloudEnvironment>;
  updateEnvironmentStatus(
    environmentId: string,
    input: {
      status: ProvisioningStatus;
      status_message?: string;
      api_url?: string;
      admin_url?: string;
    }
  ): Promise<CloudEnvironment>;
  plans(): Promise<CloudPlan[]>;
  planById(planId: string): Promise<CloudPlan | undefined>;
  subscriptionForOrganization(
    organizationId: string
  ): Promise<CloudSubscription | undefined>;
  replaceSubscription(
    subscription: CloudSubscription,
    audit: CloudAuditEntry
  ): Promise<void>;
  recordAudit(entry: CloudAuditEntry): Promise<void>;
  auditForOrganization(organizationId: string): Promise<CloudAuditEntry[]>;
  createOperator(input: {
    operator: CloudOperator;
    key: CloudOperatorApiKey;
    audit: CloudOperatorAuditEntry;
    /**
     * First-operator bootstrap: serialize the count-then-insert so two
     * concurrent bootstraps cannot both mint platform-admins.
     * The repository re-checks `countOperators() === 0` atomically and throws
     * CloudRepositoryConflictError otherwise.
     */
    bootstrap?: boolean;
  }): Promise<void>;
  operatorById(operatorId: string): Promise<CloudOperator | undefined>;
  operatorBySubject(subject: string): Promise<CloudOperator | undefined>;
  listOperators(): Promise<CloudOperator[]>;
  countOperators(): Promise<number>;
  updateOperator(input: {
    operatorId: string;
    active?: boolean;
    updatedAt: string;
    audit: CloudOperatorAuditEntry;
    /**
     * When true, the deactivation is refused atomically (throwing
     * LastPlatformAdminError) unless another active platform-admin remains —
     * closing the TOCTOU on the last-admin lockout guard.
     */
    guardLastPlatformAdmin?: boolean;
  }): Promise<CloudOperator | undefined>;
  listOrganizations(): Promise<CloudOrganization[]>;
  operatorApiKeys(operatorId: string): Promise<CloudOperatorApiKey[]>;
  createOperatorApiKey(input: {
    key: CloudOperatorApiKey;
    audit: CloudOperatorAuditEntry;
  }): Promise<void>;
  /** Persists a rotation atomically: replacement + bounded replaced expiry + audit pair. */
  rotateOperatorApiKey(input: {
    replacement: CloudOperatorApiKey;
    replacedKeyId: string;
    replacedExpiresAt: string;
    audits: CloudOperatorAuditEntry[];
  }): Promise<void>;
  revokeOperatorApiKey(input: {
    keyId: string;
    revokedAt: string;
    audit: CloudOperatorAuditEntry;
  }): Promise<CloudOperatorApiKey | undefined>;
  operatorByApiKeyHash(secretHash: string): Promise<
    { operator: CloudOperator; api_key: CloudOperatorApiKey } | undefined
  >;
  markOperatorApiKeyUsed(keyId: string, usedAt: string): Promise<void>;
  operatorAuditEntries(): Promise<CloudOperatorAuditEntry[]>;
  recordUsage(input: {
    organizationId: string;
    event: CloudUsageEvent;
    periodStart: string;
    periodEnd: string;
    hardLimit: number;
  }): Promise<"recorded" | "duplicate" | "limit_exceeded">;
  usageForEnvironment(input: {
    environmentId: string;
    periodStart: string;
    periodEnd: string;
  }): Promise<Array<{ metric: UsageMetric; quantity: number }>>;
  claimProvisioningJob(
    workerId: string,
    leaseSeconds: number
  ): Promise<CloudProvisioningJob | undefined>;
  completeProvisioningJob(
    jobId: string,
    result: CloudProvisioningResult
  ): Promise<void>;
  failProvisioningJob(
    jobId: string,
    message: string,
    retryAt?: string
  ): Promise<void>;
  close(): Promise<void>;
}
