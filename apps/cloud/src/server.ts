import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import type { CloudAuthenticator } from "./auth.js";
import { CustomerPlatformError } from "./customer-errors.js";
import type { CustomerPlatform } from "./customer-service.js";
import {
  OPERATOR_KEY_PREFIX,
  type CloudOperatorService
} from "./operator-service.js";
import { CloudControlPlane, CloudError } from "./service.js";
import type {
  LocalEnvironmentOperation,
  LocalEnvironmentOperationResult
} from "./service.js";
import {
  TRUSTED_GATEWAY_ISSUER,
  type CloudOperatorRole,
  type CloudPrincipal,
  type CloudRole,
  type EnvironmentCredentialRotation,
  type EnvironmentCredentialRotationOptions,
  type EnvironmentKind,
  type UsageMetric
} from "./types.js";

const maxBodyBytes = 1_048_576;

/** Audit-only on-behalf-of annotation ceiling (PLA-442 fix 8). */
const maxSubjectHeaderLength = 320;

/** Subject stamped as the audit actor for the shared-key bootstrap request. */
const CLOUD_BOOTSTRAP_SUBJECT = "urn:lip:cloud-bootstrap";

export interface CloudServerOptions {
  /**
   * Legacy shared trusted-gateway key. Deprecated (PLA-442): it authenticates
   * NOTHING except the first-operator bootstrap route, and only while zero
   * operators exist. Once any operator exists it is retired (401
   * `shared_key_retired`) on every route. Set `sharedKeyDisabled` to reject it
   * outright, including bootstrap.
   */
  apiKey?: string;
  authenticator?: CloudAuthenticator;
  /** Operator directory for `lip_ok_` bearer keys and OIDC subject mapping. */
  operators?: CloudOperatorService;
  /** Rejects the shared `apiKey` outright, bootstrap included (401 shared_key_disabled). */
  sharedKeyDisabled?: boolean;
  /**
   * OIDC-verified subjects allowed to bootstrap the first platform-admin
   * operator while zero operators exist (PLA-442 fix 3). Inert thereafter.
   */
  bootstrapSubjects?: string[];
  allowedOrigins?: string[];
  deployment?: {
    environment: string;
    release: string;
  };
  /**
   * Non-secret identities of the two databases this process is bound to.
   * Published on /health so an operator can prove sandbox and production are
   * independent from outside; neither process can see the other's URL.
   */
  databaseFingerprints?: {
    controlPlane: string;
    dataPlane: string;
  };
  healthCheck?: () => Promise<void>;
  /**
   * Data-plane hook for POST /cloud/v1/environments/{id}/credentials/rotate
   * (PLA-416). When absent the route answers 409
   * credential_rotation_unavailable.
   */
  rotateEnvironmentCredentials?: (
    environmentId: string,
    options: EnvironmentCredentialRotationOptions
  ) => Promise<EnvironmentCredentialRotation>;
  /** Optional managed-customer BFF contract; it verifies external tokens and never issues them. */
  customers?: CustomerPlatform;
  operateLocalEnvironment?: (
    environmentId: string,
    operation: LocalEnvironmentOperation,
    input: { backup_id?: string }
  ) => Promise<LocalEnvironmentOperationResult>;
}

export interface RunningCloudServer {
  url: string;
  close(): Promise<void>;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

/**
 * The audit-only on-behalf-of annotation. Validated before it ever reaches
 * audit metadata (PLA-442 fix 8): bounded length, no control characters or
 * newlines. It is never used for authorization.
 */
function subjectHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["x-lip-cloud-subject"];
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > maxSubjectHeaderLength) {
    throw new CloudError(
      400,
      "invalid_subject_header",
      `X-LIP-Cloud-Subject must be at most ${maxSubjectHeaderLength} characters`
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new CloudError(
      400,
      "invalid_subject_header",
      "X-LIP-Cloud-Subject must not contain control characters"
    );
  }
  return trimmed;
}

/** True for the one route the deprecated shared key legitimately serves. */
function isOperatorBootstrap(method: string, path: string): boolean {
  return method === "POST" && path === "/cloud/v1/operators";
}

