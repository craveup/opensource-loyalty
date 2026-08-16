import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { StripeBillingProvider } from "./billing.js";
import { MemoryCloudRepository } from "./memory-repository.js";
import { startCloudServer } from "./server.js";
import { CloudControlPlane } from "./service.js";

const organization = {
  organization_id: "org_acme",
  slug: "acme",
  name: "Acme",
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z"
};
const plan = {
  plan_id: "pro",
  name: "Pro",
  active: true,
  monthly_price_minor: 9_900,
  currency: "USD",
  included_usage: { monthly_active_members: 10_000, loyalty_transactions: 100_000, messages: 0 },
  hard_limits: { monthly_active_members: 20_000, loyalty_transactions: 200_000, messages: 0 },
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z"
};

function stripeSubscription(status = "active") {
  return {
    id: "sub_stripe_1",
    object: "subscription",
    customer: "cus_stripe_1",
    status,
    metadata: {
      lip_organization_id: "org_acme",
      lip_plan_id: "pro"
    },
    items: {
      data: [{ current_period_start: 1_776_211_200, current_period_end: 1_778_803_200 }]
    }
  };
}

describe("StripeBillingProvider", () => {
  it("creates a metadata-bound subscription checkout", async () => {
    const create = vi.fn(async () => ({
      id: "cs_1",
      url: "https://checkout.stripe.test/cs_1",
      expires_at: 1_776_214_800
    }));
    const provider = new StripeBillingProvider({
      secretKey: "sk_test_local",
      webhookSecret: "whsec_local",
      priceIds: { pro: "price_pro" },
      client: {
        checkout: { sessions: { create } },
        subscriptions: { cancel: async () => stripeSubscription("canceled") },
        webhooks: { constructEvent: () => ({ type: "ignored", data: { object: {} } }) }
      }
    });
    await expect(provider.createCheckout({
      organization,
      plan,
      return_url: "https://app.example.com/settings"
    })).resolves.toEqual({
      checkout_id: "cs_1",
      url: "https://checkout.stripe.test/cs_1",
      expires_at: "2026-04-15T01:00:00.000Z"
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription",
      line_items: [{ price: "price_pro", quantity: 1 }],
      subscription_data: {
        metadata: { lip_organization_id: "org_acme", lip_plan_id: "pro" }
      }
    }));
  });

  it("verifies a signed Stripe webhook before normalizing it", () => {
    const webhookSecret = "whsec_test_billing";
    const payload = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "customer.subscription.updated",
      data: { object: stripeSubscription() }
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
      timestamp: Math.floor(Date.now() / 1_000)
    });
    const provider = new StripeBillingProvider({
      secretKey: "sk_test_local",
      webhookSecret,
      priceIds: { pro: "price_pro" }
    });
    expect(provider.parseWebhook(payload, signature)).toMatchObject({
      organization_id: "org_acme",
      plan_id: "pro",
      provider_customer_id: "cus_stripe_1",
      provider_subscription_id: "sub_stripe_1",
      status: "active"
    });
    expect(() => provider.parseWebhook(payload, `${signature}bad`)).toThrow();
  });

  it("persists only a verified provider update in the Cloud subscription", async () => {
    const repository = new MemoryCloudRepository();
    const billing = {
      createCheckout: vi.fn(async () => ({
        checkout_id: "cs_1",
        url: "https://checkout.stripe.test/cs_1",
        expires_at: "2026-08-15T21:00:00.000Z"
      })),
      cancelSubscription: vi.fn(),
      parseWebhook: vi.fn(() => ({
        organization_id: expect.anything() as unknown as string,
        plan_id: "pro",
        provider_customer_id: "cus_1",
        provider_subscription_id: "sub_1",
        status: "active" as const,
        current_period_start: "2026-08-01T00:00:00.000Z",
        current_period_end: "2026-09-01T00:00:00.000Z"
      }))
    };
    const cloud = new CloudControlPlane({ repository, billing });
    const owner = { issuer: "https://identity.example.com", subject: "owner" };
    const dashboard = await cloud.createOrganization(owner, {
      name: "Acme Restaurants",
      slug: "acme-restaurants"
    });
    const organizationId = dashboard.organization.organization_id;
    billing.parseWebhook.mockReturnValue({
      organization_id: organizationId,
      plan_id: "pro",
      provider_customer_id: "cus_1",
      provider_subscription_id: "sub_1",
      status: "active",
      current_period_start: "2026-08-01T00:00:00.000Z",
      current_period_end: "2026-09-01T00:00:00.000Z"
    });
    await expect(cloud.createBillingCheckout(owner, organizationId, {
      plan_id: "pro",
      return_url: "https://app.example.com/settings"
    })).resolves.toMatchObject({ checkout_id: "cs_1" });
    const updated = await cloud.applyBillingWebhook("signed", "signature");
    expect(updated).toMatchObject({
      organization_id: organizationId,
      plan_id: "pro",
      billing_provider: "stripe",
      provider_subscription_id: "sub_1"
    });
  });

  it("accepts only a signed Stripe event at the HTTP webhook boundary", async () => {
    const webhookSecret = "whsec_test_http_boundary";
    const repository = new MemoryCloudRepository();
    const provider = new StripeBillingProvider({
      secretKey: "sk_test_local",
      webhookSecret,
      priceIds: { pro: "price_pro" }
    });
    const cloud = new CloudControlPlane({ repository, billing: provider });
    const owner = { issuer: "https://identity.example.com", subject: "owner-http" };
    const dashboard = await cloud.createOrganization(owner, {
      name: "HTTP Billing Restaurants",
      slug: "http-billing-restaurants"
    });
    const payload = JSON.stringify({
      id: "evt_http_1",
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          ...stripeSubscription(),
          metadata: {
            lip_organization_id: dashboard.organization.organization_id,
            lip_plan_id: "pro"
          }
        }
      }
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
      timestamp: Math.floor(Date.now() / 1_000)
    });
    const running = await startCloudServer(cloud, {
      apiKey: "cloud-billing-http-key",
      port: 0
    });
    const url = `${running.url}/cloud/v1/billing/webhooks/stripe`;
    try {
      expect((await fetch(url, { method: "POST", body: payload })).status).toBe(400);
      expect((await fetch(url, {
        method: "POST",
        headers: { "stripe-signature": `${signature}bad` },
        body: payload
      })).status).toBe(400);
      const accepted = await fetch(url, {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: payload
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ received: true, applied: true });
      expect(await repository.subscriptionForOrganization(
        dashboard.organization.organization_id
      )).toMatchObject({
        plan_id: "pro",
        billing_provider: "stripe",
        provider_subscription_id: "sub_stripe_1"
      });
    } finally {
      await running.close();
      await cloud.close();
    }
  });
});
