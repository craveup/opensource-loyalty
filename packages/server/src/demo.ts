import type { FoodserviceOrder, RequestContext } from "@loyalty-interchange/protocol";
import { LoyaltyEngine, type ProgramDefinition } from "@loyalty-interchange/reference";
import type { LocationDirectoryService } from "./locations.js";

export function createDemoProgram(): ProgramDefinition {
  return {
    program_id: "demo-foodservice",
    name: "Demo Foodservice Rewards",
    description: "A seeded multi-tier program for local LIP development.",
    currency: "USD",
    earning_policy: {
      minimum_eligible_spend_minor_units: 100,
      eligible_channels: ["counter", "drive_thru", "web", "mobile"],
      excluded_category_ids: ["alcohol", "gift-cards"],
      excluded_tags: ["service-fee", "merch", "donation", "packaging", "delivery-fee"]
    },
    accounts: [{ unit: "points", unit_label: "points", is_primary: true }],
    metrics: [
      {
        metric_id: "lifetime-earned",
        name: "Lifetime points",
        unit: "points",
        source: "lifetime_earned"
      },
      {
        metric_id: "tier-qualifying",
        name: "Tier qualifying points",
        unit: "points",
        source: "qualification_earned"
      }
    ],
    tiers: [
      {
        tier_id: "starter",
        name: "Starter",
        qualification_metric_id: "tier-qualifying",
        minimum: 0,
        benefits: []
      },
      {
        tier_id: "regular",
        name: "Regular",
        qualification_metric_id: "tier-qualifying",
        minimum: 500,
        earn_multiplier_bps: 12_000,
        benefits: [{ benefit_id: "birthday-reward", name: "Birthday reward" }]
      },
      {
        tier_id: "vip",
        name: "VIP",
        qualification_metric_id: "tier-qualifying",
        minimum: 1_500,
        earn_multiplier_bps: 12_000,
        benefits: [{ benefit_id: "early-access", name: "Seasonal item early access" }]
      }
    ],
    tier_policy: {
      metric_id: "tier-qualifying",
      period: {
        type: "annual",
        starts_month: 1,
        starts_day: 1,
        time_zone: "America/New_York"
      },
      effective_from: "2026-01-01"
    },
    point_expiration: {
      type: "after_earned",
      days: 365,
      warning_days: [30, 7]
    },
    earn_rate: { points: 10, spend_minor_units: 100 },
    evaluation_ttl_seconds: 300,
    reservation_ttl_seconds: 120,
    rewards: [
      {
        reward_id: "five-off",
        name: "$5 off",
        points_cost: 500,
        effect: {
          type: "discount",
          target: "order",
          amount: { amount: 500, currency: "USD" },
          allocations: [{ amount: { amount: 500, currency: "USD" } }]
        },
        funding: [
          { party_id: "demo-brand", party_type: "brand", share_bps: 7000 },
          { party_id: "demo-franchise-network", party_type: "franchisee", share_bps: 3000 }
        ]
      },
      {
        reward_id: "free-entree",
        name: "Free entree",
        description: "One eligible entree up to $12.",
        points_cost: 1_000,
        effect: {
          type: "free_item",
          category_ids: ["entrees"],
          max_quantity: 1,
          max_value: { amount: 1_200, currency: "USD" }
        },
        funding: [
          { party_id: "demo-brand", party_type: "brand", share_bps: 7000 },
          { party_id: "demo-franchise-network", party_type: "franchisee", share_bps: 3000 }
        ]
      }
    ]
  };
}

interface DemoMemberProfile {
  memberId: string;
  name: string;
  email: string;
  points: number;
  channel: FoodserviceOrder["channel"];
  marketingConsent: boolean;
  redeem?: boolean;
  refund?: number;
}

const demoMembers: DemoMemberProfile[] = [
  { memberId: "demo-member-001", name: "Maya Chen", email: "maya@example.test", points: 180, channel: "mobile", marketingConsent: true },
  { memberId: "demo-member-002", name: "Jordan Brooks", email: "jordan@example.test", points: 620, channel: "drive_thru", marketingConsent: true },
  { memberId: "demo-member-003", name: "Priya Shah", email: "priya@example.test", points: 1_700, channel: "web", marketingConsent: true, redeem: true },
  { memberId: "demo-member-004", name: "Luis Martinez", email: "luis@example.test", points: 940, channel: "counter", marketingConsent: false, refund: 30 },
  { memberId: "demo-member-005", name: "Avery Morgan", email: "avery@example.test", points: 120, channel: "mobile", marketingConsent: false },
  { memberId: "demo-member-006", name: "Samira Okafor", email: "samira@example.test", points: 2_380, channel: "drive_thru", marketingConsent: true, redeem: true }
];

