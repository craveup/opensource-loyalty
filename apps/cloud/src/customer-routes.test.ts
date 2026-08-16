import { describe, expect, it } from "vitest";
import { CustomerPlatformError } from "./customer-errors.js";
import { MemoryCustomerRepository } from "./customer-memory-repository.js";
import { CustomerPlatform } from "./customer-service.js";
import type {
  CustomerExternalIdentity,
  CustomerIdentityProvider,
  VerifiedCustomerIdentity
} from "./customer-types.js";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudControlPlane } from "./service.js";
import { startCloudServer } from "./server.js";

class RouteIdentityProvider implements CustomerIdentityProvider {
  public readonly kind = "oidc" as const;

  public constructor(
    public readonly provider_id = "primary",
    private readonly acceptedToken = "customer-token",
    private readonly subject = "customer-1"
  ) {}

  public async verifySession(input: {
    tenant_id: string;
    token: string;
  }): Promise<VerifiedCustomerIdentity> {
    if (input.tenant_id !== "tenant_acme" || input.token !== this.acceptedToken) {
      throw new CustomerPlatformError(401, "invalid_token", "Invalid customer token");
    }
    return {
      provider_id: this.provider_id,
      provider_kind: this.kind,
      tenant_id: input.tenant_id,
      issuer: "https://identity.example.com",
      subject: this.subject,
      audiences: ["customer-api"],
      expires_at: "2030-08-15T00:00:00.000Z",
      email: { value: "customer@example.com" }
    };
  }

  public async deleteIdentity(_identity: CustomerExternalIdentity) {
    return "deleted" as const;
  }
}

describe("managed customer HTTP routes", () => {
  it("re-verifies the external token and supports profile, consent, loyalty, export, and delete", async () => {
    const customers = new CustomerPlatform({
      repository: new MemoryCustomerRepository(),
      providers: [
        new RouteIdentityProvider(),
        new RouteIdentityProvider("secondary", "secondary-token", "customer-secondary")
      ],
      loyalty: {
        enroll: async ({ customer_id }) => ({ member_id: `member_${customer_id}` })
      },
      customerId: () => "crv_cus_route_test"
    });
    await customers.migrate();
    const cloud = new CloudControlPlane({ repository: new MemoryCloudRepository() });
    const running = await startCloudServer(cloud, {
      apiKey: "cloud-bootstrap-key-for-tests",
      customers,
      port: 0
    });
    const headers = {
      authorization: "Bearer customer-token",
      "x-lip-tenant-id": "tenant_acme",
      "x-lip-customer-provider": "primary",
      "content-type": "application/json"
    };
    try {
      const session = await fetch(`${running.url}/cloud/v1/customer/session`, {
        method: "POST",
        headers
      });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({
        data: { customer_id: "crv_cus_route_test", provider_id: "primary" }
      });

      const profile = await fetch(`${running.url}/cloud/v1/customer/profile`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ given_name: "Avery", locale: "en-US" })
      });
      expect(await profile.json()).toMatchObject({
        data: { given_name: "Avery", locale: "en-US" }
      });
      expect((await fetch(`${running.url}/cloud/v1/customer/consents`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          purpose: "marketing",
          status: "granted",
          policy_version: "2026-08",
          source: "checkout"
        })
      })).status).toBe(200);
      expect((await fetch(`${running.url}/cloud/v1/customer/identities/link`, {
        method: "POST",
        headers,
        body: JSON.stringify({ provider_id: "secondary", token: "secondary-token" })
      })).status).toBe(201);
      expect((await fetch(`${running.url}/cloud/v1/customer/loyalty/enroll`, {
        method: "POST",
        headers,
        body: JSON.stringify({ program_id: "acme-rewards" })
      })).status).toBe(201);

      const exported = await fetch(`${running.url}/cloud/v1/customer/export`, { headers });
      expect(await exported.json()).toMatchObject({
        data: {
          customer: { customer_id: "crv_cus_route_test" },
          identities: [
            { provider_id: "primary" },
            { provider_id: "secondary" }
          ],
          consents: [{ purpose: "marketing", status: "granted" }],
          loyalty_memberships: [{ program_id: "acme-rewards" }]
        }
      });
      expect((await fetch(`${running.url}/cloud/v1/customer/account`, {
        method: "DELETE",
        headers
      })).status).toBe(200);

      const rejected = await fetch(`${running.url}/cloud/v1/customer/profile`, {
        headers: { ...headers, authorization: "Bearer wrong" }
      });
      expect(rejected.status).toBe(401);
    } finally {
      await running.close();
      await customers.close();
      await cloud.close();
    }
  });
});