async function principal(
  request: IncomingMessage,
  options: CloudServerOptions,
  context: { method: string; path: string }
): Promise<CloudPrincipal> {
  const secret = bearer(request);
  const claimed = subjectHeader(request);

  // Operator API keys (PLA-442): the acting identity comes from the resolved
  // operator record. The subject header is ONLY an on-behalf-of annotation.
  if (secret?.startsWith(OPERATOR_KEY_PREFIX)) {
    const resolved = options.operators
      ? await options.operators.authenticate(secret)
      : undefined;
    if (!resolved) {
      throw new CloudError(401, "unauthorized", "Operator API key is invalid");
    }
    return {
      ...resolved,
      ...(claimed && claimed !== resolved.subject
        ? { on_behalf_of: claimed }
        : {})
    };
  }

  if (options.authenticator) {
    const verified = await options.authenticator.authenticate({
      headers: request.headers,
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {})
    });
    // A verified subject with an active operator record gains that
    // operator's scope; anyone else stays a plain member principal. A verified
    // subject in the bootstrap allowlist, while zero operators exist, is
    // flagged to create the first platform-admin for itself (PLA-442 fix 3).
    const operator = await options.operators?.operatorForSubject(verified.subject);
    const bootstrapAdmin =
      !operator &&
      Boolean(options.bootstrapSubjects?.includes(verified.subject)) &&
      Boolean(options.operators) &&
      (await options.operators!.countOperators()) === 0;
    return {
      ...verified,
      ...(operator ? { operator: operatorScope(operator) } : {}),
      ...(bootstrapAdmin ? { bootstrap_admin: true } : {}),
      ...(claimed && claimed !== verified.subject
        ? { on_behalf_of: claimed }
        : {})
    };
  }

  // Legacy shared trusted-gateway key (PLA-442 fix 1): retired to a
  // bootstrap-only credential. It authenticates NOTHING except the
  // first-operator bootstrap route, and only while zero operators exist. Once
  // any operator exists — or on any other route — it is rejected. It never
  // produces a general data-plane principal again, and the bootstrap request
  // needs no X-LIP-Cloud-Subject header (fix 2): the new operator's identity
  // comes from the request body.
  if (!secret || !options.apiKey || !secureEqual(secret, options.apiKey)) {
    throw new CloudError(401, "unauthorized", "Valid Cloud API credentials are required");
  }
  if (options.sharedKeyDisabled) {
    throw new CloudError(
      401,
      "shared_key_disabled",
      "The shared Cloud API key is disabled; use an operator API key (lip_ok_...)"
    );
  }
  const operatorCount = options.operators
    ? await options.operators.countOperators()
    : 0;
  if (!isOperatorBootstrap(context.method, context.path) || operatorCount > 0) {
    throw new CloudError(
      401,
      "shared_key_retired",
      "The shared Cloud API key is retired; it only bootstraps the first " +
      "operator while none exist. Authenticate with an operator API key (lip_ok_...)."
    );
  }
  return {
    issuer: TRUSTED_GATEWAY_ISSUER,
    subject: CLOUD_BOOTSTRAP_SUBJECT,
    ...(claimed ? { on_behalf_of: claimed } : {})
  };
}

function operatorScope(operator: {
  operator_id: string;
  role: CloudOperatorRole;
  organization_ids?: string[];
}): NonNullable<CloudPrincipal["operator"]> {
  return {
    operator_id: operator.operator_id,
    role: operator.role,
    ...(operator.organization_ids
      ? { organization_ids: [...operator.organization_ids] }
      : {})
  };
}

function corsHeaders(
  request: IncomingMessage,
  options: CloudServerOptions
): Record<string, string> {
  const origin = request.headers.origin;
  if (
    typeof origin === "string" &&
    options.allowedOrigins?.includes(origin)
  ) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers":
        "Authorization, Content-Type, Stripe-Signature, X-LIP-Cloud-Subject, " +
        "X-LIP-Cloud-Email, X-LIP-Tenant-Id, X-LIP-Customer-Provider",
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      vary: "Origin"
    };
  }
  return {};
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers
  });
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

class CloudHttpMetrics {
  private readonly startedAt = Date.now();
  private readonly requests = new Map<string, number>();

