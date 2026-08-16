# Foodservice ordering adapters

`@loyalty-interchange/adapter-kit` defines a source-to-LIP mapping contract and
produces a versioned certification report. Certification checks structural and
reconciliation validity, deterministic replay, operation-scoped idempotency,
declared capabilities, adjustments, line kinds, and tender types.

The included fixture corpus exercises modifiers, combos, split tenders, comps,
discounts, taxes, tips, offline replay, duplicate delivery, voids, and partial
refunds. A green report proves only that the supplied adapter and fixtures meet
these checks; it is not vendor endorsement or partner certification.

## Vendor-neutral mapping worksheet

For Square, Toast, Olo, PAR Brink, NCR Aloha, or Oracle Simphony, map the same
concepts before writing code:

| Source concept | LIP target | Decision required |
| --- | --- | --- |
| Check/order id | `order_id` | Stable across retries, payment, and refunds |
| Store/brand/franchise | `scope` | Canonical ids and funding ownership |
| Menu item/modifier/combo | `lines[]` and parent/tags | Price allocation and loyalty eligibility |
| Discounts/comps | line/order discounts plus metadata | Promotion vs manager comp; earn basis |
| Tax/tip/service fee | exact totals | Included/excluded from eligible spend |
| Multiple payments | `tenders[]` | Gift value, card, cash, house account |
| Business and event time | `business_date`, `placed_at`, `closed_at` | Store timezone and offline replay |
| Void/refund | `OrderAdjustment` | Original source link and signed deltas |

## Vendor guide status

- **Square:** map Orders and Payments events only after pinning current API
  versions and verifying whether fulfillment updates can arrive independently.
- **Toast:** verify restaurant GUID, order/check/payment identifiers, dining
  option, and webhook retry semantics in an authorized sandbox.
- **Olo:** establish which ordering and Rails/Engage products are in scope;
  never infer a uniform event model across products.
- **PAR Brink:** validate business-date, combo/component, discount, and void
  payloads with partner documentation.
- **NCR Aloha:** deployments and middleware vary; identify the actual interface
  and stable transaction key before claiming compatibility.
- **Oracle Simphony:** validate revenue-center, check, service-charge, tender,
  and business-date semantics for the deployed integration interface.

These notes are intentionally unverified starting points, not claims that the
project is an approved integration partner. Store sanitized source fixtures in
the adapter package, run `certifyFoodserviceAdapter`, and attach the JSON report
to review. `certifyAdapter` is available for clearly labeled partial fixture
runs, but cannot produce a full-foodservice coverage claim.

See [`examples/typescript/ordering-bff.ts`](../examples/typescript/ordering-bff.ts)
for server-side orchestration that keeps the merchant key out of clients.
