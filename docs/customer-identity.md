# Customer identity integration

Loyalty Interchange does not authenticate customers. Clerk, Auth0, or another
OIDC provider owns sign-up, sign-in, credentials, verification, recovery,
sessions, MFA, passkeys, social login, and account-security controls.

The optional `@loyalty-interchange/identity` package handles only the boundary
between an already-authenticated customer and loyalty:

1. validate the provider access token;
2. resolve `{tenant_id, issuer, subject}` to one stable customer id;
3. resolve that customer id to one program-scoped LIP `member_id`.

It does not expose `signUp`, `signIn`, `refresh`, or password APIs.

## BFF flow

Customer tokens terminate at the application BFF. They must never be sent to
`/lip/v1`, and the LIP merchant API key must never be sent to a browser or
mobile application.

```text
Expo or web app
  -> Clerk/Auth0 sign-in
  -> provider access token
  -> application BFF
       -> OidcTokenVerifier
       -> CustomerLoyaltyResolver
       -> LIP with server-side merchant key
```

The BFF chooses `tenantId` from trusted deployment or routing configuration.
It must not accept tenant scope from an untrusted JWT claim without separately
authorizing that claim.

## Token verification

```ts
import { OidcTokenVerifier } from "@loyalty-interchange/identity";

const verifier = new OidcTokenVerifier({
  issuer: process.env.CUSTOMER_OIDC_ISSUER!,
  audience: process.env.CUSTOMER_OIDC_AUDIENCE!,
  authorizedParties: ["https://app.example.com"]
});

const principal = await verifier.verifyAuthorization(
  request.headers.get("authorization") ?? undefined
);
```

The verifier checks signature, issuer, audience, expiration, allowed signing
algorithm, and subject. `authorizedParties` validates `azp` when a provider
uses it to identify the calling application. Email and phone claims are exposed
only when their corresponding verification claims are true by default.

Clerk and Auth0 both work through this OIDC contract. Provider SDKs remain the
preferred integration inside each application's UI; this package does not wrap
their customer-account APIs.

## Customer and member mapping

```ts
import {
  CustomerLoyaltyResolver,
  MemoryCustomerDirectoryRepository
} from "@loyalty-interchange/identity";
import { LipClient } from "@loyalty-interchange/sdk";

const lip = new LipClient({
  baseUrl: process.env.LIP_URL!,
  apiKey: process.env.LIP_API_KEY!
});

const resolver = new CustomerLoyaltyResolver({
  repository: new MemoryCustomerDirectoryRepository(),
  lip
});

const { customer, memberLink } = await resolver.resolve({
  tenantId: "demo-cafe",
  programId: "demo-rewards",
  principal
});
```

`MemoryCustomerDirectoryRepository` is for local development and contract
tests. Production applications implement `CustomerDirectoryRepository` in
their own transaction-safe database.

The LIP member identity contains only the stable internal customer id:

```json
{
  "type": "external",
  "issuer": "craveup-customer",
  "value": "customer_..."
}
```

Provider subjects, raw JWTs, email addresses, and phone numbers do not cross the
LIP transaction boundary. Linking a new Clerk/Auth0 identity therefore does not
change the customer id, member id, balances, or ledger history.

## Deletion

`deleteCustomer` / `markCustomerDeleted` creates a tombstone and prevents the
external identity from silently creating a new loyalty account. When the
resolver is constructed with `cancelMember` (or `cancelLipMember` against the
reference Admin API), each linked LIP member is closed so accruals and
redemptions fail while the immutable ledger remains.

Application privacy workflows should use the authenticated
`POST /admin/api/v1/members/erase` contract and reconcile through
`POST /admin/api/v1/members/inspect`. Erasure closes the member, removes every
external identity and member attribute, and retains only a pseudonymous
`loyalty_id` reference so balances and immutable ledger history remain
auditable. The operation is idempotent and `inspect` reports `erased: true`
only when that exact minimized state is present.

The application remains responsible for:

- deleting or disabling the account at Clerk/Auth0;
- erasing profile PII and consent data according to policy;
- retaining legally required order and immutable loyalty ledger records;
- recording an auditable deletion workflow.

The identity package never calls provider account-management APIs.
