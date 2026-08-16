import { pathToFileURL } from "node:url";
import type { FoodserviceOrderingAdapter } from "@loyalty-interchange/adapter-kit";
import type {
  FoodserviceOrder,
  OrderAdjustment
} from "@loyalty-interchange/protocol";
import { LipClient } from "@loyalty-interchange/sdk";

type LoyaltyPort = Pick<LipClient, "orders" | "accruals" | "redemptions">;

export interface RedemptionChoice {
  redemption_id: string;
  reward_id: string;
}

/**
 * Server-side orchestration boundary for an ordering application. Construct
 * this class inside the merchant BFF only: the LipClient API key must never be
 * serialized into a browser or mobile response.
 */
export class OrderingLoyaltyBff<TOrder, TAdjustment = never> {
  public constructor(
    private readonly loyalty: LoyaltyPort,
    private readonly adapter: FoodserviceOrderingAdapter<TOrder, TAdjustment>
  ) {}

  public async preview(
    source: TOrder,
    memberId: string,
    redemption?: RedemptionChoice
  ) {
    const order = this.adapter.mapOrder(source);
    const keys = this.adapter.idempotencyKeys(source);
    const evaluation = await this.loyalty.orders.evaluate(
      { member_id: memberId, order },
      { idempotencyKey: keys.evaluate }
    );
    const reservation = redemption
      ? await this.loyalty.redemptions.reserve(
          {
            redemption_id: redemption.redemption_id,
            member_id: memberId,
            reward_id: redemption.reward_id,
            order
          },
          { idempotencyKey: `reserve:${order.order_id}:${redemption.redemption_id}` }
        )
      : undefined;
    return { order, evaluation, ...(reservation ? { reservation } : {}) };
  }

  public async paymentSucceeded(input: {
    source: TOrder;
    member_id: string;
    evaluation_id?: string;
    reservation_id?: string;
  }) {
    const order = this.adapter.mapOrder(input.source);
    if (order.status !== "paid") {
      throw new Error("A successful payment must map to a paid LIP order");
    }
    const keys = this.adapter.idempotencyKeys(input.source);
    const accrual = await this.loyalty.accruals.post(
      {
        member_id: input.member_id,
        order,
        ...(input.evaluation_id ? { evaluation_id: input.evaluation_id } : {})
      },
      { idempotencyKey: keys.accrue }
    );
    const capture = input.reservation_id
      ? await this.loyalty.redemptions.capture(
          { reservation_id: input.reservation_id, order_id: order.order_id },
          { idempotencyKey: `capture:${order.order_id}:${input.reservation_id}` }
        )
      : undefined;
    return { order, accrual, ...(capture ? { capture } : {}) };
  }

  public paymentFailed(reservationId: string, orderId: string, reason: string) {
    return this.loyalty.redemptions.reverse(
      { reservation_id: reservationId, reason },
      { idempotencyKey: `reverse:${orderId}:${reservationId}` }
    );
  }

  public async adjustOrder(source: TOrder, adjustmentSource: TAdjustment, memberId: string) {
    if (!this.adapter.mapAdjustment) {
      throw new Error(`${this.adapter.name} does not implement order adjustments`);
    }
    const order = this.adapter.mapOrder(source);
    const adjustment = this.adapter.mapAdjustment(adjustmentSource, order);
    const key = this.adapter.idempotencyKeys(source, adjustmentSource).adjustment;
    if (!key) throw new Error(`${this.adapter.name} did not provide an adjustment key`);
    const result = await this.loyalty.orders.adjust(
      {
        member_id: memberId,
        program_id: order.scope.program_id,
        adjustment
      },
      { idempotencyKey: key }
    );
    return { order, adjustment, result };
  }
}

interface DemoOrder {
  id: string;
  memberId: string;
  status: "open" | "paid";
  total: number;
}

interface DemoAdjustment {
  id: string;
  amount: number;
}

const usd = (amount: number) => ({ amount, currency: "USD" as const });

export const demoOrderingAdapter: FoodserviceOrderingAdapter<DemoOrder, DemoAdjustment> = {
  name: "example-ordering-bff",
  version: "0.2.0",
  capabilities: ["duplicate_delivery", "partial_refunds"],
  mapOrder(source): FoodserviceOrder {
    const occurredAt = "2026-08-15T18:00:00.000Z";
    return {
      order_id: source.id,
      scope: {
        program_id: "demo-foodservice",
        brand_id: "demo-brand",
        merchant_id: "demo-merchant",
        location_id: "demo-location"
      },
      member_id: source.memberId,
      channel: "web",
      status: source.status,
      business_date: "2026-08-15",
      placed_at: occurredAt,
      ...(source.status === "paid" ? { closed_at: occurredAt } : {}),
      lines: [{
        line_id: "meal",
        kind: "item",
        product_id: "meal",
        quantity: 1,
        unit_price: usd(source.total),
        subtotal: usd(source.total),
        discount: usd(0),
        tax: usd(0)
      }],
      totals: {
        subtotal: usd(source.total),
        discount: usd(0),
        tax: usd(0),
        tip: usd(0),
        service_charge: usd(0),
        total: usd(source.total)
      },
      ...(source.status === "paid"
        ? { tenders: [{ tender_id: "payment", type: "card", amount: usd(source.total) }] }
        : {})
    };
  },
  mapAdjustment(source, original): OrderAdjustment {
    return {
      adjustment_id: source.id,
      original_order_id: original.order_id,
      type: "partial_refund",
      reason: "Example partial refund",
      occurred_at: "2026-08-15T19:00:00.000Z",
      order_total_delta: usd(-source.amount),
      eligible_spend_delta: usd(-source.amount)
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

export async function runOrderingBffDemo(): Promise<void> {
  const runId = String(Date.now());
  const memberId = `bff-member-${runId}`;
  const client = new LipClient({
    baseUrl: process.env.LIP_BASE_URL ?? "http://127.0.0.1:3210",
    apiKey: process.env.LIP_API_KEY ?? "lip-dev-key",
    source: { system: "ordering-bff-example", instance: "server" }
  });
  const bff = new OrderingLoyaltyBff(client, demoOrderingAdapter);
  await client.members.enroll({
    program_id: "demo-foodservice",
    member_id: memberId,
    identity: { type: "token", value: `bff-guest-${runId}` }
  });
  const source = { id: `bff-order-${runId}`, memberId, status: "paid" as const, total: 5_000 };
  const preview = await bff.preview(source, memberId);
  await bff.paymentSucceeded({
    source,
    member_id: memberId,
    evaluation_id: preview.evaluation.evaluation_id
  });
  await bff.adjustOrder(source, { id: `bff-refund-${runId}`, amount: 500 }, memberId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runOrderingBffDemo();
  console.log("Ordering BFF lifecycle completed without exposing the merchant key.");
}
