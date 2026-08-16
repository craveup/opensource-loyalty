import type {
  FoodserviceOrderingAdapter,
  AdapterCertificationFixture
} from "@loyalty-interchange/adapter-kit";
import type {
  FoodserviceOrder,
  OrderAdjustment,
  OrderChannel,
  OrderLine
} from "@loyalty-interchange/protocol";

interface SourceLine {
  id: string;
  type: "item" | "modifier" | "fee";
  productId: string;
  parentId?: string;
  quantity: number;
  unit: number;
  discount: number;
  tax: number;
  categories?: string[];
  tags?: string[];
  eligible?: boolean;
}

export interface SourceOrder {
  id: string;
  locationId: string;
  memberId: string;
  channel: OrderChannel;
  state: FoodserviceOrder["status"];
  placedAt: string;
  businessDate: string;
  lines: SourceLine[];
  tip: number;
  serviceCharge: number;
  tenders: Array<{ id: string; type: "cash" | "card" | "gift_card"; amount: number }>;
  offline?: boolean;
}

export interface SourceAdjustment {
  id: string;
  type: OrderAdjustment["type"];
  reason: string;
  occurredAt: string;
  totalDelta: number;
  eligibleDelta: number;
  lines?: Array<{ id: string; quantityDelta: number; subtotalDelta: number }>;
}

const money = (amount: number) => ({ amount, currency: "USD" as const });

export const referenceOrderingAdapter: FoodserviceOrderingAdapter<
  SourceOrder,
  SourceAdjustment
> = {
  name: "reference-ordering-bff",
  version: "0.2.0",
  capabilities: [
    "modifiers",
    "combos",
    "split_tenders",
    "comps",
    "discounts",
    "taxes",
    "tips",
    "offline_accrual",
    "duplicate_delivery",
    "voids",
    "partial_refunds"
  ],
  mapOrder(source) {
    const lines: OrderLine[] = source.lines.map((line) => ({
      line_id: line.id,
      kind: line.type,
      product_id: line.productId,
      ...(line.parentId ? { parent_line_id: line.parentId } : {}),
      quantity: line.quantity,
      unit_price: money(line.unit),
      subtotal: money(line.unit * line.quantity),
      discount: money(line.discount),
      tax: money(line.tax),
      ...(line.categories ? { category_ids: line.categories } : {}),
      ...(line.tags ? { tags: line.tags } : {}),
      ...(line.eligible === undefined ? {} : { loyalty_eligible: line.eligible })
    }));
    const subtotal = lines.reduce((sum, line) => sum + line.subtotal.amount, 0);
    const discount = lines.reduce((sum, line) => sum + line.discount.amount, 0);
    const tax = lines.reduce((sum, line) => sum + line.tax.amount, 0);
    const total = subtotal - discount + tax + source.tip + source.serviceCharge;
    return {
      order_id: source.id,
      scope: {
        program_id: "demo-foodservice",
        brand_id: "demo-brand",
        merchant_id: "demo-merchant",
        location_id: source.locationId,
        franchisee_id: "demo-franchisee"
      },
      member_id: source.memberId,
      channel: source.channel,
      status: source.state,
      business_date: source.businessDate,
      placed_at: source.placedAt,
      ...(source.state === "paid" ? { closed_at: source.placedAt } : {}),
      lines,
      totals: {
        subtotal: money(subtotal),
        discount: money(discount),
        tax: money(tax),
        tip: money(source.tip),
        service_charge: money(source.serviceCharge),
        total: money(total)
      },
      tenders: source.tenders.map((tender) => ({
        tender_id: tender.id,
        type: tender.type,
        amount: money(tender.amount)
      })),
      metadata: { delivery_mode: source.offline ? "offline_replay" : "online" }
    };
  },
  mapAdjustment(source, original) {
    return {
      adjustment_id: source.id,
      original_order_id: original.order_id,
      type: source.type,
      reason: source.reason,
      occurred_at: source.occurredAt,
      order_total_delta: money(source.totalDelta),
      eligible_spend_delta: money(source.eligibleDelta),
      ...(source.lines
        ? {
            lines: source.lines.map((line) => ({
              line_id: line.id,
              quantity_delta: line.quantityDelta,
              subtotal_delta: money(line.subtotalDelta)
            }))
          }
        : {})
    };
  },
  idempotencyKeys(source, adjustment) {
    return {
      evaluate: `evaluate:${source.id}`,
      accrue: `accrual:${source.id}`,
      ...(adjustment ? { adjustment: `adjustment:${source.id}:${adjustment.id}` } : {})
    };
  }
};

