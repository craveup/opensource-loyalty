import { describe, expect, it, vi } from "vitest";
import type { LipClient } from "@loyalty-interchange/sdk";
import {
  OrderingLoyaltyBff,
  demoOrderingAdapter
} from "../../examples/typescript/ordering-bff.js";

describe("OrderingLoyaltyBff", () => {
  it("maps preview, payment success/failure, capture, and refund with stable keys", async () => {
    const evaluate = vi.fn(async () => ({ evaluation_id: "evaluation-1" }));
    const reserve = vi.fn(async () => ({
      reservation: { reservation_id: "reservation-1" }
    }));
    const reverse = vi.fn(async () => ({ reservation: { status: "reversed" } }));
    const capture = vi.fn(async () => ({ reservation: { status: "captured" } }));
    const post = vi.fn(async () => ({ balances: [{ amount: 500 }] }));
    const adjust = vi.fn(async () => ({ balances: [{ amount: 450 }] }));
    const client = {
      orders: { evaluate, adjust },
      accruals: { post },
      redemptions: { reserve, reverse, capture }
    } as unknown as LipClient;
    const bff = new OrderingLoyaltyBff(client, demoOrderingAdapter);
    const open = { id: "order-1", memberId: "member-1", status: "open" as const, total: 1_000 };
    const paid = { ...open, status: "paid" as const };

    const preview = await bff.preview(open, "member-1", {
      redemption_id: "redemption-1",
      reward_id: "five-off"
    });
    expect(preview.reservation).toBeDefined();
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ member_id: "member-1" }),
      { idempotencyKey: "evaluate:order-1" }
    );
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ redemption_id: "redemption-1" }),
      { idempotencyKey: "reserve:order-1:redemption-1" }
    );

    await bff.paymentFailed("reservation-1", "order-1", "Payment failed");
    expect(reverse).toHaveBeenCalledWith(
      { reservation_id: "reservation-1", reason: "Payment failed" },
      { idempotencyKey: "reverse:order-1:reservation-1" }
    );

    await bff.paymentSucceeded({
      source: paid,
      member_id: "member-1",
      evaluation_id: "evaluation-1",
      reservation_id: "reservation-2"
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ member_id: "member-1", evaluation_id: "evaluation-1" }),
      { idempotencyKey: "accrual:order-1" }
    );
    expect(capture).toHaveBeenCalledWith(
      { reservation_id: "reservation-2", order_id: "order-1" },
      { idempotencyKey: "capture:order-1:reservation-2" }
    );

    await bff.adjustOrder(paid, { id: "refund-1", amount: 500 }, "member-1");
    expect(adjust).toHaveBeenCalledWith(
      expect.objectContaining({
        member_id: "member-1",
        adjustment: expect.objectContaining({ original_order_id: "order-1" })
      }),
      { idempotencyKey: "adjustment:order-1:refund-1" }
    );
  });
});
