import { describe, expect, it } from "vitest";
import { startWalletServer } from "./server.js";

describe("reference wallet BFF", () => {
  it("serves a public-safe synthetic wallet with hardened browser headers", async () => {
    const running = await startWalletServer({
      publicBaseUrl: "http://127.0.0.1:3230",
      cloudBaseUrl: "http://127.0.0.1:3220",
      tenantId: "demo-foodservice",
      providerId: "primary",
      demo: true
    });
    try {
      const page = await fetch(running.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(page.headers.get("permissions-policy")).toContain("payment=()");
      expect(await page.text()).toContain("Your rewards, ready when you are");
      expect(await (await fetch(`${running.url}/api/session`)).json()).toMatchObject({
        demo: true,
        data: {
          wallet: { points: 1700, tier: "VIP" },
          account: { customer: { customer_id: "demo-customer-001" } }
        }
      });
    } finally {
      await running.close();
    }
  });

  it("starts OIDC authorization with state, nonce, and PKCE while keeping secrets server-side", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://identity.example.test",
          authorization_endpoint: "https://identity.example.test/authorize",
          token_endpoint: "https://identity.example.test/token",
          jwks_uri: "https://identity.example.test/jwks"
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const running = await startWalletServer({
      publicBaseUrl: "https://wallet.example.test",
      cloudBaseUrl: "https://customer-api.example.test",
      tenantId: "tenant-demo",
      providerId: "primary",
      oidcIssuer: "https://identity.example.test",
      oidcClientId: "wallet-client",
      oidcClientSecret: "server-only-example-secret",
      fetchImpl
    });
    try {
      const login = await fetch(`${running.url}/auth/login`, { redirect: "manual" });
      expect(login.status).toBe(302);
      const location = new URL(login.headers.get("location")!);
      expect(location.origin).toBe("https://identity.example.test");
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("code_challenge")).toBeTruthy();
      expect(location.searchParams.get("nonce")).toBeTruthy();
      expect(location.searchParams.get("state")).toBeTruthy();
      expect(location.search).not.toContain("server-only-example-secret");
      expect(login.headers.get("set-cookie")).toContain("HttpOnly");
      expect(login.headers.get("set-cookie")).toContain("Secure");
    } finally {
      await running.close();
    }
  });

  it("rejects customer APIs without a BFF session", async () => {
    const running = await startWalletServer({
      publicBaseUrl: "http://127.0.0.1:3230",
      cloudBaseUrl: "http://127.0.0.1:3220",
      tenantId: "tenant-demo",
      providerId: "primary",
      oidcIssuer: "https://identity.example.test",
      oidcClientId: "wallet-client"
    });
    try {
      const response = await fetch(`${running.url}/api/session`);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "unauthorized" });
    } finally {
      await running.close();
    }
  });
});
