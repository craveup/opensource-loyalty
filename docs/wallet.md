# Reference guest wallet

`apps/wallet` is a responsive reference wallet and backend-for-frontend (BFF).
It demonstrates how a restaurant can show balances, rewards, activity, and
profile data without exposing a merchant API key or OIDC access token to
browser JavaScript.

## Local preview

The default Compose stack starts a visibly synthetic wallet:

```bash
docker compose up --build
open http://127.0.0.1:3230/
```

`WALLET_DEMO=true` never calls the managed customer API and shows only checked-in
synthetic data. Do not present this mode as a live account experience.

## Production OIDC flow

Production mode uses Authorization Code + PKCE:

1. The BFF creates bounded `state`, `nonce`, and PKCE verifier records.
2. The browser is redirected to the configured OIDC issuer.
3. The callback verifies `state`, exchanges the code server-side, verifies the
   signed ID token against JWKS, and checks issuer, audience, nonce, and time.
4. The access token remains in server memory behind an `HttpOnly`, `Secure`,
   `SameSite=Lax` session cookie.
5. Same-origin and CSRF checks protect writes proxied to the customer API.

Required production variables are `WALLET_PUBLIC_BASE_URL`,
`WALLET_CLOUD_BASE_URL`, `WALLET_TENANT_ID`, `WALLET_OIDC_PROVIDER_ID`,
`WALLET_OIDC_ISSUER`, and `WALLET_OIDC_CLIENT_ID`. A client secret is optional
and, when used, must remain in the BFF. Set `WALLET_DEMO=false`.

## Threat-model boundary

- The browser never receives the merchant API key or OIDC access token.
- The BFF accepts only a configured issuer and callback URL; it has no arbitrary
  upstream proxy or caller-controlled redirect.
- Content Security Policy uses per-response nonces and disables framing.
- The sample session store is process memory. Production deployments that need
  multi-instance sessions must replace it with an encrypted, expiring shared
  store and preserve the same cookie/CSRF contract.
- Customer authentication is not part of `/lip/v1`; the wallet maps the
  authenticated platform customer to an opaque loyalty member.

See [Customer identity](customer-identity.md) for the general BFF mapping
pattern and [Cloud customer identity](cloud-customer-identity.md) for the
managed customer API contract.
