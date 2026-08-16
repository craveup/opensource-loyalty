import Stripe from "stripe";
import type {
  CloudOrganization,
  CloudPlan,
  CloudSubscription
} from "./types.js";

export interface BillingCheckout {
  checkout_id: string;
  url: string;
  expires_at: string;
}

export interface BillingSubscriptionUpdate {
  organization_id: string;
  plan_id: string;
  provider_customer_id: string;
  provider_subscription_id: string;
  status: CloudSubscription["status"];
  current_period_start: string;
  current_period_end: string;
}

/**
 * Provider boundary for the commercial billing adapter. The open control
 * plane owns plans, entitlements, and metering; Stripe or another provider
 * owns payment collection and sends normalized subscription updates here.
 */
export interface CloudBillingProvider {
  createCheckout(input: {
    organization: CloudOrganization;
    plan: CloudPlan;
    return_url: string;
  }): Promise<BillingCheckout>;
  cancelSubscription(
    subscription: CloudSubscription
  ): Promise<BillingSubscriptionUpdate>;
  parseWebhook(
    payload: string | Buffer,
    signature: string
  ): BillingSubscriptionUpdate | undefined;
}

export class UnconfiguredBillingProvider implements CloudBillingProvider {
  public async createCheckout(): Promise<never> {
    throw new Error("A Cloud billing provider has not been configured");
  }

  public async cancelSubscription(): Promise<never> {
    throw new Error("A Cloud billing provider has not been configured");
  }

  public parseWebhook(): never {
    throw new Error("A Cloud billing provider has not been configured");
  }
}

interface StripeCheckoutSession {
  id: string;
  url: string | null;
  expires_at: number;
}

interface StripeSubscription {
  id: string;
  status: string;
  customer: string | { id: string };
  metadata: Record<string, string>;
  items: {
    data: Array<{ current_period_start: number; current_period_end: number }>;
  };
}

interface StripeBillingClient {
  checkout: {
    sessions: {
      create(input: Record<string, unknown>): Promise<StripeCheckoutSession>;
    };
  };
  subscriptions: {
    cancel(id: string): Promise<StripeSubscription>;
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      signature: string,
      secret: string
    ): { type: string; data: { object: unknown } };
  };
}

export interface StripeBillingProviderOptions {
  secretKey: string;
  webhookSecret: string;
  priceIds: Record<string, string>;
  client?: StripeBillingClient;
}

function iso(seconds: number): string {
  const value = new Date(seconds * 1_000);
  if (!Number.isFinite(value.getTime())) throw new Error("Stripe period is invalid");
  return value.toISOString();
}

function subscriptionStatus(value: string): CloudSubscription["status"] {
  if (value === "trialing") return "trialing";
  if (value === "active") return "active";
  if (value === "past_due" || value === "unpaid") return "past_due";
  return "cancelled";
}

function normalizeStripeSubscription(value: StripeSubscription): BillingSubscriptionUpdate {
  const organizationId = value.metadata["lip_organization_id"];
  const planId = value.metadata["lip_plan_id"];
  const period = value.items.data[0];
  if (!organizationId || !planId || !period) {
    throw new Error("Stripe subscription is missing LIP metadata or its billing period");
  }
  return {
    organization_id: organizationId,
    plan_id: planId,
    provider_customer_id:
      typeof value.customer === "string" ? value.customer : value.customer.id,
    provider_subscription_id: value.id,
    status: subscriptionStatus(value.status),
    current_period_start: iso(period.current_period_start),
    current_period_end: iso(period.current_period_end)
  };
}

/** Stripe stays in the non-normative Cloud layer; no billing field reaches `/lip/v1`. */
export class StripeBillingProvider implements CloudBillingProvider {
  private readonly client: StripeBillingClient;
  private readonly webhookSecret: string;
  private readonly priceIds: Readonly<Record<string, string>>;

  public constructor(options: StripeBillingProviderOptions) {
    if (!options.secretKey.trim()) throw new Error("Stripe secret key is required");
    if (!options.webhookSecret.trim()) throw new Error("Stripe webhook secret is required");
    this.client = options.client ?? new Stripe(options.secretKey) as unknown as StripeBillingClient;
    this.webhookSecret = options.webhookSecret;
    this.priceIds = { ...options.priceIds };
  }

  public async createCheckout(input: {
    organization: CloudOrganization;
    plan: CloudPlan;
    return_url: string;
  }): Promise<BillingCheckout> {
    const price = this.priceIds[input.plan.plan_id];
    if (!price) throw new Error(`No Stripe price is configured for plan ${input.plan.plan_id}`);
    const metadata = {
      lip_organization_id: input.organization.organization_id,
      lip_plan_id: input.plan.plan_id
    };
    const separator = input.return_url.includes("?") ? "&" : "?";
    const session = await this.client.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      client_reference_id: input.organization.organization_id,
      metadata,
      subscription_data: { metadata },
      success_url: `${input.return_url}${separator}billing=success`,
      cancel_url: `${input.return_url}${separator}billing=canceled`
    });
    if (!session.url) throw new Error("Stripe did not return a Checkout URL");
    return {
      checkout_id: session.id,
      url: session.url,
      expires_at: iso(session.expires_at)
    };
  }

  public async cancelSubscription(
    subscription: CloudSubscription
  ): Promise<BillingSubscriptionUpdate> {
    if (!subscription.provider_subscription_id) {
      throw new Error("Subscription has no Stripe subscription id");
    }
    return normalizeStripeSubscription(
      await this.client.subscriptions.cancel(subscription.provider_subscription_id)
    );
  }

  public parseWebhook(
    payload: string | Buffer,
    signature: string
  ): BillingSubscriptionUpdate | undefined {
    const event = this.client.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret
    );
    if (![
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted"
    ].includes(event.type)) return undefined;
    return normalizeStripeSubscription(event.data.object as StripeSubscription);
  }
}