  public observe(method: string, status: number): void {
    const key = `${method}:${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
  }

  public render(): string {
    const lines = [
      "# HELP lip_cloud_http_requests_total Completed control-plane HTTP requests.",
      "# TYPE lip_cloud_http_requests_total counter"
    ];
    for (const [key, count] of [...this.requests.entries()].sort()) {
      const [method, status] = key.split(":");
      lines.push(
        `lip_cloud_http_requests_total{method="${method}",status="${status}"} ${count}`
      );
    }
    lines.push(
      "# HELP lip_cloud_process_uptime_seconds Control-plane process uptime.",
      "# TYPE lip_cloud_process_uptime_seconds gauge",
      `lip_cloud_process_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
      "# HELP lip_cloud_process_resident_memory_bytes Control-plane resident memory.",
      "# TYPE lip_cloud_process_resident_memory_bytes gauge",
      `lip_cloud_process_resident_memory_bytes ${process.memoryUsage().rss}`
    );
    return `${lines.join("\n")}\n`;
  }
}

function sendProblem(
  response: ServerResponse,
  error: CloudError,
  headers: Record<string, string>
): void {
  sendJson(response, error.status, {
    type: `https://opensource-loyalty.dev/problems/${error.code}`,
    title: error.code
      .split("_")
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" "),
    status: error.status,
    detail: error.message,
    code: error.code
  }, {
    "content-type": "application/problem+json; charset=utf-8",
    ...headers
  });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(request);
  if (raw.length === 0) return {};
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new CloudError(400, "invalid_json", "Request body must be a JSON object");
  }
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new CloudError(413, "payload_too_large", "Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requiredString(
  body: Record<string, unknown>,
  key: string
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CloudError(422, "validation_failed", `${key} is required`);
  }
  return value;
}

function pathId(path: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

async function customerSession(
  request: IncomingMessage,
  customers: CustomerPlatform
) {
  const tenantId = request.headers["x-lip-tenant-id"];
  const providerId = request.headers["x-lip-customer-provider"];
  const token = bearer(request);
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    throw new CustomerPlatformError(400, "tenant_required", "X-LIP-Tenant-Id is required");
  }
  if (typeof providerId !== "string" || !providerId.trim()) {
    throw new CustomerPlatformError(
      400,
      "provider_required",
      "X-LIP-Customer-Provider is required"
    );
  }
  if (!token) throw new CustomerPlatformError(401, "invalid_token", "Bearer token is required");
  return customers.introspectSession({
    tenant_id: tenantId,
    provider_id: providerId,
    token
  });
}

async function handleCustomerRoute(input: {
  method: string;
  path: string;
  request: IncomingMessage;
  customers?: CustomerPlatform;
}): Promise<{ status: number; body: unknown } | undefined> {
  if (!input.path.startsWith("/cloud/v1/customer")) return undefined;
  if (!input.customers) {
    throw new CloudError(
      409,
      "customer_platform_unavailable",
      "Managed customer routes are not configured"
    );
  }
  const session = await customerSession(input.request, input.customers);
  if (input.method === "POST" && input.path === "/cloud/v1/customer/session") {
    return { status: 200, body: { data: session } };
  }
  if (input.method === "GET" && input.path === "/cloud/v1/customer/profile") {
    return { status: 200, body: { data: await input.customers.getProfile(session) } };
  }
  if (input.method === "PATCH" && input.path === "/cloud/v1/customer/profile") {
    const body = await readBody(input.request);
    return {
      status: 200,
      body: {
        data: await input.customers.updateProfile(session, {
          ...(body["given_name"] === null || typeof body["given_name"] === "string"
            ? { given_name: body["given_name"] }
            : {}),
          ...(body["family_name"] === null || typeof body["family_name"] === "string"
            ? { family_name: body["family_name"] }
            : {}),
          ...(body["locale"] === null || typeof body["locale"] === "string"
            ? { locale: body["locale"] }
            : {})
        })
      }
    };
  }
  if (input.method === "POST" && input.path === "/cloud/v1/customer/consents") {
    const body = await readBody(input.request);
    return {
      status: 200,
      body: {
        data: await input.customers.setConsent(session, {
          purpose: requiredString(body, "purpose"),
          status: requiredString(body, "status") as "granted" | "denied" | "withdrawn",
          policy_version: requiredString(body, "policy_version"),
          source: requiredString(body, "source")
        })
      }
    };
  }
  if (input.method === "POST" && input.path === "/cloud/v1/customer/identities/link") {
    const body = await readBody(input.request);
    return {
      status: 201,
      body: {
        data: await input.customers.linkIdentity(session, {
          provider_id: requiredString(body, "provider_id"),
          token: requiredString(body, "token")
        })
      }
    };
  }
  if (input.method === "POST" && input.path === "/cloud/v1/customer/loyalty/enroll") {
    const body = await readBody(input.request);
    return {
      status: 201,
      body: {
        data: await input.customers.enrollLoyalty(session, {
          program_id: requiredString(body, "program_id")
        })
      }
    };
  }
  if (input.method === "GET" && input.path === "/cloud/v1/customer/export") {
    return { status: 200, body: { data: await input.customers.exportAccount(session) } };
  }
  if (input.method === "DELETE" && input.path === "/cloud/v1/customer/account") {
    return { status: 200, body: { data: await input.customers.deleteAccount(session) } };
  }
  throw new CloudError(404, "not_found", "Managed customer route was not found");
}