const paidOrder: SourceOrder = {
  id: "order-edge-001",
  locationId: "location-7",
  memberId: "member-7",
  channel: "mobile",
  state: "paid",
  placedAt: "2026-08-15T18:00:00.000Z",
  businessDate: "2026-08-15",
  lines: [
    {
      id: "entree",
      type: "item",
      productId: "burger",
      quantity: 1,
      unit: 1_200,
      discount: 100,
      tax: 88,
      categories: ["entrees"],
      tags: ["combo"]
    },
    {
      id: "modifier",
      type: "modifier",
      productId: "extra-cheese",
      parentId: "entree",
      quantity: 1,
      unit: 200,
      discount: 0,
      tax: 14,
      tags: ["combo-component"]
    },
    {
      id: "comped-side",
      type: "item",
      productId: "fries",
      quantity: 1,
      unit: 300,
      discount: 300,
      tax: 0,
      categories: ["sides"],
      tags: ["manager-comp"],
      eligible: false
    }
  ],
  tip: 200,
  serviceCharge: 0,
  tenders: [
    { id: "card-1", type: "card", amount: 1_000 },
    { id: "gift-1", type: "gift_card", amount: 602 }
  ]
};

export const adapterFoodserviceFixtures: Array<
  AdapterCertificationFixture<SourceOrder, SourceAdjustment>
> = [
  {
    id: "restaurant-order-shape",
    description: "Modifiers, combo attribution, a comp, discounts, tax, tip, and split tenders",
    capabilities: [
      "modifiers",
      "combos",
      "split_tenders",
      "comps",
      "discounts",
      "taxes",
      "tips"
    ],
    source: paidOrder,
    expected: {
      order_id: paidOrder.id,
      status: "paid",
      required_line_kinds: ["item", "modifier"],
      required_tender_types: ["card", "gift_card"]
    }
  },
  {
    id: "offline-duplicate",
    description: "An offline order replay maps deterministically to the same order and keys",
    capabilities: ["offline_accrual", "duplicate_delivery"],
    source: { ...paidOrder, id: "order-offline-001", offline: true },
    expected: {
      order_id: "order-offline-001",
      status: "paid",
      required_line_kinds: ["item", "modifier"]
    }
  },
  {
    id: "partial-refund",
    description: "A partial item refund produces a source-linked negative adjustment",
    capabilities: ["partial_refunds"],
    source: paidOrder,
    adjustment: {
      id: "refund-001",
      type: "partial_refund",
      reason: "Guest returned the entree",
      occurredAt: "2026-08-15T19:00:00.000Z",
      totalDelta: -1_188,
      eligibleDelta: -1_100,
      lines: [{ id: "entree", quantityDelta: -1, subtotalDelta: -1_200 }]
    },
    expected: {
      order_id: paidOrder.id,
      status: "paid",
      adjustment_type: "partial_refund"
    }
  },
  {
    id: "void",
    description: "A void remains an explicit adjustment rather than a negative sale",
    capabilities: ["voids"],
    source: { ...paidOrder, id: "order-void-001" },
    adjustment: {
      id: "void-001",
      type: "void",
      reason: "Payment authorization failed",
      occurredAt: "2026-08-15T18:01:00.000Z",
      totalDelta: -1_602,
      eligibleDelta: -1_100
    },
    expected: {
      order_id: "order-void-001",
      status: "paid",
      adjustment_type: "void"
    }
  }
];
