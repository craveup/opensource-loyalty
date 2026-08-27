import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

const MAX_BODY_BYTES = 131_072;
const SESSION_COOKIE = "lip_wallet_session";
const STATE_COOKIE = "lip_wallet_oauth_state";
const MAX_PENDING_LOGINS = 1_000;
const MAX_SESSIONS = 10_000;
const UPSTREAM_TIMEOUT_MS = 5_000;

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface PendingLogin {
  verifier: string;
  nonce: string;
  expires_at: number;
}

interface WalletSession {
  access_token: string;
  csrf: string;
  expires_at: number;
}

export interface WalletServerOptions {
  publicBaseUrl: string;
  cloudBaseUrl: string;
  tenantId: string;
  providerId: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  demo?: boolean;
  fetchImpl?: typeof globalThis.fetch;
  host?: string;
  port?: number;
}

export interface RunningWalletServer {
  url: string;
  close(): Promise<void>;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const entry of request.headers.cookie?.split(";") ?? []) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return undefined;
}

function cookieAttributes(baseUrl: string, httpOnly = true): string {
  const secure = new URL(baseUrl).protocol === "https:" ? "; Secure" : "";
  return `; Path=/; SameSite=Lax${secure}${httpOnly ? "; HttpOnly" : ""}`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  response.end(body);
}

function sendProblem(response: ServerResponse, status: number, code: string, detail: string): void {
  sendJson(response, status, {
    type: `https://loyalty-interchange.org/problems/${code}`,
    title: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Request failed",
    status,
    code,
    detail
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 128 KiB");
    chunks.push(value);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function isSameOrigin(request: IncomingMessage, publicBaseUrl: string): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === new URL(publicBaseUrl).origin;
}

function safeServiceUrl(value: URL, name: string, allowDemoHttp = false): URL {
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(value.hostname);
  if (value.protocol !== "https:" && !(value.protocol === "http:" && (loopback || allowDemoHttp))) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only for loopback development)`);
  }
  if (value.username || value.password || value.search || value.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or fragments`);
  }
  return value;
}

function syntheticWallet(): Record<string, unknown> {
  return {
    data: {
      session: {
        active: true,
        customer_id: "demo-customer-001",
        profile: { given_name: "Demo Guest", locale: "en-US" }
      },
      account: {
        customer: { customer_id: "demo-customer-001", status: "active" },
        consents: [{ purpose: "marketing", status: "granted", policy_version: "demo-v1" }],
        loyalty_memberships: [{
          program_id: "demo-foodservice",
          member_id: "demo-member-003",
          enrolled_at: "2026-08-01T12:00:00.000Z"
        }]
      },
      wallet: {
        points: 1_700,
        tier: "VIP",
        rewards: [
          { reward_id: "five-off", name: "$5 off", points_cost: 500 },
          { reward_id: "free-entree", name: "Free entree", points_cost: 1_000 }
        ]
      }
    },
    demo: true
  };
}

