import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  certifyAdapter,
  SquareFoodserviceAdapter,
  verifySquareWebhookSignature,
  type AdapterCertificationFixture,
  type SquareOrder,
  type SquareRefund
} from "@loyalty-interchange/adapter-kit";

const order: SquareOrder = {
  id: "square-order-001",
  location_id: "location-001",
  customer_id: "square-customer-001",
  reference_id: "R-1001",
  state: "COMPLETED",
  created_at: "2026-08-20T18:00:00.000Z",
  closed_at: "2026-08-20T18:05:00.000Z",
  source: { name: "Square Online" },
  fulfillments: [{ type: "PICKUP" }],
  line_items: [{
    uid: "line-entree",
    catalog_object_id: "catalog-entree",
    name: "Demo grain bowl",
    quantity: "1",
    base_price_money: { amount: 1200, currency: "USD" },
    total_money: { amount: 1200, currency: "USD" },
    total_discount_money: { amount: 100, currency: "USD" },
    total_tax_money: { amount: 88, currency: "USD" },
    modifiers: [{
      uid: "modifier-avocado",
      catalog_object_id: "catalog-avocado",
      name: "Avocado",
      quantity: "1",
      base_price_money: { amount: 200, currency: "USD" },
      total_price_money: { amount: 200, currency: "USD" }
    }]
  }],
  total_money: { amount: 1588, currency: "USD" },
  total_discount_money: { amount: 100, currency: "USD" },
  total_tax_money: { amount: 88, currency: "USD" },
  total_tip_money: { amount: 200, currency: "USD" },
  total_service_charge_money: { amount: 0, currency: "USD" },
  tenders: [
    { id: "tender-card", type: "CARD", amount_money: { amount: 1000, currency: "USD" } },
    { id: "tender-gift", type: "SQUARE_GIFT_CARD", amount_money: { amount: 588, currency: "USD" } }
  ]
};

const refund: SquareRefund = {
  id: "square-refund-001",
  status: "COMPLETED",
  reason: "Item returned",
  created_at: "2026-08-21T12:00:00.000Z",
  amount_money: { amount: 400, currency: "USD" }
};

const adapter = new SquareFoodserviceAdapter({
  programId: "demo-foodservice",
  brandId: "demo-brand",
  merchantId: "demo-merchant",
  currency: "USD",
  resolveMemberId: (source) => source.metadata?.["loyalty_member_id"] ?? "member-001",
  resolveEligibleRefundAmount: () => 400,
  categoryIds: () => ["entrees"]
});

describe("Square foodservice adapter", () => {
  it("maps a completed pickup order with modifiers, split tenders, and a partial refund", () => {
    expect(adapter.mapOrder(order)).toMatchObject({
      order_id: "square-order-001",
      order_number: "R-1001",
      member_id: "member-001",
      channel: "web",
      status: "paid",
      lines: [
        { line_id: "line-entree", kind: "item", discount: { amount: 100 } },
        { line_id: "modifier-avocado", kind: "modifier", parent_line_id: "line-entree" }
      ],
      totals: { subtotal: { amount: 1400 }, total: { amount: 1588 } },
      tenders: [{ type: "card" }, { type: "gift_card" }],
      metadata: { provider: "square", provider_version: "2026-08-19" }
    });
    expect(adapter.mapAdjustment(refund, adapter.mapOrder(order))).toMatchObject({
      adjustment_id: "square-refund-001",
      original_order_id: "square-order-001",
      type: "partial_refund",
      order_total_delta: { amount: -400, currency: "USD" },
      eligible_spend_delta: { amount: -400, currency: "USD" }
    });
    expect(adapter.idempotencyKeys(order, refund)).toEqual({
      evaluate: "square:evaluate:square-order-001",
      accrue: "square:accrue:square-order-001",
      adjustment: "square:adjustment:square-order-001:square-refund-001"
    });
  });

  it("does not copy source customer identifiers or free-form line notes", () => {
    const mapped = adapter.mapOrder({
      ...order,
      line_items: (order.line_items ?? []).map((line) => ({
        ...line,
        note: "allergy and phone details"
      }))
    });
    expect(JSON.stringify(mapped)).not.toContain("square-customer-001");
    expect(JSON.stringify(mapped)).not.toContain("allergy and phone details");
  });

  it("passes deterministic adapter certification for public synthetic fixtures", () => {
    const fixtures: Array<AdapterCertificationFixture<SquareOrder, SquareRefund>> = [{
      id: "square-completed-refund",
      description: "Synthetic completed pickup order and partial refund",
      capabilities: ["modifiers", "split_tenders", "discounts", "taxes", "tips", "partial_refunds"],
      source: order,
      adjustment: refund,
      expected: {
        order_id: "square-order-001",
        status: "paid",
        required_line_kinds: ["item", "modifier"],
        required_tender_types: ["card", "gift_card"],
        adjustment_type: "partial_refund"
      }
    }];
    expect(certifyAdapter(adapter, fixtures, () => new Date("2026-08-22T00:00:00.000Z")))
      .toMatchObject({ passed: true, adapter: { name: "square-orders", version: "2026-08-19" } });
  });

  it("verifies Square webhook signatures with a constant-time comparison", () => {
    const rawBody = JSON.stringify({ merchant_id: "demo-merchant", event_id: "event-001" });
    const notificationUrl = "https://loyalty.example.test/webhooks/square";
    const signatureKey = "public-test-signature-key";
    const signature = createHmac("sha256", signatureKey)
      .update(`${notificationUrl}${rawBody}`)
      .digest("base64");
    expect(verifySquareWebhookSignature({ rawBody, signature, signatureKey, notificationUrl })).toBe(true);
    expect(verifySquareWebhookSignature({ rawBody: `${rawBody} `, signature, signatureKey, notificationUrl })).toBe(false);
    expect(verifySquareWebhookSignature({ rawBody, signature: "invalid", signatureKey, notificationUrl })).toBe(false);
  });
});
