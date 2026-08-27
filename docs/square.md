# Square Orders adapter

`SquareFoodserviceAdapter` maps Square Order-shaped objects into the LIP
foodservice order model. The checked-in adapter version is pinned to the Square
Orders API version `2026-08-19` and is tested only with public synthetic
fixtures. It is not a claim of Square certification or production partnership.

## Covered mapping

- completed, open, and canceled order states;
- line items and modifiers;
- discounts, taxes, tips, service charges, and total;
- split card, cash, gift-card, and other tenders;
- pickup, delivery, web, mobile, and counter channel hints;
- deterministic evaluate, accrue, and adjustment idempotency keys; and
- void and partial-refund adjustment shapes.

Free-form line notes and Square customer identifiers are deliberately not copied
into the LIP order. The integrator supplies `resolveMemberId` and should return
only the opaque LIP member id.

## Refund rule

A gross refund cannot prove how much loyalty-eligible spend was reversed. The
adapter therefore requires `resolveEligibleRefundAmount(refund, original)` and
fails closed unless it returns a safe integer between zero and the gross refund.
Resolve that amount from item-level source facts; do not assume every refunded
cent originally earned loyalty value.

## Webhook verification

Verify the exact raw request body before JSON parsing. Square signs the
configured notification URL concatenated with the raw body using HMAC-SHA-256.
`verifySquareWebhookSignature` decodes the supplied Base64 signature and uses a
constant-time comparison. Preserve the externally registered URL exactly;
reverse-proxy rewrites can invalidate verification.

Primary references:

- [Square Orders API](https://developer.squareup.com/reference/square/orders)
- [Validate Square webhook events](https://developer.squareup.com/docs/webhooks/step3validate)

Before claiming production readiness, capture sanitized fixtures from an
authorized sandbox for the exact catalog, modifiers, discounts, tenders,
offline behavior, voids, and partial refunds in scope. Never commit access
tokens, signature keys, raw customer payloads, or merchant identifiers.
