import type {
  CloudEnvironment,
  CloudOrganization,
  CloudProject,
  EnvironmentKind,
  ProvisioningStatus,
  RotatedEnvironmentCredentials
} from "./types.js";

/** Merchant credential returned by the control-plane rotation endpoint. */
export type RotatedTenantCredentials = RotatedEnvironmentCredentials;

/**
 * HTTP client for onboarding one brand (= one tenant) onto the shared LIP
 * cluster through the existing control-plane API. It is a thin wrapper over
 * `POST /cloud/v1/organizations`, `POST .../projects`,
 * `POST .../environments`, and the environment list endpoint used to poll
 * provisioning status. It creates nothing the API cannot already create.
 *
 * Authentication boundary: the control plane is called with a
 * per-operator API key (`lip_ok_...`, env `LIP_CLOUD_OPERATOR_KEY`) — the
 * acting identity is the verified operator record, so no subject is
 * required. The legacy shared trusted-gateway key (`LIP_CLOUD_API_KEY`) is
 * rejected outright: it authenticates only the first-operator bootstrap
 * route, which onboarding never calls, so passing it here could never
 * succeed. The merchant credential is a tenant-scoped owner API
 * key; retrieve or rotate it with `rotateTenantCredentials`,
 * which calls `POST /cloud/v1/environments/{id}/credentials/rotate` — no
 * more reading credentials files off the data-plane host, and the
 * deprecated root runtime key is never handed out.
 */
export interface TenantOnboardingTarget {
  /** Base URL of the control plane, e.g. https://lip-cloud.internal:3220 */
  cloudUrl: string;
  /** Per-operator API key (`lip_ok_...`). The shared key is not accepted. */
  apiKey: string;
  /**
   * Optional on-behalf-of audit annotation. It never affects authorization —
   * the acting identity is always the verified operator behind `apiKey`.
   */
  subject?: string;
  /** Optional normalized operator email, recorded for audit only. */
  email?: string;
}

/** Prefix distinguishing per-operator keys from the legacy shared key. */
const OPERATOR_KEY_PREFIX = "lip_ok_";

function assertTarget(target: TenantOnboardingTarget): void {
  if (!target.cloudUrl.trim()) throw new Error("A control-plane URL is required");
  if (!target.apiKey.trim()) throw new Error("A control-plane API key is required");
  // The shared LIP_CLOUD_API_KEY only authenticates the
  // first-operator bootstrap route, which onboarding never calls, so it can
  // never authorize these requests. Fail here with an actionable message
  // rather than letting the control plane return an opaque 401.
  if (!target.apiKey.startsWith(OPERATOR_KEY_PREFIX)) {
    throw new Error(
      "A per-operator API key (lip_ok_...) is required; the shared " +
      "LIP_CLOUD_API_KEY only bootstraps the first operator and cannot " +
      "authenticate onboarding or rotation requests"
    );
  }
}

export interface TenantOnboardingRequest {
  organization: { name: string; slug: string };
  project: { name: string; slug: string };
  environment: {
    name: string;
    slug: string;
    kind: EnvironmentKind;
    region: string;
    programId: string;
  };
  /**
   * Optional first webhook subscription for the tenant. Without one a new
   * tenant starts with zero subscriptions and delivers nothing; providing it
   * here creates the subscription through the runtime's admin API as soon as
   * the environment is ready. Requires network reach to the tenant's
   * `api_url` (run from the private network, like step 4d verification), and
   * mints the merchant credential via the control-plane rotation surface —
   * returned in `TenantOnboardingResult.credentials`.
   */
  webhook?: { url: string; secret: string };
  /** Provisioning-status polling; defaults: 120s timeout, 2s interval. */
  poll?: { timeoutMs?: number; intervalMs?: number };
}

export interface TenantOnboardingResult {
  organization_id: string;
  project_id: string;
  environment_id: string;
  tenant_id: string;
  program_id: string;
  status: ProvisioningStatus;
  api_url?: string;
  admin_url?: string;
  status_message?: string;
  /** True when polling stopped while the environment was still pending. */
  timed_out: boolean;
  /** Which resources this run created (false = reused an existing slug). */
  created: { organization: boolean; project: boolean; environment: boolean };
  /**
   * Merchant credential minted for webhook wiring (only when `webhook` was
   * requested). Store it in the password manager and the consuming BFF.
   */
  credentials?: RotatedTenantCredentials;
  /** The tenant's first webhook subscription (only when `webhook` was requested). */
  webhook?: { subscription_id: string };
}

/** Stable id so re-running onboarding upserts one subscription, not many. */
const ONBOARDING_WEBHOOK_SUBSCRIPTION_ID = "webhook_onboarding";

function assertWebhookConfig(webhook: { url: string; secret: string }): void {
  let parsed: URL;
  try {
    parsed = new URL(webhook.url);
  } catch {
    throw new Error("Webhook URL must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Webhook URL must be an HTTP(S) URL");
  }
  if (webhook.secret.length < 16) {
    throw new Error("Webhook secret must contain at least 16 characters");
  }
}

