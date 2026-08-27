import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  FoodserviceOrder,
  OrderAdjustment,
  OrderChannel,
  OrderLine
} from "@loyalty-interchange/protocol";
import type {
  AdapterIdempotencyKeys,
  FoodserviceOrderingAdapter
} from "./index.js";

export interface SquareMoney {
  amount?: number;
  currency?: string;
}

export interface SquareOrderModifier {
  uid?: string;
  catalog_object_id?: string;
  name?: string;
  quantity?: string;
  base_price_money?: SquareMoney;
  total_price_money?: SquareMoney;
}

export interface SquareOrderLineItem {
  uid?: string;
  catalog_object_id?: string;
  name?: string;
  variation_name?: string;
  quantity?: string;
  base_price_money?: SquareMoney;
  total_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_tax_money?: SquareMoney;
  note?: string;
  item_type?: string;
  modifiers?: SquareOrderModifier[];
}

export interface SquareTender {
  id?: string;
  type?: string;
  amount_money?: SquareMoney;
}

export interface SquareFulfillment {
  type?: "PICKUP" | "SHIPMENT" | "DELIVERY" | string;
}

export interface SquareOrder {
  id?: string;
  location_id?: string;
  state?: "OPEN" | "COMPLETED" | "CANCELED" | "DRAFT" | string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  customer_id?: string;
  reference_id?: string;
  source?: { name?: string };
  line_items?: SquareOrderLineItem[];
  tenders?: SquareTender[];
  fulfillments?: SquareFulfillment[];
  total_money?: SquareMoney;
  total_tax_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_tip_money?: SquareMoney;
  total_service_charge_money?: SquareMoney;
  metadata?: Record<string, string>;
}

export interface SquareRefund {
  id?: string;
  status?: string;
  reason?: string;
  created_at?: string;
  updated_at?: string;
  amount_money?: SquareMoney;
}