export async function startWalletServer(options: WalletServerOptions): Promise<RunningWalletServer> {
  const publicBaseUrl = safeServiceUrl(new URL(options.publicBaseUrl), "WALLET_PUBLIC_BASE_URL");
  const cloudBaseUrl = safeServiceUrl(
    new URL(options.cloudBaseUrl),
    "WALLET_CLOUD_BASE_URL",
    options.demo === true
  );
  if (options.oidcIssuer) {
    safeServiceUrl(new URL(options.oidcIssuer), "WALLET_OIDC_ISSUER");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const pending = new Map<string, PendingLogin>();
  const sessions = new Map<string, WalletSession>();
  let discoveryCache: OidcDiscovery | undefined;
  let htmlCache: string | undefined;

  const pruneExpired = (): void => {
    const now = Date.now();
    for (const [state, login] of pending) {
      if (login.expires_at <= now) pending.delete(state);
    }
    for (const [id, session] of sessions) {
      if (session.expires_at <= now) sessions.delete(id);
    }
  };

  const discovery = async (): Promise<OidcDiscovery> => {
    if (discoveryCache) return discoveryCache;
    if (!options.oidcIssuer || !options.oidcClientId) {
      throw new Error("Wallet OIDC is not configured");
    }
    const issuer = new URL(options.oidcIssuer);
    const response = await fetchImpl(new URL(".well-known/openid-configuration", `${issuer.toString().replace(/\/$/, "")}/`), {
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
    const value = await response.json() as Partial<OidcDiscovery>;
    if (
      value.issuer !== issuer.toString().replace(/\/$/, "") ||
      !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri
    ) {
      throw new Error("OIDC discovery document is incomplete or has a different issuer");
    }
    for (const [name, endpoint] of [
      ["OIDC authorization endpoint", value.authorization_endpoint],
      ["OIDC token endpoint", value.token_endpoint],
      ["OIDC JWKS endpoint", value.jwks_uri]
    ] as const) {
      safeServiceUrl(new URL(endpoint!), name);
    }
    discoveryCache = value as OidcDiscovery;
    return discoveryCache;
  };

  const cloudRequest = async (
    path: string,
    session: WalletSession,
    init: RequestInit = {}
  ): Promise<Response> => fetchImpl(new URL(path, cloudBaseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${session.access_token}`,
      "x-lip-tenant-id": options.tenantId,
      "x-lip-customer-provider": options.providerId,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    },
    redirect: "error",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });

  const activeSession = (request: IncomingMessage): WalletSession | undefined => {
    pruneExpired();
    const id = cookie(request, SESSION_COOKIE);
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.expires_at <= Date.now()) {
      if (id) sessions.delete(id);
      return undefined;
    }
    return session;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", publicBaseUrl);

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", service: "reference-wallet" });
        return;
      }

      if (method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, {
          demo: options.demo ?? false,
          oidc_configured: Boolean(options.oidcIssuer && options.oidcClientId)
        });
        return;
      }

      if (method === "GET" && url.pathname === "/auth/login") {
        if (options.demo) {
          response.writeHead(302, { location: "/?demo=1", "cache-control": "no-store" });
          response.end();
          return;
        }
        const document = await discovery();
        pruneExpired();
        if (pending.size >= MAX_PENDING_LOGINS) {
          sendProblem(response, 503, "login_capacity", "Too many login attempts are pending");
          return;
        }
        const state = base64Url(randomBytes(24));
        const nonce = base64Url(randomBytes(24));
        const verifier = base64Url(randomBytes(48));
        const challenge = base64Url(createHash("sha256").update(verifier).digest());
        pending.set(state, { verifier, nonce, expires_at: Date.now() + 10 * 60_000 });
        const authorization = new URL(document.authorization_endpoint);
        authorization.searchParams.set("client_id", options.oidcClientId!);
        authorization.searchParams.set("redirect_uri", new URL("/auth/callback", publicBaseUrl).toString());
        authorization.searchParams.set("response_type", "code");
        authorization.searchParams.set("scope", "openid profile email");
        authorization.searchParams.set("state", state);
        authorization.searchParams.set("nonce", nonce);
        authorization.searchParams.set("code_challenge", challenge);
        authorization.searchParams.set("code_challenge_method", "S256");
        response.writeHead(302, {
          location: authorization.toString(),
          "set-cookie": `${STATE_COOKIE}=${encodeURIComponent(state)}${cookieAttributes(publicBaseUrl.toString())}; Max-Age=600`,
          "cache-control": "no-store"
        });
        response.end();
        return;
      }

      if (method === "GET" && url.pathname === "/auth/callback") {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const cookieState = cookie(request, STATE_COOKIE);
        const login = state ? pending.get(state) : undefined;
        if (!state || !code || !cookieState || state !== cookieState || !login || login.expires_at <= Date.now()) {
          sendProblem(response, 400, "invalid_oauth_state", "The login response could not be verified");
          return;
        }
        pending.delete(state);
        const document = await discovery();
        const tokenBody = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: options.oidcClientId!,
          redirect_uri: new URL("/auth/callback", publicBaseUrl).toString(),
          code,
          code_verifier: login.verifier,
          ...(options.oidcClientSecret ? { client_secret: options.oidcClientSecret } : {})
        });
        const tokenResponse = await fetchImpl(document.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: tokenBody,
          redirect: "error",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
        if (!tokenResponse.ok) {
          sendProblem(response, 401, "token_exchange_failed", "The identity provider rejected the login response");
          return;
        }
        const tokens = await tokenResponse.json() as {
          access_token?: string;
          id_token?: string;
          expires_in?: number;
        };
        if (!tokens.access_token || !tokens.id_token) {
          sendProblem(response, 401, "invalid_token_response", "The identity provider omitted required tokens");
          return;
        }
        const jwksResponse = await fetchImpl(document.jwks_uri, {
          redirect: "error",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
        if (!jwksResponse.ok) throw new Error(`OIDC JWKS returned HTTP ${jwksResponse.status}`);
        const jwks = await jwksResponse.json() as JSONWebKeySet;
        const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
          issuer: document.issuer,
          audience: options.oidcClientId!
        });
        if (verified.payload.nonce !== login.nonce) {
          sendProblem(response, 401, "invalid_nonce", "The login response nonce did not match");
          return;
        }
        const sessionId = randomUUID();
        const maxAgeSeconds = Math.max(60, Math.min(tokens.expires_in ?? 3600, 8 * 3600));
        pruneExpired();
        if (sessions.size >= MAX_SESSIONS) {
          sendProblem(response, 503, "session_capacity", "The wallet cannot create another session");
          return;
        }
        sessions.set(sessionId, {
          access_token: tokens.access_token,
          csrf: base64Url(randomBytes(24)),
          expires_at: Date.now() + maxAgeSeconds * 1000
        });
        response.writeHead(302, {
          location: "/",
          "set-cookie": [
            `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}${cookieAttributes(publicBaseUrl.toString())}; Max-Age=${maxAgeSeconds}`,
            `${STATE_COOKIE}=${cookieAttributes(publicBaseUrl.toString())}; Max-Age=0`
          ],
          "cache-control": "no-store"
        });
        response.end();
        return;
      }

      if (method === "POST" && url.pathname === "/auth/logout") {
        if (!isSameOrigin(request, publicBaseUrl.toString())) {
          sendProblem(response, 403, "origin_mismatch", "Sign out requires a same-origin request");
          return;
        }
        const sessionId = cookie(request, SESSION_COOKIE);
        if (sessionId) sessions.delete(sessionId);
        response.writeHead(204, {
          "set-cookie": `${SESSION_COOKIE}=${cookieAttributes(publicBaseUrl.toString())}; Max-Age=0`,
          "cache-control": "no-store"
        });
        response.end();
        return;
      }

      if (method === "GET" && url.pathname === "/api/session" && options.demo) {
        sendJson(response, 200, syntheticWallet());
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        const session = activeSession(request);
        if (!session) {
          sendProblem(response, 401, "unauthorized", "Sign in to use the wallet");
          return;
        }
        if (!["GET", "HEAD"].includes(method)) {
          if (!isSameOrigin(request, publicBaseUrl.toString())) {
            sendProblem(response, 403, "origin_mismatch", "Wallet writes require a same-origin request");
            return;
          }
          if (request.headers["x-lip-wallet-csrf"] !== session.csrf) {
            sendProblem(response, 403, "csrf_failed", "Wallet writes require a valid CSRF token");
            return;
          }
        }
        if (method === "GET" && url.pathname === "/api/session") {
          const [sessionResponse, accountResponse] = await Promise.all([
            cloudRequest("/cloud/v1/customer/session", session, { method: "POST" }),
            cloudRequest("/cloud/v1/customer/export", session)
          ]);
          if (!sessionResponse.ok || !accountResponse.ok) {
            sendProblem(response, 502, "customer_api_failed", "The customer API could not load the wallet");
            return;
          }
          sendJson(response, 200, {
            data: {
              session: (await sessionResponse.json() as { data: unknown }).data,
              account: (await accountResponse.json() as { data: unknown }).data,
              csrf: session.csrf
            }
          });
          return;
        }
        if (method === "POST" && url.pathname === "/api/consent") {
          const values = await readJson(request);
          const upstream = await cloudRequest("/cloud/v1/customer/consents", session, {
            method: "POST",
            body: JSON.stringify(values)
          });
          sendJson(response, upstream.status, await upstream.json());
          return;
        }
        if (method === "PATCH" && url.pathname === "/api/profile") {
          const values = await readJson(request);
          const upstream = await cloudRequest("/cloud/v1/customer/profile", session, {
            method: "PATCH",
            body: JSON.stringify(values)
          });
          sendJson(response, upstream.status, await upstream.json());
          return;
        }
      }

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        htmlCache ??= await readFile(new URL("../public/index.html", import.meta.url), "utf8");
        const nonce = base64Url(randomBytes(18));
        const html = htmlCache.replaceAll("{{NONCE}}", nonce);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "cache-control": "no-store",
          "content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
          "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY"
        });
        response.end(html);
        return;
      }

      sendProblem(response, 404, "not_found", "Wallet route was not found");
    })().catch((error: unknown) => {
      sendProblem(
        response,
        500,
        "wallet_error",
        error instanceof Error && error.message === "Wallet OIDC is not configured"
          ? error.message
          : "The wallet could not complete this request"
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