export class TenantOnboardingError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TenantOnboardingError";
    this.status = status;
    this.code = code;
  }
}

interface ProblemBody {
  code?: string;
  detail?: string;
  title?: string;
}

function headers(target: TenantOnboardingTarget): Record<string, string> {
  return {
    authorization: `Bearer ${target.apiKey}`,
    "content-type": "application/json",
    ...(target.subject?.trim()
      ? { "x-lip-cloud-subject": target.subject.trim() }
      : {}),
    ...(target.email ? { "x-lip-cloud-email": target.email } : {})
  };
}

async function call<T>(
  target: TenantOnboardingTarget,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const base = target.cloudUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: headers(target),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = (await response.json().catch(() => ({}))) as
    | { data?: T }
    | ProblemBody;
  if (!response.ok) {
    const problem = payload as ProblemBody;
    throw new TenantOnboardingError(
      response.status,
      problem.code ?? "request_failed",
      problem.detail ?? problem.title ?? `${method} ${path} failed with ${response.status}`
    );
  }
  return (payload as { data: T }).data;
}

function isSlugConflict(error: unknown): error is TenantOnboardingError {
  return error instanceof TenantOnboardingError &&
    error.status === 409 &&
    error.code === "slug_conflict";
}

async function ensureOrganization(
  target: TenantOnboardingTarget,
  input: { name: string; slug: string }
): Promise<{ organization: CloudOrganization; created: boolean }> {
  try {
    const dashboard = await call<{ organization: CloudOrganization }>(
      target,
      "POST",
      "/cloud/v1/organizations",
      input
    );
    return { organization: dashboard.organization, created: true };
  } catch (error) {
    if (!isSlugConflict(error)) throw error;
    const organizations = await call<CloudOrganization[]>(target, "GET", "/cloud/v1/organizations");
    const existing = organizations.find((candidate) => candidate.slug === input.slug);
    if (!existing) {
      throw new TenantOnboardingError(
        409,
        "slug_owned_elsewhere",
        `Organization slug ${input.slug} exists but is not visible to ${target.subject ?? "this operator"}; use a different slug or the owning credential`
      );
    }
    return { organization: existing, created: false };
  }
}

async function ensureProject(
  target: TenantOnboardingTarget,
  organizationId: string,
  input: { name: string; slug: string }
): Promise<{ project: CloudProject; created: boolean }> {
  const path = `/cloud/v1/organizations/${organizationId}/projects`;
  try {
    return { project: await call<CloudProject>(target, "POST", path, input), created: true };
  } catch (error) {
    if (!isSlugConflict(error)) throw error;
    const projects = await call<CloudProject[]>(target, "GET", path);
    const existing = projects.find((candidate) => candidate.slug === input.slug);
    if (!existing) {
      throw new TenantOnboardingError(409, "slug_conflict", `Project slug ${input.slug} conflicts but was not found`);
    }
    return { project: existing, created: false };
  }
}

async function ensureEnvironment(
  target: TenantOnboardingTarget,
  projectId: string,
  input: TenantOnboardingRequest["environment"]
): Promise<{ environment: CloudEnvironment; created: boolean }> {
  const path = `/cloud/v1/projects/${projectId}/environments`;
  try {
    const environment = await call<CloudEnvironment>(target, "POST", path, {
      name: input.name,
      slug: input.slug,
      kind: input.kind,
      region: input.region,
      program_id: input.programId
    });
    return { environment, created: true };
  } catch (error) {
    if (!isSlugConflict(error)) throw error;
    const environments = await call<CloudEnvironment[]>(target, "GET", path);
    const existing = environments.find((candidate) => candidate.slug === input.slug);
    if (!existing) {
      throw new TenantOnboardingError(409, "slug_conflict", `Environment slug ${input.slug} conflicts but was not found`);
    }
    if (existing.program_id !== input.programId) {
      throw new TenantOnboardingError(
        409,
        "program_mismatch",
        `Environment ${existing.environment_id} serves program ${existing.program_id}, not ${input.programId}`
      );
    }
    return { environment: existing, created: false };
  }
}

async function pollEnvironment(
  target: TenantOnboardingTarget,
  projectId: string,
  environmentId: string,
  poll: { timeoutMs: number; intervalMs: number }
): Promise<{ environment: CloudEnvironment; timedOut: boolean }> {
  const deadline = Date.now() + poll.timeoutMs;
  for (;;) {
    const environments = await call<CloudEnvironment[]>(
      target,
      "GET",
      `/cloud/v1/projects/${projectId}/environments`
    );
    const environment = environments.find(
      (candidate) => candidate.environment_id === environmentId
    );
    if (!environment) {
      throw new TenantOnboardingError(404, "environment_missing", `Environment ${environmentId} disappeared during polling`);
    }
    const settled = environment.status !== "pending" && environment.status !== "provisioning";
    if (settled) return { environment, timedOut: false };
    if (Date.now() >= deadline) return { environment, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, poll.intervalMs));
  }
}

