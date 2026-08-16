# Architecture and product boundaries

LIP separates portable loyalty behavior from managed operations.

```text
ordering app -> merchant BFF -> LIP /lip/v1 -> engine -> SQLite or Postgres
                    |              |
               CIAM token      signed webhooks

operator -> Admin API/UI                  operator -> Cloud /cloud/v1
```

## LIP Protocol

The normative layer defines request context, exact integer money, foodservice
orders, member/account reads, evaluate/accrue/reserve/capture/reverse/adjust,
errors, idempotency, discovery, and webhooks. It does not define authentication
UI, payment collection, CRM delivery, billing, or hosting.

## Reference Platform

The Apache-2.0 implementation contains the deterministic engine, HTTP server,
SDK, CLI, adapter certification kit, Admin, SQLite/Postgres stores, and
conformance suite. It is useful for self-hosting and as executable protocol
documentation; passing its own tests is not proof of another provider's
conformance.

## Crave Loyalty Cloud

The Cloud control plane owns organizations, projects, environments, usage,
billing adapters, encrypted local provisioning credentials, managed customer
records, backup/recovery operations, and support. `/cloud/v1` is deliberately
non-normative. A Cloud customer can export the same program and data-plane state
to a self-hosted LIP runtime.

## Trust boundaries

- The BFF verifies the customer session and retains the merchant LIP key.
- LIP sees an opaque `member_id`, not a password, refresh token, or payment card.
- The payment provider settles money; the BFF posts the resulting loyalty
  lifecycle transition.
- Storage adapters isolate tenant state. Admin and Cloud identities are separate
  from consumer identities.
- Vendor adapters normalize source events but cannot decide ambiguous business
  policy silently; unresolved semantics fail certification or require mapping.
