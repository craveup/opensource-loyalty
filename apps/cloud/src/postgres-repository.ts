import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow
} from "pg";
import { PostgresOperatorStore } from "./postgres-operators.js";
import {
  CloudRepositoryConflictError,
  type CloudAuditEntry,
  type CloudEnvironment,
  type CloudOperator,
  type CloudOperatorApiKey,
  type CloudOperatorAuditEntry,
  type CloudOrganization,
  type CloudOrganizationInvitation,
  type CloudOrganizationMembership,
  type CloudPlan,
  type CloudPrincipal,
  type CloudProvisioningJob,
  type CloudProvisioningResult,
  type CloudProject,
  type CloudRepository,
  type CloudSubscription,
  type CloudUsageEvent,
  type ProvisioningStatus,
  type UsageMetric
} from "./types.js";

const migrations = [
  {
    version: 1,
    name: "control_plane",
    url: new URL("../migrations/001_control_plane.sql", import.meta.url)
  },
  {
    version: 2,
    name: "identity_memberships",
    url: new URL("../migrations/002_identity_memberships.sql", import.meta.url)
  },
  {
    version: 3,
    name: "customer_identity",
    url: new URL("../migrations/003_customer_identity.sql", import.meta.url)
  },
  {
    version: 4,
    name: "environment_key_fingerprint",
    url: new URL("../migrations/004_environment_key_fingerprint.sql", import.meta.url)
  },
  {
    version: 5,
    name: "operators",
    url: new URL("../migrations/005_operators.sql", import.meta.url)
  },
  {
    version: 6,
    name: "credential_operations",
    url: new URL("../migrations/006_credential_operations.sql", import.meta.url)
  }
] as const;

interface PostgresCloudRepositoryOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: PoolConfig;
}

interface UsageRow extends QueryResultRow {
  metric: UsageMetric;
  quantity: string | number;
}