/**
 * Provisions (or idempotently re-resolves) one tenant on the shared cluster:
 * organization → project → environment, then waits for the control-plane
 * provisioning worker to mark the environment `ready`.
 *
 * The returned `tenant_id` is the row scope every engine table uses for this
 * brand. The merchant API key is not part of the result — see the class-level
 * note on the tenant-key rotation boundary.
 */
export async function provisionTenant(
  target: TenantOnboardingTarget,
  request: TenantOnboardingRequest
): Promise<TenantOnboardingResult> {
  assertTarget(target);
  if (request.webhook) assertWebhookConfig(request.webhook);

  const { organization, created: organizationCreated } = await ensureOrganization(
    target,
    request.organization
  );
  const { project, created: projectCreated } = await ensureProject(
    target,
    organization.organization_id,
    request.project
  );
  const { environment: initial, created: environmentCreated } = await ensureEnvironment(
    target,
    project.project_id,
    request.environment
  );
  const { environment, timedOut } = await pollEnvironment(
    target,
    project.project_id,
    initial.environment_id,
    {
      timeoutMs: request.poll?.timeoutMs ?? 120_000,
      intervalMs: request.poll?.intervalMs ?? 2_000
    }
  );

  let credentials: RotatedTenantCredentials | undefined;
  let webhook: { subscription_id: string } | undefined;
  if (request.webhook && environment.status === "ready" && environment.api_url) {
    credentials = await rotateTenantCredentials(target, environment.environment_id);
    webhook = await ensureWebhookSubscription(
      credentials.api_url,
      credentials.merchant_api_key,
      request.webhook
    );
  }

  return {
    organization_id: organization.organization_id,
    project_id: project.project_id,
    environment_id: environment.environment_id,
    tenant_id: environment.tenant_id,
    program_id: environment.program_id,
    status: environment.status,
    ...(environment.api_url ? { api_url: environment.api_url } : {}),
    ...(environment.admin_url ? { admin_url: environment.admin_url } : {}),
    ...(environment.status_message ? { status_message: environment.status_message } : {}),
    timed_out: timedOut,
    created: {
      organization: organizationCreated,
      project: projectCreated,
      environment: environmentCreated
    },
    ...(credentials ? { credentials } : {}),
    ...(webhook ? { webhook } : {})
  };
}

/**
 * Upserts the tenant's onboarding webhook subscription through the runtime's
 * own admin API (the same self-serve surface documented for tenants), using
 * a stable subscription id so re-runs update rather than duplicate.
 */
async function ensureWebhookSubscription(
  apiUrl: string,
  merchantApiKey: string,
  webhook: { url: string; secret: string }
): Promise<{ subscription_id: string }> {
  const base = apiUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/admin/api/v1/webhooks/subscription`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${merchantApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      subscription_id: ONBOARDING_WEBHOOK_SUBSCRIPTION_ID,
      url: webhook.url,
      secret: webhook.secret
    }),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = (await response.json().catch(() => ({}))) as
    | { subscription_id?: string }
    | ProblemBody;
  if (!response.ok) {
    const problem = payload as ProblemBody;
    throw new TenantOnboardingError(
      response.status,
      problem.code ?? "webhook_subscription_failed",
      problem.detail ?? problem.title ??
        `Creating the webhook subscription failed with ${response.status}`
    );
  }
  const summary = payload as { subscription_id?: string };
  if (!summary.subscription_id) {
    throw new TenantOnboardingError(
      502,
      "webhook_subscription_failed",
      "The runtime did not return a webhook subscription id"
    );
  }
  return { subscription_id: summary.subscription_id };
}

/**
 * Rotates (and thereby retrieves) the merchant credential for a provisioned
 * environment through the control plane. The response carries the fresh
 * owner-role merchant API key plus `replaced_api_key_expires_at`; by default
 * the replaced key stays valid for the standard overlap window so consuming
 * BFFs can swap without downtime. Pass `overlapSeconds: 0` for an emergency
 * immediate cutover (the replaced key dies at once).
 */
export async function rotateTenantCredentials(
  target: TenantOnboardingTarget,
  environmentId: string,
  options: { overlapSeconds?: number } = {}
): Promise<RotatedTenantCredentials> {
  assertTarget(target);
  if (!environmentId.trim()) throw new Error("An environment id is required");
  return call<RotatedTenantCredentials>(
    target,
    "POST",
    `/cloud/v1/environments/${encodeURIComponent(environmentId)}/credentials/rotate`,
    options.overlapSeconds !== undefined
      ? { overlap_seconds: options.overlapSeconds }
      : undefined
  );
}