function demoContext(key: string): RequestContext {
  return {
    protocol_version: "1.0",
    profile: "foodservice/1.0",
    request_id: `seed-${key}`,
    idempotency_key: `seed-${key}`,
    occurred_at: new Date().toISOString(),
    source: { system: "lip-demo-seed" }
  };
}

function demoOrder(
  memberId: string,
  orderId: string,
  eligibleSpend: number,
  channel: FoodserviceOrder["channel"]
): FoodserviceOrder {
  const now = new Date().toISOString();
  const money = (amount: number) => ({ amount, currency: "USD" as const });
  return {
    order_id: orderId,
    order_number: orderId.replace("seed-order-", "D-"),
    scope: {
      program_id: "demo-foodservice",
      brand_id: "demo-brand",
      merchant_id: "demo-franchise-network",
      location_id: "location-014",
      franchisee_id: "franchisee-west"
    },
    member_id: memberId,
    channel,
    status: "paid",
    business_date: now.slice(0, 10),
    placed_at: now,
    closed_at: now,
    lines: [{
      line_id: `${orderId}-line`,
      kind: "item",
      product_id: "build-your-own-bowl",
      name: "Build Your Own Bowl",
      quantity: 1,
      unit_price: money(eligibleSpend),
      subtotal: money(eligibleSpend),
      discount: money(0),
      tax: money(0),
      category_ids: ["entrees"],
      loyalty_eligible: true
    }],
    totals: {
      subtotal: money(eligibleSpend),
      discount: money(0),
      tax: money(0),
      tip: money(0),
      service_charge: money(0),
      total: money(eligibleSpend)
    },
    tenders: [{ tender_id: `${orderId}-tender`, type: "card", amount: money(eligibleSpend) }]
  };
}

/**
 * Registers the location the seeded demo orders accrue at so demo location
 * reports show a named, franchisee-attributed registry row. Idempotent: an
 * already-populated registry is left untouched.
 */
export async function seedDemoLocations(locations: LocationDirectoryService): Promise<void> {
  if (locations.listLocations().length > 0) return;
  await locations.upsertLocation({
    location_id: "location-014",
    name: "West Market",
    franchisee_id: "franchisee-west"
  }, "lip-demo-seed");
}

export function seedDemoData(engine: LoyaltyEngine): void {
  if (engine.inspectAdmin().summary.active_members > 0) return;

  for (const [index, profile] of demoMembers.entries()) {
    const orderId = `seed-order-${index + 1}`;
    const spend = profile.points * 10;
    engine.enroll({
      context: demoContext(`enroll-${index + 1}`),
      program_id: "demo-foodservice",
      member_id: profile.memberId,
      identity: { type: "external", value: `demo-guest-${index + 1}`, issuer: "demo-crm" },
      attributes: {
        name: profile.name,
        email: profile.email,
        favorite_location: "West Market",
        marketing_consent: profile.marketingConsent
      }
    });
    engine.postAccrual({
      context: demoContext(`accrual-${index + 1}`),
      member_id: profile.memberId,
      order: demoOrder(profile.memberId, orderId, spend, profile.channel)
    });

    if (profile.refund) {
      engine.adjustOrder({
        context: demoContext(`refund-${index + 1}`),
        member_id: profile.memberId,
        program_id: "demo-foodservice",
        adjustment: {
          adjustment_id: `seed-refund-${index + 1}`,
          original_order_id: orderId,
          type: "partial_refund",
          reason: "Demo partial refund",
          occurred_at: new Date().toISOString(),
          order_total_delta: { amount: -profile.refund * 10, currency: "USD" },
          eligible_spend_delta: { amount: -profile.refund * 10, currency: "USD" }
        }
      });
    }

    if (profile.redeem) {
      const redemptionOrder = demoOrder(
        profile.memberId,
        `seed-redemption-order-${index + 1}`,
        1_500,
        profile.channel
      );
      const reservation = engine.reserve({
        context: demoContext(`reserve-${index + 1}`),
        redemption_id: `seed-redemption-${index + 1}`,
        member_id: profile.memberId,
        reward_id: "five-off",
        order: redemptionOrder
      });
      engine.capture({
        context: demoContext(`capture-${index + 1}`),
        reservation_id: reservation.reservation.reservation_id,
        order_id: redemptionOrder.order_id
      });
    }
  }
}