class UsageLimitError extends Error {}

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds the JavaScript safe integer range`);
  }
  return parsed;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function organization(row: Record<string, unknown>): CloudOrganization {
  return {
    organization_id: String(row["organization_id"]),
    slug: String(row["slug"]),
    name: String(row["name"]),
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string)
  };
}

function membership(row: Record<string, unknown>): CloudOrganizationMembership {
  return {
    organization_id: String(row["organization_id"]),
    issuer: String(row["issuer"]),
    subject: String(row["subject"]),
    role: row["role"] as CloudOrganizationMembership["role"],
    active: Boolean(row["active"]),
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string),
    ...(row["email"] ? { email: String(row["email"]) } : {})
  };
}

function project(row: Record<string, unknown>): CloudProject {
  return {
    project_id: String(row["project_id"]),
    organization_id: String(row["organization_id"]),
    slug: String(row["slug"]),
    name: String(row["name"]),
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string)
  };
}

function environment(row: Record<string, unknown>): CloudEnvironment {
  return {
    environment_id: String(row["environment_id"]),
    project_id: String(row["project_id"]),
    slug: String(row["slug"]),
    name: String(row["name"]),
    kind: row["kind"] as CloudEnvironment["kind"],
    region: String(row["region"]),
    tenant_id: String(row["tenant_id"]),
    program_id: String(row["program_id"]),
    status: row["status"] as CloudEnvironment["status"],
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string),
    ...(row["status_message"] ? { status_message: String(row["status_message"]) } : {}),
    ...(row["api_url"] ? { api_url: String(row["api_url"]) } : {}),
    ...(row["admin_url"] ? { admin_url: String(row["admin_url"]) } : {}),
    ...(row["api_key_fingerprint"] ? { api_key_fingerprint: String(row["api_key_fingerprint"]) } : {})
  };
}

function provisioningJob(row: Record<string, unknown>): CloudProvisioningJob {
  return {
    provisioning_job_id: String(row["provisioning_job_id"]),
    environment_id: String(row["environment_id"]),
    operation: row["operation"] as CloudProvisioningJob["operation"],
    status: row["status"] as CloudProvisioningJob["status"],
    attempts: safeInteger(row["attempts"] as string | number, "Provisioning attempts"),
    available_at: iso(row["available_at"] as Date | string),
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string),
    ...(row["claimed_by"] ? { claimed_by: String(row["claimed_by"]) } : {}),
    ...(row["claimed_until"]
      ? { claimed_until: iso(row["claimed_until"] as Date | string) }
      : {}),
    ...(row["last_error"] ? { last_error: String(row["last_error"]) } : {})
  };
}

function numericRecord(value: unknown): Record<UsageMetric, number> {
  const record = value as Record<UsageMetric, string | number>;
  return {
    monthly_active_members: safeInteger(
      record.monthly_active_members,
      "monthly_active_members"
    ),
    loyalty_transactions: safeInteger(
      record.loyalty_transactions,
      "loyalty_transactions"
    ),
    messages: safeInteger(record.messages, "messages")
  };
}

function plan(row: Record<string, unknown>): CloudPlan {
  return {
    plan_id: String(row["plan_id"]),
    name: String(row["name"]),
    active: Boolean(row["active"]),
    monthly_price_minor: safeInteger(
      row["monthly_price_minor"] as string | number,
      "Monthly price"
    ),
    currency: String(row["currency"]),
    included_usage: numericRecord(row["included_usage"]),
    hard_limits: numericRecord(row["hard_limits"]),
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string)
  };
}

function subscription(row: Record<string, unknown>): CloudSubscription {
  return {
    subscription_id: String(row["subscription_id"]),
    organization_id: String(row["organization_id"]),
    plan_id: String(row["plan_id"]),
    status: row["status"] as CloudSubscription["status"],
    billing_provider: row["billing_provider"] as CloudSubscription["billing_provider"],
    current_period_start: iso(row["current_period_start"] as Date | string),
    current_period_end: iso(row["current_period_end"] as Date | string),
    created_at: iso(row["created_at"] as Date | string),
    updated_at: iso(row["updated_at"] as Date | string),
    ...(row["provider_customer_id"]
      ? { provider_customer_id: String(row["provider_customer_id"]) }
      : {}),
    ...(row["provider_subscription_id"]
      ? { provider_subscription_id: String(row["provider_subscription_id"]) }
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

async function insertAudit(
  client: PoolClient,
  entry: CloudAuditEntry
): Promise<void> {
  await client.query(`
    INSERT INTO lip_cloud_audit_log (
      audit_id, organization_id, actor_subject, action, resource_type,
      resource_id, metadata, occurred_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  `, [
    entry.audit_id,
    entry.organization_id,
    entry.actor_subject,
    entry.action,
    entry.resource_type,
    entry.resource_id,
    JSON.stringify(entry.metadata ?? null),
    entry.occurred_at
  ]);
}

export class PostgresCloudRepository implements CloudRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly operators: PostgresOperatorStore;

  public constructor(options: PostgresCloudRepositoryOptions) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        ...(options.poolConfig ?? {}),
        ...(options.connectionString
          ? { connectionString: options.connectionString }
          : {})
      });
      this.ownsPool = true;
    }
    this.operators = new PostgresOperatorStore(this.pool);
  }

  public async migrate(): Promise<void> {
    const pending = await Promise.all(
      migrations.map(async (migration) => ({
        ...migration,
        sql: await readFile(fileURLToPath(migration.url), "utf8")
      }))
    );
    await transaction(this.pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS lip_cloud_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["lip:cloud:schema-migrations"]
      );
      const existing = await client.query<{ version: number }>(
        "SELECT version FROM lip_cloud_schema_migrations"
      );
      const applied = new Set(existing.rows.map((row) => row.version));
      for (const migration of pending) {
        if (applied.has(migration.version)) continue;
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO lip_cloud_schema_migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name]
        );
      }
    });
  }

  public async healthCheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async createOrganization(input: {
    organization: CloudOrganization;
    owner: CloudOrganizationMembership;
    subscription: CloudSubscription;
    audit: CloudAuditEntry;
  }): Promise<void> {
    try {
      await transaction(this.pool, async (client) => {
        const { organization: value, owner, subscription: valueSubscription } = input;
        await client.query(`
          INSERT INTO lip_cloud_organizations (
            organization_id, slug, name, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5)
        `, [
          value.organization_id,
          value.slug,
          value.name,
          value.created_at,
          value.updated_at
        ]);
        await client.query(`
          INSERT INTO lip_cloud_organization_memberships (
            organization_id, issuer, subject, email, role, active, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          owner.organization_id,
          owner.issuer,
          owner.subject,
          owner.email ?? null,
          owner.role,
          owner.active,
          owner.created_at,
          owner.updated_at
        ]);
        await client.query(`
          INSERT INTO lip_cloud_subscriptions (
            subscription_id, organization_id, plan_id, status, billing_provider,
            provider_customer_id, provider_subscription_id, current_period_start,
            current_period_end, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          valueSubscription.subscription_id,
          valueSubscription.organization_id,
          valueSubscription.plan_id,
          valueSubscription.status,
          valueSubscription.billing_provider,
          valueSubscription.provider_customer_id ?? null,
          valueSubscription.provider_subscription_id ?? null,
          valueSubscription.current_period_start,
          valueSubscription.current_period_end,
          valueSubscription.created_at,
          valueSubscription.updated_at
        ]);
        await insertAudit(client, input.audit);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CloudRepositoryConflictError("Organization already exists");
      }
      throw error;
    }
  }

  public async organizationById(
    organizationId: string
  ): Promise<CloudOrganization | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_organizations WHERE organization_id = $1",
      [organizationId]
    );
    return result.rows[0] ? organization(result.rows[0]) : undefined;
  }

  public async organizationBySlug(
    slug: string
  ): Promise<CloudOrganization | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_organizations WHERE slug = $1",
      [slug]
    );
    return result.rows[0] ? organization(result.rows[0]) : undefined;
  }

  public async organizationsForPrincipal(
    issuer: string,
    subject: string
  ): Promise<CloudOrganization[]> {
    const result = await this.pool.query(`
      SELECT organization.*
      FROM lip_cloud_organizations organization
      JOIN lip_cloud_organization_memberships membership
        ON membership.organization_id = organization.organization_id
      WHERE membership.issuer = $1
        AND membership.subject = $2
        AND membership.active = true
      ORDER BY organization.created_at
    `, [issuer, subject]);
    return result.rows.map(organization);
  }

  public async membership(
    organizationId: string,
    issuer: string,
    subject: string
  ): Promise<CloudOrganizationMembership | undefined> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_organization_memberships
      WHERE organization_id = $1 AND issuer = $2 AND subject = $3
    `, [organizationId, issuer, subject]);
    return result.rows[0] ? membership(result.rows[0]) : undefined;
  }

  public async membershipsForOrganization(
    organizationId: string
  ): Promise<CloudOrganizationMembership[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_organization_memberships
      WHERE organization_id = $1
      ORDER BY created_at
    `, [organizationId]);
    return result.rows.map(membership);
  }

  public async updateMembership(input: {
    organizationId: string;
    issuer: string;
    subject: string;
    role?: Exclude<CloudOrganizationMembership["role"], "owner">;
    active?: boolean;
    updatedAt: string;
    audit: CloudAuditEntry;
  }): Promise<CloudOrganizationMembership | undefined> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE lip_cloud_organization_memberships
        SET role = COALESCE($4, role),
            active = COALESCE($5, active),
            updated_at = $6
        WHERE organization_id = $1 AND issuer = $2 AND subject = $3
        RETURNING *
      `, [
        input.organizationId,
        input.issuer,
        input.subject,
        input.role ?? null,
        input.active ?? null,
        input.updatedAt
      ]);
      const row = result.rows[0];
      if (!row) return undefined;
      await insertAudit(client, input.audit);
      return membership(row);
    });
  }

  public async createInvitation(input: {
    invitation: CloudOrganizationInvitation;
    tokenHash: string;
    audit: CloudAuditEntry;
  }): Promise<void> {
    try {
      await transaction(this.pool, async (client) => {
        const invitation = input.invitation;
        await client.query(`
          INSERT INTO lip_cloud_organization_invitations (
            invitation_id, organization_id, email, role, token_hash,
            invited_by, expires_at, accepted_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          invitation.invitation_id,
          invitation.organization_id,
          invitation.email,
          invitation.role,
          input.tokenHash,
          invitation.invited_by,
          invitation.expires_at,
          invitation.accepted_at ?? null,
          invitation.created_at
        ]);
        await insertAudit(client, input.audit);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CloudRepositoryConflictError("An active invitation already exists");
      }
      throw error;
    }
  }

  public async acceptInvitation(input: {
    tokenHash: string;
    principal: CloudPrincipal;
    acceptedAt: string;
    auditId: string;
  }): Promise<
    | { status: "accepted"; membership: CloudOrganizationMembership }
    | { status: "not_found" | "expired" | "email_mismatch" | "already_accepted" }
  > {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`
        SELECT *
        FROM lip_cloud_organization_invitations
        WHERE token_hash = $1
        FOR UPDATE
      `, [input.tokenHash]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return { status: "not_found" };
      if (row["accepted_at"]) return { status: "already_accepted" };
      if (Date.parse(String(row["expires_at"])) <= Date.parse(input.acceptedAt)) {
        return { status: "expired" };
      }
      const email = input.principal.email?.trim().toLowerCase();
      if (!email || email !== String(row["email"]).toLowerCase()) {
        return { status: "email_mismatch" };
      }
      const value: CloudOrganizationMembership = {
        organization_id: String(row["organization_id"]),
        issuer: input.principal.issuer,
        subject: input.principal.subject,
        email,
        role: row["role"] as CloudOrganizationMembership["role"],
        active: true,
        created_at: input.acceptedAt,
        updated_at: input.acceptedAt
      };
      await client.query(`
        INSERT INTO lip_cloud_organization_memberships (
          organization_id, issuer, subject, email, role, active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, true, $6, $6)
        ON CONFLICT (organization_id, issuer, subject) DO UPDATE SET
          email = excluded.email,
          role = excluded.role,
          active = true,
          updated_at = excluded.updated_at
      `, [
        value.organization_id,
        value.issuer,
        value.subject,
        value.email,
        value.role,
        value.created_at
      ]);
      await client.query(`
        UPDATE lip_cloud_organization_invitations
        SET accepted_at = $2
        WHERE invitation_id = $1
      `, [String(row["invitation_id"]), input.acceptedAt]);
      await insertAudit(client, {
        audit_id: input.auditId,
        organization_id: value.organization_id,
        actor_subject: input.principal.subject,
        action: "cloud.organization.invitation.accepted",
        resource_type: "organization_membership",
        resource_id: input.principal.subject,
        occurred_at: input.acceptedAt,
        metadata: { issuer: input.principal.issuer, email }
      });
      return { status: "accepted", membership: value };
    });
  }

  public async createProject(
    value: CloudProject,
    audit: CloudAuditEntry
  ): Promise<void> {
    try {
      await transaction(this.pool, async (client) => {
        await client.query(`
          INSERT INTO lip_cloud_projects (
            project_id, organization_id, slug, name, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          value.project_id,
          value.organization_id,
          value.slug,
          value.name,
          value.created_at,
          value.updated_at
        ]);
        await insertAudit(client, audit);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CloudRepositoryConflictError("Project already exists");
      }
      throw error;
    }
  }

  public async projectById(projectId: string): Promise<CloudProject | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_projects WHERE project_id = $1",
      [projectId]
    );
    return result.rows[0] ? project(result.rows[0]) : undefined;
  }

  public async projectBySlug(
    organizationId: string,
    slug: string
  ): Promise<CloudProject | undefined> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_projects
      WHERE organization_id = $1 AND slug = $2
    `, [organizationId, slug]);
    return result.rows[0] ? project(result.rows[0]) : undefined;
  }

  public async projectsForOrganization(
    organizationId: string
  ): Promise<CloudProject[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_projects
      WHERE organization_id = $1
      ORDER BY created_at
    `, [organizationId]);
    return result.rows.map(project);
  }

  public async createEnvironment(
    value: CloudEnvironment,
    audit: CloudAuditEntry
  ): Promise<void> {
    try {
      await transaction(this.pool, async (client) => {
        await client.query(`
          INSERT INTO lip_cloud_environments (
            environment_id, project_id, slug, name, kind, region, tenant_id,
            program_id, status, status_message, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          value.environment_id,
          value.project_id,
          value.slug,
          value.name,
          value.kind,
          value.region,
          value.tenant_id,
          value.program_id,
          value.status,
          value.status_message ?? null,
          value.created_at,
          value.updated_at
        ]);
        await client.query(`
          INSERT INTO lip_cloud_provisioning_jobs (
            provisioning_job_id, environment_id, operation, status, available_at,
            created_at, updated_at
          ) VALUES ($1, $2, 'create', 'pending', $3, $3, $3)
        `, [
          `provision_${randomUUID()}`,
          value.environment_id,
          value.created_at
        ]);
        await insertAudit(client, audit);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CloudRepositoryConflictError("Environment already exists");
      }
      throw error;
    }
  }

  public async environmentById(
    environmentId: string
  ): Promise<CloudEnvironment | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_environments WHERE environment_id = $1",
      [environmentId]
    );
    return result.rows[0] ? environment(result.rows[0]) : undefined;
  }

  public async environmentBySlug(
    projectId: string,
    slug: string
  ): Promise<CloudEnvironment | undefined> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_environments
      WHERE project_id = $1 AND slug = $2
    `, [projectId, slug]);
    return result.rows[0] ? environment(result.rows[0]) : undefined;
  }

  public async environmentsForProject(projectId: string): Promise<CloudEnvironment[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_environments
      WHERE project_id = $1
      ORDER BY created_at
    `, [projectId]);
    return result.rows.map(environment);
  }

  public async readyEnvironments(): Promise<CloudEnvironment[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_environments
      WHERE status = 'ready'
      ORDER BY created_at
    `);
    return result.rows.map(environment);
  }

  public async attachEnvironment(
    environmentId: string,
    binding: {
      api_url: string;
      admin_url?: string;
      api_key_fingerprint?: string;
      status: ProvisioningStatus;
      status_message?: string;
    }
  ): Promise<CloudEnvironment> {
    const result = await this.pool.query(`
      UPDATE lip_cloud_environments
      SET status = $2,
          status_message = $3,
          api_url = $4,
          admin_url = $5,
          api_key_fingerprint = $6,
          updated_at = now()
      WHERE environment_id = $1
      RETURNING *
    `, [
      environmentId,
      binding.status,
      binding.status_message ?? null,
      binding.api_url,
      binding.admin_url ?? null,
      binding.api_key_fingerprint ?? null
    ]);
    const row = result.rows[0];
    if (!row) throw new Error(`Environment ${environmentId} was not found`);
    return environment(row);
  }

  public async updateEnvironmentStatus(
    environmentId: string,
    input: {
      status: ProvisioningStatus;
      status_message?: string;
      api_url?: string;
      admin_url?: string;
    }
  ): Promise<CloudEnvironment> {
    const result = await this.pool.query(`
      UPDATE lip_cloud_environments
      SET status = $2,
          status_message = $3,
          api_url = COALESCE($4, api_url),
          admin_url = COALESCE($5, admin_url),
          updated_at = now()
      WHERE environment_id = $1
      RETURNING *
    `, [
      environmentId,
      input.status,
      input.status_message ?? null,
      input.api_url ?? null,
      input.admin_url ?? null
    ]);
    const row = result.rows[0];
    if (!row) throw new Error(`Environment ${environmentId} was not found`);
    return environment(row);
  }

  public async plans(): Promise<CloudPlan[]> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_plans WHERE active = true ORDER BY monthly_price_minor"
    );
    return result.rows.map(plan);
  }

  public async planById(planId: string): Promise<CloudPlan | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_plans WHERE plan_id = $1",
      [planId]
    );
    return result.rows[0] ? plan(result.rows[0]) : undefined;
  }

  public async subscriptionForOrganization(
    organizationId: string
  ): Promise<CloudSubscription | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_subscriptions WHERE organization_id = $1",
      [organizationId]
    );
    return result.rows[0] ? subscription(result.rows[0]) : undefined;
  }

  public async replaceSubscription(
    value: CloudSubscription,
    audit: CloudAuditEntry
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query(`
        INSERT INTO lip_cloud_subscriptions (
          subscription_id, organization_id, plan_id, status, billing_provider,
          provider_customer_id, provider_subscription_id, current_period_start,
          current_period_end, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (organization_id) DO UPDATE SET
          subscription_id = excluded.subscription_id,
          plan_id = excluded.plan_id,
          status = excluded.status,
          billing_provider = excluded.billing_provider,
          provider_customer_id = excluded.provider_customer_id,
          provider_subscription_id = excluded.provider_subscription_id,
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          updated_at = excluded.updated_at
      `, [
        value.subscription_id,
        value.organization_id,
        value.plan_id,
        value.status,
        value.billing_provider,
        value.provider_customer_id ?? null,
        value.provider_subscription_id ?? null,
        value.current_period_start,
        value.current_period_end,
        value.created_at,
        value.updated_at
      ]);
      await insertAudit(client, audit);
    });
  }

  public async recordAudit(entry: CloudAuditEntry): Promise<void> {
    const client = await this.pool.connect();
    try {
      await insertAudit(client, entry);
    } finally {
      client.release();
    }
  }

  public async auditForOrganization(
    organizationId: string
  ): Promise<CloudAuditEntry[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM lip_cloud_audit_log
      WHERE organization_id = $1
      ORDER BY occurred_at DESC
    `, [organizationId]);
    return result.rows.map((row: Record<string, unknown>) => ({
      audit_id: String(row["audit_id"]),
      organization_id: String(row["organization_id"]),
      actor_subject: String(row["actor_subject"]),
      action: String(row["action"]),
      resource_type: String(row["resource_type"]),
      resource_id: String(row["resource_id"]),
      occurred_at: iso(row["occurred_at"] as Date | string),
      ...(row["metadata"]
        ? { metadata: row["metadata"] as Record<string, unknown> }
        : {})
    }));
  }

  public async listOrganizations(): Promise<CloudOrganization[]> {
    const result = await this.pool.query(
      "SELECT * FROM lip_cloud_organizations ORDER BY created_at"
    );
    return result.rows.map(organization);
  }

  public async createOperator(input: {
    operator: CloudOperator;
    key: CloudOperatorApiKey;
    audit: CloudOperatorAuditEntry;
  }): Promise<void> {
    await this.operators.createOperator(input);
  }

  public async operatorById(operatorId: string): Promise<CloudOperator | undefined> {
    return this.operators.operatorById(operatorId);
  }

  public async operatorBySubject(subject: string): Promise<CloudOperator | undefined> {
    return this.operators.operatorBySubject(subject);
  }

  public async listOperators(): Promise<CloudOperator[]> {
    return this.operators.listOperators();
  }

  public async countOperators(): Promise<number> {
    return this.operators.countOperators();
  }

  public async updateOperator(input: {
    operatorId: string;
    active?: boolean;
    updatedAt: string;
    audit: CloudOperatorAuditEntry;
  }): Promise<CloudOperator | undefined> {
    return this.operators.updateOperator(input);
  }

  public async operatorApiKeys(operatorId: string): Promise<CloudOperatorApiKey[]> {
    return this.operators.operatorApiKeys(operatorId);
  }

  public async createOperatorApiKey(input: {
    key: CloudOperatorApiKey;
    audit: CloudOperatorAuditEntry;
  }): Promise<void> {
    await this.operators.createOperatorApiKey(input);
  }

  public async rotateOperatorApiKey(input: {
    replacement: CloudOperatorApiKey;
    replacedKeyId: string;
    replacedExpiresAt: string;
    audits: CloudOperatorAuditEntry[];
  }): Promise<void> {
    await this.operators.rotateOperatorApiKey(input);
  }

  public async revokeOperatorApiKey(input: {
    keyId: string;
    revokedAt: string;
    audit: CloudOperatorAuditEntry;
  }): Promise<CloudOperatorApiKey | undefined> {
    return this.operators.revokeOperatorApiKey(input);
  }

  public async operatorByApiKeyHash(secretHash: string): Promise<
    { operator: CloudOperator; api_key: CloudOperatorApiKey } | undefined
  > {
    return this.operators.operatorByApiKeyHash(secretHash);
  }

  public async markOperatorApiKeyUsed(keyId: string, usedAt: string): Promise<void> {
    await this.operators.markOperatorApiKeyUsed(keyId, usedAt);
  }

  public async operatorAuditEntries(): Promise<CloudOperatorAuditEntry[]> {
    return this.operators.operatorAuditEntries();
  }

  public async recordUsage(input: {
    organizationId: string;
    event: CloudUsageEvent;
    periodStart: string;
    periodEnd: string;
    hardLimit: number;
  }): Promise<"recorded" | "duplicate" | "limit_exceeded"> {
    try {
      return await transaction(this.pool, async (client) => {
        const { event } = input;
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`lip:cloud:usage:${event.environment_id}:${event.metric}:${input.periodStart}`]
        );
        const scope = await client.query<{ organization_id: string }>(`
          SELECT project.organization_id
          FROM lip_cloud_environments environment
          JOIN lip_cloud_projects project ON project.project_id = environment.project_id
          WHERE environment.environment_id = $1
        `, [event.environment_id]);
        if (scope.rows[0]?.organization_id !== input.organizationId) {
          throw new Error("Usage environment does not belong to organization");
        }
        const duplicate = await client.query(`
          SELECT 1
          FROM lip_cloud_usage_events
          WHERE environment_id = $1 AND metric = $2 AND idempotency_key = $3
        `, [event.environment_id, event.metric, event.idempotency_key]);
        if (duplicate.rowCount) return "duplicate";
        const current = await client.query<{ quantity: string }>(`
          SELECT quantity
          FROM lip_cloud_usage_counters
          WHERE environment_id = $1 AND metric = $2 AND period_start = $3
          FOR UPDATE
        `, [event.environment_id, event.metric, input.periodStart]);
        const quantity = current.rows[0]
          ? safeInteger(current.rows[0].quantity, "Usage quantity")
          : 0;
        if (quantity + event.quantity > input.hardLimit) throw new UsageLimitError();
        await client.query(`
          INSERT INTO lip_cloud_usage_events (
            usage_event_id, organization_id, environment_id, metric, quantity,
            idempotency_key, occurred_at, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `, [
          event.usage_event_id,
          input.organizationId,
          event.environment_id,
          event.metric,
          String(event.quantity),
          event.idempotency_key,
          event.occurred_at,
          JSON.stringify(event.metadata ?? null)
        ]);
        await client.query(`
          INSERT INTO lip_cloud_usage_counters (
            environment_id, metric, period_start, period_end, quantity, updated_at
          ) VALUES ($1, $2, $3, $4, $5, now())
          ON CONFLICT (environment_id, metric, period_start) DO UPDATE SET
            quantity = lip_cloud_usage_counters.quantity + excluded.quantity,
            period_end = excluded.period_end,
            updated_at = now()
        `, [
          event.environment_id,
          event.metric,
          input.periodStart,
          input.periodEnd,
          String(event.quantity)
        ]);
        return "recorded";
      });
    } catch (error) {
      if (error instanceof UsageLimitError) return "limit_exceeded";
      if (isUniqueViolation(error)) return "duplicate";
      throw error;
    }
  }

  public async usageForEnvironment(input: {
    environmentId: string;
    periodStart: string;
    periodEnd: string;
  }): Promise<Array<{ metric: UsageMetric; quantity: number }>> {
    const result = await this.pool.query<UsageRow>(`
      SELECT metric, quantity
      FROM lip_cloud_usage_counters
      WHERE environment_id = $1
        AND period_start = $2
        AND period_end = $3
      ORDER BY metric
    `, [input.environmentId, input.periodStart, input.periodEnd]);
    return result.rows.map((row) => ({
      metric: row.metric,
      quantity: safeInteger(row.quantity, `Usage ${row.metric}`)
    }));
  }

  public async claimProvisioningJob(
    workerId: string,
    leaseSeconds: number
  ): Promise<CloudProvisioningJob | undefined> {
    if (!workerId.trim() || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5) {
      throw new Error("Provisioning worker id and a lease of at least 5 seconds are required");
    }
    return transaction(this.pool, async (client) => {
      const candidate = await client.query(`
        SELECT *
        FROM lip_cloud_provisioning_jobs
        WHERE (
          status = 'pending' AND available_at <= now()
        ) OR (
          status = 'running' AND claimed_until < now()
        )
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const row = candidate.rows[0];
      if (!row) return undefined;
      const claimed = await client.query(`
        UPDATE lip_cloud_provisioning_jobs
        SET status = 'running',
            attempts = attempts + 1,
            claimed_by = $2,
            claimed_until = now() + ($3 * interval '1 second'),
            updated_at = now()
        WHERE provisioning_job_id = $1
        RETURNING *
      `, [row.provisioning_job_id, workerId, leaseSeconds]);
      await client.query(`
        UPDATE lip_cloud_environments
        SET status = 'provisioning', status_message = NULL, updated_at = now()
        WHERE environment_id = $1
      `, [row.environment_id]);
      return provisioningJob(claimed.rows[0]);
    });
  }

  public async completeProvisioningJob(
    jobId: string,
    result: CloudProvisioningResult
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const job = await client.query<{ environment_id: string }>(`
        UPDATE lip_cloud_provisioning_jobs
        SET status = 'succeeded',
            claimed_by = NULL,
            claimed_until = NULL,
            last_error = NULL,
            updated_at = now()
        WHERE provisioning_job_id = $1 AND status = 'running'
        RETURNING environment_id
      `, [jobId]);
      const environmentId = job.rows[0]?.environment_id;
      if (!environmentId) throw new Error("Running provisioning job was not found");
      await client.query(`
        UPDATE lip_cloud_environments
        SET status = 'ready',
            status_message = NULL,
            api_url = $2,
            admin_url = $3,
            updated_at = now()
        WHERE environment_id = $1
      `, [environmentId, result.api_url, result.admin_url ?? null]);
    });
  }

  public async failProvisioningJob(
    jobId: string,
    message: string,
    retryAt?: string
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const job = await client.query<{ environment_id: string; attempts: number }>(`
        SELECT environment_id, attempts
        FROM lip_cloud_provisioning_jobs
        WHERE provisioning_job_id = $1 AND status = 'running'
        FOR UPDATE
      `, [jobId]);
      const row = job.rows[0];
      if (!row) throw new Error("Running provisioning job was not found");
      const exhausted = row.attempts >= 5 || !retryAt;
      await client.query(`
        UPDATE lip_cloud_provisioning_jobs
        SET status = $2,
            available_at = COALESCE($3, available_at),
            claimed_by = NULL,
            claimed_until = NULL,
            last_error = $4,
            updated_at = now()
        WHERE provisioning_job_id = $1
      `, [jobId, exhausted ? "failed" : "pending", retryAt ?? null, message.slice(0, 2_000)]);
      await client.query(`
        UPDATE lip_cloud_environments
        SET status = $2, status_message = $3, updated_at = now()
        WHERE environment_id = $1
      `, [
        row.environment_id,
        exhausted ? "failed" : "pending",
        message.slice(0, 2_000)
      ]);
    });
  }

  public async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