export interface SquareAdapterOptions {
  programId: string;
  brandId: string;
  merchantId: string;
  franchiseeId?: string;
  currency?: string;
  resolveMemberId(order: SquareOrder): string | undefined;
  resolveChannel?: (order: SquareOrder) => OrderChannel;
  categoryIds?: (line: SquareOrderLineItem) => string[];
  loyaltyEligible?: (line: SquareOrderLineItem) => boolean;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Square ${name} is required`);
  return normalized;
}

function amount(value: SquareMoney | undefined): number {
  const candidate = value?.amount ?? 0;
  if (!Number.isSafeInteger(candidate)) throw new Error("Square money amount must be a safe integer");
  return candidate;
}

function currency(value: SquareMoney | undefined, fallback: string): string {
  const code = value?.currency ?? fallback;
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("Square currency must be a three-letter code");
  return code;
}

function quantity(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Square line quantity must be positive");
  return parsed;
}

function orderStatus(state: SquareOrder["state"]): FoodserviceOrder["status"] {
  if (state === "COMPLETED") return "paid";
  if (state === "CANCELED") return "voided";
  return "open";
}

function tenderType(value: string | undefined): NonNullable<FoodserviceOrder["tenders"]>[number]["type"] {
  if (value === "CARD") return "card";
  if (value === "CASH") return "cash";
  if (value === "SQUARE_GIFT_CARD") return "gift_card";
  return "other";
}

function defaultChannel(order: SquareOrder): OrderChannel {
  const fulfillment = order.fulfillments?.[0]?.type;
  if (fulfillment === "DELIVERY") return "delivery";
  if (fulfillment === "PICKUP") return "web";
  const source = order.source?.name?.toLowerCase() ?? "";
  if (source.includes("online") || source.includes("web")) return "web";
  if (source.includes("mobile")) return "mobile";
  return "counter";
}

function mappedLines(order: SquareOrder, options: SquareAdapterOptions): OrderLine[] {
  return (order.line_items ?? []).flatMap((line, index): OrderLine[] => {
    const lineId = line.uid ?? `line-${index + 1}`;
    const lineCurrency = currency(line.total_money ?? line.base_price_money, options.currency ?? "USD");
    const count = quantity(line.quantity);
    const total = amount(line.total_money ?? line.base_price_money);
    const unit = amount(line.base_price_money) || Math.round(total / count);
    const primary: OrderLine = {
      line_id: lineId,
      kind: line.item_type === "CUSTOM_AMOUNT" ? "fee" : "item",
      product_id: line.catalog_object_id ?? lineId,
      name: line.name ?? line.variation_name ?? "Square line item",
      quantity: count,
      unit_price: { amount: unit, currency: lineCurrency },
      subtotal: { amount: total, currency: lineCurrency },
      discount: { amount: amount(line.total_discount_money), currency: lineCurrency },
      tax: { amount: amount(line.total_tax_money), currency: lineCurrency },
      ...(options.categoryIds?.(line).length
        ? { category_ids: options.categoryIds(line) }
        : {}),
      ...(options.loyaltyEligible
        ? { loyalty_eligible: options.loyaltyEligible(line) }
        : {}),
      ...(line.note ? { metadata: { note: line.note } } : {})
    };
    const modifiers = (line.modifiers ?? []).map((modifier, modifierIndex): OrderLine => {
      const modifierId = modifier.uid ?? `${lineId}:modifier:${modifierIndex + 1}`;
      const modifierCount = quantity(modifier.quantity);
      const modifierTotal = amount(modifier.total_price_money ?? modifier.base_price_money);
      const modifierUnit = amount(modifier.base_price_money) || Math.round(modifierTotal / modifierCount);
      return {
        line_id: modifierId,
        kind: "modifier",
        parent_line_id: lineId,
        product_id: modifier.catalog_object_id ?? modifierId,
        name: modifier.name ?? "Square modifier",
        quantity: modifierCount,
        unit_price: { amount: modifierUnit, currency: lineCurrency },
        subtotal: { amount: modifierTotal, currency: lineCurrency },
        discount: { amount: 0, currency: lineCurrency },
        tax: { amount: 0, currency: lineCurrency }
      };
    });
    return [primary, ...modifiers];
  });
}

export class SquareFoodserviceAdapter implements FoodserviceOrderingAdapter<SquareOrder, SquareRefund> {
  public readonly name = "square-orders";
  public readonly version = "2026-08-19";
  public readonly capabilities = [
    "modifiers", "split_tenders", "discounts", "taxes", "tips",
    "duplicate_delivery", "voids", "partial_refunds"
  ] as const;

  public constructor(private readonly options: SquareAdapterOptions) {}

  public mapOrder(source: SquareOrder): FoodserviceOrder {
    const orderId = required(source.id, "order id");
    const locationId = required(source.location_id, "location id");
    const memberId = this.options.resolveMemberId(source);
    if (!memberId) throw new Error("Square order is not linked to a loyalty member");
    const occurredAt = required(source.closed_at ?? source.updated_at ?? source.created_at, "timestamp");
    const parsedTime = Date.parse(occurredAt);
    if (!Number.isFinite(parsedTime)) throw new Error("Square order timestamp is invalid");
    const code = currency(source.total_money, this.options.currency ?? "USD");
    const discount = amount(source.total_discount_money);
    const tax = amount(source.total_tax_money);
    const tip = amount(source.total_tip_money);
    const serviceCharge = amount(source.total_service_charge_money);
    const total = amount(source.total_money);
    const subtotal = total + discount - tax - tip - serviceCharge;
    return {
      order_id: orderId,
      ...(source.reference_id ? { order_number: source.reference_id } : {}),
      scope: {
        program_id: this.options.programId,
        brand_id: this.options.brandId,
        merchant_id: this.options.merchantId,
        location_id: locationId,
        ...(this.options.franchiseeId ? { franchisee_id: this.options.franchiseeId } : {})
      },
      member_id: memberId,
      channel: this.options.resolveChannel?.(source) ?? defaultChannel(source),
      status: orderStatus(source.state),
      business_date: new Date(parsedTime).toISOString().slice(0, 10),
      placed_at: new Date(Date.parse(source.created_at ?? occurredAt)).toISOString(),
      ...(source.state === "COMPLETED" ? { closed_at: new Date(parsedTime).toISOString() } : {}),
      lines: mappedLines(source, this.options),
      totals: {
        subtotal: { amount: subtotal, currency: code },
        discount: { amount: discount, currency: code },
        tax: { amount: tax, currency: code },
        tip: { amount: tip, currency: code },
        service_charge: { amount: serviceCharge, currency: code },
        total: { amount: total, currency: code }
      },
      tenders: (source.tenders ?? []).map((tender, index) => ({
        tender_id: tender.id ?? `${orderId}:tender:${index + 1}`,
        type: tenderType(tender.type),
        amount: {
          amount: amount(tender.amount_money),
          currency: currency(tender.amount_money, code)
        }
      })),
      metadata: {
        provider: "square",
        provider_version: this.version,
        ...(source.customer_id ? { square_customer_id: source.customer_id } : {})
      }
    };
  }

  public mapAdjustment(source: SquareRefund, original: FoodserviceOrder): OrderAdjustment {
    const refundId = required(source.id, "refund id");
    const refundAmount = amount(source.amount_money);
    if (refundAmount <= 0) throw new Error("Square refund amount must be positive");
    const originalTotal = original.totals.total.amount;
    const occurredAt = required(source.updated_at ?? source.created_at, "refund timestamp");
    return {
      adjustment_id: refundId,
      original_order_id: original.order_id,
      type: refundAmount >= originalTotal ? "void" : "partial_refund",
      reason: source.reason?.trim() || "Square refund",
      occurred_at: new Date(Date.parse(occurredAt)).toISOString(),
      order_total_delta: { amount: -refundAmount, currency: original.totals.total.currency },
      eligible_spend_delta: { amount: -Math.min(refundAmount, originalTotal), currency: original.totals.total.currency }
    };
  }

  public idempotencyKeys(source: SquareOrder, adjustment?: SquareRefund): AdapterIdempotencyKeys {
    const orderId = required(source.id, "order id");
    return {
      evaluate: `square:evaluate:${orderId}`,
      accrue: `square:accrue:${orderId}`,
      ...(adjustment ? { adjustment: `square:adjustment:${orderId}:${required(adjustment.id, "refund id")}` } : {})
    };
  }
}

/**
 * Validates Square's HMAC-SHA-256 webhook signature over
 * `<notification-url><raw-body>` with a constant-time comparison.
 */
export function verifySquareWebhookSignature(input: {
  rawBody: string;
  signature: string | undefined;
  signatureKey: string;
  notificationUrl: string;
}): boolean {
  if (!input.signature || !input.signatureKey || !input.notificationUrl) return false;
  let supplied: Buffer;
  try {
    supplied = Buffer.from(input.signature, "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", input.signatureKey)
    .update(`${input.notificationUrl}${input.rawBody}`)
    .digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
