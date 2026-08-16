# Managed customer identity contract

The managed customer identity layer is a non-normative Cloud service. It is
separate from `/lip/v1`, the reference engine, and merchant/admin identity.
Identity providers keep responsibility for credentials, authentication,
recovery, token issuance, session revocation, and bot protection. CraveUp keeps
the stable customer record and its program-scoped LIP member mappings.

The `@loyalty-interchange/cloud` implementation includes in-memory and Postgres
repositories, OIDC/Clerk/Auth0 verification adapters, customer/profile/consent
lifecycle services, loyalty enrollment orchestration, provider contract tests,
and optional authenticated HTTP routes for a merchant BFF. It does not publish
a customer SDK or sign-up/sign-in UI and never issues an identity-provider token.

## Stable identity model

An authenticated identity is keyed by the immutable tuple:

```text
{ tenant_id, issuer, subject }
```

The tuple maps to one generated `crv_cus_*` customer id. Email and phone are
verified profile attributes; neither is an account key. Linking another
provider identity adds another immutable tuple to the same customer. A tuple
already owned by another customer produces `identity_conflict` and is never
silently merged or reassigned.

Loyalty enrollment maps:

```text
{ tenant_id, customer_id, program_id } -> member_id
```

The reverse `{ tenant_id, program_id, member_id }` is also unique. Enrollment
uses `customer:{customer_id}:program:{program_id}` as its stable idempotency key.
The injected loyalty adapter owns the merchant credential and calls LIP; a
mobile or browser client must never receive that credential.

## Provider contract

`CustomerIdentityProvider` is intentionally provider-neutral:

- `verifySession({ tenant_id, token })` verifies a provider token and returns
  issuer, subject, audience, expiry, session id, authorized party, and verified
  contacts.
- `deleteIdentity(identity)` delegates CIAM deletion when server credentials
  are available. A verification-only adapter returns `unsupported`.

`OidcCustomerIdentityProvider` validates signature, issuer, optional audience,
expiry, subject, algorithms, tenant binding, and optional `azp`. It accepts an
injected JOSE key resolver and verifier for offline tests or a pinned local
public key. With no injected key it reads the provider's HTTPS JWKS.

`ClerkCustomerIdentityProvider` specializes this contract for Clerk's RS256
session tokens and requires either an audience or an authorized-party allowlist.
It needs no secret to verify tokens against a public key or JWKS. Provider
management operations, including deleting the Clerk user, require a separately
injected server-side callback and credential.

`Auth0CustomerIdentityProvider` is the RS256 OIDC specialization and requires an
API audience. Other standards-compliant providers use the generic OIDC adapter.

Clerk's standard session token includes `iss`, `sub`, `exp`, `sid`, and `azp`
but does not include `aud` by default. An integrating app can either:

1. verify the standard session token with its exact frontend origins in
   `authorizedParties`; or
2. use a Clerk custom JWT template containing the customer API audience, then
   configure both `audience` and `authorizedParties`.

When `audience` is configured, a missing or different `aud` is rejected.
Verified email or phone is returned only when both the value and its
`*_verified` claim are present. Do not trust unverified contact claims.

## Customer service API

`CustomerPlatform` exposes the first provider-neutral API surface:

- `introspectSession` verifies a token and atomically resolves or creates the
  stable customer;
- `getProfile` and `updateProfile` read/update customer-owned profile fields;
- `setConsent` stores purpose, decision, policy version, source, and timestamp;
- `linkIdentity` proves the second identity with its own token before linking;
- `enrollLoyalty` idempotently binds a program-scoped LIP member id;
- `exportAccount` returns profile, consent, and loyalty data without provider
  subjects;
- `deleteAccount` performs local privacy deletion and provider cleanup; and
- `close` releases repository resources.

When configured, the same operations are exposed below `/cloud/v1/customer`.
Every request carries the external provider Bearer token plus fixed
`X-LIP-Tenant-Id` and `X-LIP-Customer-Provider` headers; the gateway verifies
the token again and reconstructs `CustomerSession` server-side. Routes cover
session introspection, profile, consent, identity linking, loyalty enrollment,
account export, and deletion. They are Cloud/BFF routes, never `/lip/v1`.

The service does not persist raw tokens, passwords, refresh tokens, or sessions.
Every operation is tenant-scoped. Instantiate provider adapters with a fixed
tenant; never accept a tenant solely from an unverified token or client claim.
`CustomerSession` is a short-lived server-side authorization context returned
by `introspectSession`; never deserialize one from an app request or cache it
beyond its `expires_at`.

## Deletion and retained loyalty history

Deletion first makes the CraveUp account inaccessible, clears profile PII,
withdraws consent, and disables external identities. It deliberately retains:

- a non-reassignable external-identity tombstone;
- stable CraveUp customer and LIP member ids; and
- the loyalty ledger and financially required transaction history held by LIP.

The service then attempts deletion at each CIAM provider. An unavailable
provider is reported as `pending`; local deletion is not rolled back. Production
deployment must add a durable retry worker for pending provider cleanup.
Retention periods and the legal basis for identity tombstones and loyalty
ledger entries must be configured with counsel; this contract defines safe
technical behavior, not a universal retention policy.

## Consumer app handoff

A consumer app should keep provider tokens in platform secure storage and send
the access token only to its BFF/customer gateway. The BFF should:

1. call `introspectSession` with its fixed tenant and provider id;
2. retain `customer_id` as the app-facing identity and never expose the
   provider `subject` to LIP;
3. call `enrollLoyalty` once for its program (for example `demo-rewards`);
4. use the returned `member_id` for wallet, rewards, activity, preview, and
   checkout LIP operations; and
5. call `deleteAccount` before clearing the native token.

An app must retain its existing authentication implementation. The hosted
gateway verifies existing tokens but does not provide sign-up/sign-in UI,
refresh handling, native secure-storage helpers, or durable retry processing
for pending provider deletion.
