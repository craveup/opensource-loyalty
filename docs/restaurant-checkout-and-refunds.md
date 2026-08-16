# Restaurant checkout, payment, and refunds

The merchant BFF owns orchestration because it is the only layer that should
see both the authenticated customer and the merchant loyalty key.

1. Resolve the customer to an opaque `member_id`.
2. Map the open cart and call `orders/evaluate` for an estimate.
3. If a reward is selected, reserve it before payment authorization.
4. On payment failure or abandoned checkout, reverse the reservation.
5. On settled payment, map the paid order and post accrual once.
6. Capture the reservation against the paid order.
7. For a void or refund, post an adjustment linked to the original order with
   exact negative deltas; never create a synthetic negative purchase.

Modifiers need a parent line; combo attribution should be explicit in tags or
source metadata. Split tenders must reconcile to total. Decide whether tax,
tip, service fees, gift value, comps, and delivery charges earn before launch.
Record store-local `business_date` separately from timestamps so overnight and
offline transactions settle correctly.

Accrual and capture are separate durable mutations. If one succeeds and the
other fails, retry the failed operation with its original key and inspect the
ledger; do not compensate blindly. Partial refunds should reverse only the
original earning/funding attributable to the returned amount. Replaying the
same refund event must return the same result.

The runnable [`ordering-bff.ts`](../examples/typescript/ordering-bff.ts) shows
this server boundary. The conformance suite proves protocol behavior; a source
adapter report proves deterministic mapping for the supplied fixture corpus.