interface OperatorRouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Operator lifecycle routes (PLA-442). Authorization lives in
 * CloudOperatorService: platform-admin operators only, except the one-time
 * shared-key bootstrap of the first operator. Returns undefined when the
 * request is not an operator route.
 */
async function handleOperatorRoutes(
  actor: CloudPrincipal,
  options: CloudServerOptions,
  context: { method: string; path: string; request: IncomingMessage }
): Promise<OperatorRouteResult | undefined> {
  const { method, path, request } = context;
  if (!path.startsWith("/cloud/v1/operators")) return undefined;
  const operators = options.operators;
  if (!operators) {
    throw new CloudError(
      409,
      "operator_directory_unavailable",
      "This control plane has no operator directory configured"
    );
  }
  if (method === "POST" && path === "/cloud/v1/operators") {
    const body = await readBody(request);
    const email = body["email"];
    const organizationIds = body["organization_ids"];
    const key = body["key"];
    const created = await operators.createOperator(actor, {
      subject: requiredString(body, "subject"),
      role: requiredString(body, "role") as CloudOperatorRole,
      ...(typeof email === "string" ? { email } : {}),
      ...(Array.isArray(organizationIds)
        ? { organization_ids: organizationIds.map(String) }
        : {}),
      ...(key && typeof key === "object" && !Array.isArray(key)
        ? { key: key as { name?: string; expires_at?: string } }
        : {})
    });
    return {
      status: 201,
      body: { data: created },
      headers: { location: `/cloud/v1/operators/${created.operator.operator_id}` }
    };
  }
  if (method === "GET" && path === "/cloud/v1/operators") {
    return { status: 200, body: { data: await operators.listOperators(actor) } };
  }
  const operatorId = pathId(path, /^\/cloud\/v1\/operators\/([^/]+)$/);
  if (operatorId && method === "PATCH") {
    const body = await readBody(request);
    if (typeof body["active"] !== "boolean") {
      throw new CloudError(422, "validation_failed", "active must be a boolean");
    }
    return {
      status: 200,
      body: {
        data: await operators.updateOperator(actor, operatorId, {
          active: body["active"]
        })
      }
    };
  }
  const keysOperatorId = pathId(path, /^\/cloud\/v1\/operators\/([^/]+)\/keys$/);
  if (keysOperatorId && method === "POST") {
    const body = await readBody(request);
    const name = body["name"];
    const expiresAt = body["expires_at"];
    return {
      status: 201,
      body: {
        data: await operators.createOperatorKey(actor, keysOperatorId, {
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof expiresAt === "string" ? { expires_at: expiresAt } : {})
        })
      }
    };
  }
  const rotateOperatorId = pathId(
    path,
    /^\/cloud\/v1\/operators\/([^/]+)\/keys\/rotate$/
  );
  if (rotateOperatorId && method === "POST") {
    const body = await readBody(request);
    const overlap = body["overlap_seconds"];
    if (overlap !== undefined && typeof overlap !== "number") {
      throw new CloudError(422, "validation_failed", "overlap_seconds must be a number");
    }
    const expiresAt = body["expires_at"];
    return {
      status: 200,
      body: {
        data: await operators.rotateOperatorKey(actor, rotateOperatorId, {
          key_id: requiredString(body, "key_id"),
          ...(typeof overlap === "number" ? { overlap_seconds: overlap } : {}),
          ...(typeof expiresAt === "string" ? { expires_at: expiresAt } : {})
        })
      }
    };
  }
  const revokeOperatorId = pathId(
    path,
    /^\/cloud\/v1\/operators\/([^/]+)\/keys\/revoke$/
  );
  if (revokeOperatorId && method === "POST") {
    const body = await readBody(request);
    await operators.revokeOperatorKey(actor, revokeOperatorId, {
      key_id: requiredString(body, "key_id")
    });
    return { status: 200, body: { data: { revoked: true } } };
  }
  throw new CloudError(404, "not_found", "Cloud API route was not found");
}

