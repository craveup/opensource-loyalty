# Idempotency for loyalty mutations

Network success and business success are different. A client can lose the HTTP
response after the server commits, so every financial mutation needs a stable
operation-scoped idempotency key derived from the source business event.

```text
evaluate:order-123
accrual:order-123
reserve:order-123:redemption-7
capture:order-123:reservation-7
adjustment:order-123:refund-2
```

Reusing a key with the same business payload returns the original outcome;
reusing it with different data returns `409 idempotency_conflict`. Generate a
new request id and timestamp on transport retry, but keep the business key.
Never reuse the evaluate key for accrual, never derive a refund key from the
current time, and never automatically retry a mutation with a new key.

Offline queues must persist source event id, operation, payload fingerprint,
and delivery status. Delivery can be at least once because LIP deduplicates the
mutation, but the source adapter must map the same event deterministically.
Webhook consumers apply the same rule: verify the signature, deduplicate the
delivery id, then reconcile the underlying resource rather than trusting order.

Test three cases for every operation: the initial request, an identical replay,
and the same key with one business field changed. The adapter certification
runner additionally checks deterministic mapping and distinct evaluate/accrue
keys.