export function createCloudServer(
  controlPlane: CloudControlPlane,
  options: CloudServerOptions
): Server {
  if (options.authenticator && options.apiKey) {
    throw new Error("Configure at most one Cloud API key or authenticator");
  }
  if (!options.authenticator && !options.apiKey && !options.operators) {
    throw new Error(
      "Configure a Cloud authenticator, API key, or operator directory"
    );
  }
  if (options.apiKey && options.apiKey.length < 16) {
    throw new Error("Cloud API key must contain at least 16 characters");
  }
  // The shared key can no longer reach data routes (PLA-442 fix 1), so there
  // is no per-request deprecation signal to throttle (fix 10): the boot-time
  // `cloud_shared_key_deprecated` notice in cli.ts is the single, once-per-boot
  // deprecation warning.
  const resolvedOptions: CloudServerOptions = options;
  const metrics = new CloudHttpMetrics();
  return createServer((request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://cloud.local");
    const path = url.pathname;
    response.once("finish", () => metrics.observe(method, response.statusCode));
    const headers = corsHeaders(request, options);
    if (method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }

    void (async () => {
      if (method === "GET" && path === "/health") {
        await options.healthCheck?.();
        sendJson(response, 200, {
          status: "ok",
          service: "lip-cloud-control-plane",
          instance_policy: "single",
          ...(options.databaseFingerprints
            ? {
                control_plane_database: options.databaseFingerprints.controlPlane,
                data_plane_database: options.databaseFingerprints.dataPlane
              }
            : {}),
          ...(options.deployment
            ? {
                environment: options.deployment.environment,
                release: options.deployment.release
              }
            : {})
        });
        return;
      }
      if (method === "GET" && path === "/metrics") {
        // Operator-only. The per-tenant server already gates its metrics; this
        // one is on a public URL and its series name tenants and environments,
        // so an unauthenticated scrape is a tenant-topology disclosure.
        await principal(request, resolvedOptions, { method, path });
        sendText(response, 200, metrics.render());
        return;
      }
      if (method === "POST" && path === "/cloud/v1/billing/webhooks/stripe") {
        const signature = request.headers["stripe-signature"];
        if (typeof signature !== "string" || !signature) {
          throw new CloudError(400, "missing_billing_signature", "Stripe-Signature is required");
        }
        const subscription = await controlPlane.applyBillingWebhook(
          await readRawBody(request),
          signature
        );
        sendJson(response, 200, {
          received: true,
          applied: Boolean(subscription)
        }, headers);
        return;
      }
      const customerResponse = await handleCustomerRoute({
        method,
        path,
        request,
        ...(resolvedOptions.customers ? { customers: resolvedOptions.customers } : {})
      });
      if (customerResponse) {
        sendJson(response, customerResponse.status, customerResponse.body, headers);
        return;
      }
      const actor = await principal(request, resolvedOptions, { method, path });

      const operatorResponse = await handleOperatorRoutes(
        actor,
        resolvedOptions,
        { method, path, request }
      );
      if (operatorResponse) {
        sendJson(
          response,
          operatorResponse.status,
          operatorResponse.body,
          { ...operatorResponse.headers, ...headers }
        );
        return;
      }
      if (method === "GET" && path === "/cloud/v1/plans") {
        sendJson(response, 200, { data: await controlPlane.plans(actor) }, headers);
        return;
      }
      if (method === "GET" && path === "/cloud/v1/organizations") {
        sendJson(
          response,
          200,
          { data: await controlPlane.organizations(actor) },
          headers
        );
        return;
      }
      if (method === "POST" && path === "/cloud/v1/organizations") {
        const body = await readBody(request);
        const dashboard = await controlPlane.createOrganization(actor, {
          name: requiredString(body, "name"),
          slug: requiredString(body, "slug")
        });
        sendJson(response, 201, { data: dashboard }, {
          location: `/cloud/v1/organizations/${dashboard.organization.organization_id}`,
          ...headers
        });
        return;
      }

      const organizationId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)$/
      );
      if (method === "GET" && organizationId) {
        sendJson(
          response,
          200,
          { data: await controlPlane.dashboard(actor, organizationId) },
          headers
        );
        return;
      }
      const organizationBillingCheckoutId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)\/billing\/checkout$/
      );
      if (organizationBillingCheckoutId && method === "POST") {
        const body = await readBody(request);
        sendJson(response, 201, {
          data: await controlPlane.createBillingCheckout(actor, organizationBillingCheckoutId, {
            plan_id: requiredString(body, "plan_id"),
            return_url: requiredString(body, "return_url")
          })
        }, headers);
        return;
      }
      const organizationBillingCancelId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)\/billing\/cancel$/
      );
      if (organizationBillingCancelId && method === "POST") {
        sendJson(response, 200, {
          data: await controlPlane.cancelBillingSubscription(actor, organizationBillingCancelId)
        }, headers);
        return;
      }
      const organizationProjectsId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)\/projects$/
      );
      if (organizationProjectsId && method === "GET") {
        sendJson(response, 200, {
          data: await controlPlane.projects(actor, organizationProjectsId)
        }, headers);
        return;
      }
      if (organizationProjectsId && method === "POST") {
        const body = await readBody(request);
        const project = await controlPlane.createProject(
          actor,
          organizationProjectsId,
          {
            name: requiredString(body, "name"),
            slug: requiredString(body, "slug")
          }
        );
        sendJson(response, 201, { data: project }, {
          location: `/cloud/v1/projects/${project.project_id}`,
          ...headers
        });
        return;
      }
      const organizationMembersId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)\/members$/
      );
      if (organizationMembersId && method === "GET") {
        sendJson(response, 200, {
          data: await controlPlane.members(actor, organizationMembersId)
        }, headers);
        return;
      }
      if (organizationMembersId && method === "PATCH") {
        const body = await readBody(request);
        const active = body["active"];
        const role = body["role"];
        sendJson(response, 200, {
          data: await controlPlane.updateMember(
            actor,
            organizationMembersId,
            {
              issuer: requiredString(body, "issuer"),
              subject: requiredString(body, "subject"),
              ...(typeof role === "string"
                ? { role: role as Exclude<CloudRole, "owner"> }
                : {}),
              ...(typeof active === "boolean" ? { active } : {})
            }
          )
        }, headers);
        return;
      }
      const organizationInvitationsId = pathId(
        path,
        /^\/cloud\/v1\/organizations\/([^/]+)\/invitations$/
      );
      if (organizationInvitationsId && method === "POST") {
        const body = await readBody(request);
        const result = await controlPlane.inviteMember(
          actor,
          organizationInvitationsId,
          {
            email: requiredString(body, "email"),
            role: requiredString(body, "role") as Exclude<CloudRole, "owner">,
            ...(typeof body["expires_at"] === "string"
              ? { expires_at: body["expires_at"] }
              : {})
          }
        );
        sendJson(response, 201, { data: result }, {
          location: `/cloud/v1/invitations/${result.invitation.invitation_id}`,
          ...headers
        });
        return;
      }
      if (method === "POST" && path === "/cloud/v1/invitations/accept") {
        const body = await readBody(request);
        sendJson(response, 200, {
          data: await controlPlane.acceptInvitation(
            actor,
            requiredString(body, "secret")
          )
        }, headers);
        return;
      }

      const projectEnvironmentsId = pathId(
        path,
        /^\/cloud\/v1\/projects\/([^/]+)\/environments$/
      );
      if (projectEnvironmentsId && method === "GET") {
        sendJson(response, 200, {
          data: await controlPlane.environments(actor, projectEnvironmentsId)
        }, headers);
        return;
      }
      if (projectEnvironmentsId && method === "POST") {
        const body = await readBody(request);
        const environment = await controlPlane.createEnvironment(
          actor,
          projectEnvironmentsId,
          {
            name: requiredString(body, "name"),
            slug: requiredString(body, "slug"),
            kind: requiredString(body, "kind") as EnvironmentKind,
            region: requiredString(body, "region"),
            program_id: requiredString(body, "program_id")
          }
        );
        sendJson(response, 201, { data: environment }, {
          location: `/cloud/v1/environments/${environment.environment_id}`,
          ...headers
        });
        return;
      }

      const environmentAttachId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/attach$/
      );
      if (environmentAttachId && method === "POST") {
        const body = await readBody(request);
        const environment = await controlPlane.attachEnvironment(actor, environmentAttachId, {
          endpoint_url: requiredString(body, "endpoint_url"),
          api_key: requiredString(body, "api_key")
        });
        sendJson(response, 200, { data: environment }, headers);
        return;
      }

      const environmentRotateId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/credentials\/rotate$/
      );
      if (environmentRotateId && method === "POST") {
        const body = await readBody(request);
        const overlap = body["overlap_seconds"];
        if (overlap !== undefined && typeof overlap !== "number") {
          throw new CloudError(422, "validation_failed", "overlap_seconds must be a number");
        }
        sendJson(response, 200, {
          data: await controlPlane.rotateEnvironmentCredentials(
            actor,
            environmentRotateId,
            options.rotateEnvironmentCredentials,
            typeof overlap === "number" ? { overlap_seconds: overlap } : {}
          )
        }, headers);
        return;
      }

      const environmentOperation = /^\/cloud\/v1\/environments\/([^/]+)\/operations\/(suspend|resume|backup|restore)$/.exec(path);
      if (environmentOperation?.[1] && environmentOperation[2] && method === "POST") {
        const body = await readBody(request);
        const operation = environmentOperation[2] as LocalEnvironmentOperation;
        sendJson(response, 200, {
          data: await controlPlane.operateLocalEnvironment(
            actor,
            decodeURIComponent(environmentOperation[1]),
            operation,
            options.operateLocalEnvironment,
            typeof body["backup_id"] === "string"
              ? { backup_id: body["backup_id"] }
              : {}
          )
        }, headers);
        return;
      }

      const environmentUsageEventsId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/usage-events$/
      );
      if (environmentUsageEventsId && method === "POST") {
        const body = await readBody(request);
        const quantity = body["quantity"];
        const result = await controlPlane.recordUsage(
          actor,
          environmentUsageEventsId,
          {
            metric: requiredString(body, "metric") as UsageMetric,
            quantity: typeof quantity === "number" ? quantity : Number.NaN,
            idempotency_key: requiredString(body, "idempotency_key"),
            ...(typeof body["occurred_at"] === "string"
              ? { occurred_at: body["occurred_at"] }
              : {}),
            ...(body["metadata"] &&
              typeof body["metadata"] === "object" &&
              !Array.isArray(body["metadata"])
              ? { metadata: body["metadata"] as Record<string, unknown> }
              : {})
          }
        );
        sendJson(response, result.duplicate ? 200 : 201, { data: result }, headers);
        return;
      }
      const environmentUsageId = pathId(
        path,
        /^\/cloud\/v1\/environments\/([^/]+)\/usage$/
      );
      if (environmentUsageId && method === "GET") {
        const at = url.searchParams.get("at");
        const date = at ? new Date(at) : undefined;
        if (date && !Number.isFinite(date.getTime())) {
          throw new CloudError(422, "validation_failed", "at must be an ISO timestamp");
        }
        sendJson(response, 200, {
          data: await controlPlane.usage(actor, environmentUsageId, date)
        }, headers);
        return;
      }

      throw new CloudError(404, "not_found", "Cloud API route was not found");
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof CloudError) {
        if (error.status === 401) response.setHeader("www-authenticate", "Bearer");
        sendProblem(response, error, headers);
        return;
      }
      if (error instanceof CustomerPlatformError) {
        sendJson(response, error.status, {
          type: `https://opensource-loyalty.dev/problems/${error.code}`,
          title: error.code,
          status: error.status,
          detail: error.message,
          code: error.code
        }, { "content-type": "application/problem+json; charset=utf-8", ...headers });
        return;
      }
      console.error("[lip-cloud] request failed", error);
      sendProblem(
        response,
        new CloudError(500, "internal_error", "Cloud control plane request failed"),
        headers
      );
    });
  });
}

export async function startCloudServer(
  controlPlane: CloudControlPlane,
  options: CloudServerOptions & { host?: string; port?: number }
): Promise<RunningCloudServer> {
  const server = createCloudServer(controlPlane, options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3220;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
