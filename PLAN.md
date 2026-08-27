# Open-source restaurant loyalty platform plan

Status: product implementation built; final repository verification in
progress; external validation and publication gates remain evidence-dependent

## Product decision

Build the open-source loyalty platform for teams that own restaurant technology
integrations:

1. POS, ordering, payment, and restaurant software platforms adding loyalty.
2. Multi-unit restaurant technical teams that need data ownership, portability,
   and correct checkout/refund behavior.
3. Restaurant integrators and agencies that repeatedly rebuild loyalty plumbing.

The product is not positioned as a turnkey no-code marketing service for a
restaurant without a technical owner. The project can win by combining an
inspectable marketer and guest product with a portable, foodservice-correct
transaction core—not by claiming that open source alone creates adoption.

## Architecture that must remain explicit

1. **LIP Protocol (`/lip/v1`)** — vendor-neutral transaction contracts,
   generated schemas/OpenAPI, SDK, and conformance.
2. **Reference Product (`/platform/v1`)** — customer profiles and consent,
   behavioral events, imports, segments, campaigns, attribution, connectors,
   analytics, marketer Admin, and guest wallet.
3. **Adapters** — source-specific mappings and reproducible synthetic/sanitized
   certification evidence; never inferred vendor endorsement.
4. **Managed Layer (`/cloud/v1`)** — optional hosting/control plane without
   making the open runtime depend on it.

Customer identity and payment authorization remain external. A BFF keeps
provider tokens and merchant credentials server-side and maps identity to an
opaque loyalty member.

## Implemented repository milestones

### Product foundation

- [x] Add durable customer profiles, explicit consent, idempotent behavioral
      events, bounded imports, customer analytics, and campaign attribution.
- [x] Add a versioned, authenticated `/platform/v1` API without changing the
      normative `/lip/v1` surface.
- [x] Add dynamic audience rules, preview, campaign scheduling/status,
      deterministic holdouts, attribution windows, and run reporting.
- [x] Fail closed for location-scoped credentials on tenant-wide customer data.
- [x] Add a separate generated OpenAPI document for the product API.

### Marketer and guest experience

- [x] Add an Admin Marketing workspace for audience building, preview,
      campaigns, activation/pause, runs, and metrics.
- [x] Add a responsive branded guest wallet reference BFF.
- [x] Implement OIDC Authorization Code + PKCE, state/nonce verification,
      server-held access tokens, `HttpOnly` sessions, CSP nonces, origin/CSRF
      protection, and a visibly synthetic default preview.

### Restaurant onboarding and integration

- [x] Add strict CSV member import: 1 MiB, 1,000 rows, unique allowlisted
      headers, exact row width, explicit consent, and safe JSON attributes.
- [x] Add a Square Orders adapter pinned to the documented API version, covering
      modifiers, split tenders, discounts, tax, tip, statuses, void/refund,
      deterministic keys, and raw-body webhook signature verification.
- [x] Omit source customer ids and free-form notes from the normalized order.
- [x] Require the integrator to resolve loyalty-eligible refund spend from
      source facts instead of guessing from gross refund value.
- [ ] Add Toast only after authorized sandbox access and sanitized fixtures can
      prove the exact source contract. Documentation alone is insufficient.

### Deployment and privacy

- [x] Make `docker compose up --build` start API/Admin plus the synthetic wallet.
- [x] Document the production move to Postgres, OIDC, TLS, secret management,
      backup/restore, conformance, adapter rehearsal, and rollback.
- [x] Add optional persistent self-host telemetry that is disabled by default,
      requires an explicit HTTPS endpoint, sends a fixed pseudonymous payload at
      most daily, times out, never redirects, and never retries.
- [x] Add a PostHog landing integration that is inert with an empty token and,
      when configured, is cookieless with no person profiles, autocapture,
      automatic page views, replay, exceptions, performance, heatmaps, surveys,
      flags, or free-form properties.

### Positioning, sales, and distribution

- [x] Reposition the landing, README, docs, `llms.txt`, and Mintlify navigation
      around the complete open-source restaurant loyalty platform.
- [x] Name the ideal users and the current no-code/turnkey non-fit explicitly.
- [x] Add platform API, wallet, Square, deployment, privacy/telemetry, and
      developer distribution guides.
- [x] Add a public-safe design-partner issue form with a warning against customer
      data, secrets, private URLs, contracts, and confidential vendor material.
- [x] Keep founder-led GitHub, LinkedIn, SEO, and GEO work tied to walkthrough,
      sandbox, refund-safe integration, or design-partner outcomes rather than
      stars and raw traffic.

## Repository verification gates

- [x] Targeted product/API, marketer workflow, wallet, Square/CSV, and telemetry
      tests pass under Node 22.
- [x] Desktop, tablet, and mobile Admin and wallet renders have been inspected
      with synthetic data; interaction testing covered segment preview and a
      campaign run with deterministic holdout.
- [ ] Full `npm test` and `npm run verify` pass on the combined implementation.
- [ ] Docker image build and Compose smoke test pass on the combined implementation.
- [ ] Final landing desktop/mobile render and interaction check pass.
- [ ] Public-safety audit passes for tracked files, Git history, dependencies,
      CI, Docker, auth, webhooks, SSRF, logs, telemetry, docs, and generated files.
- [ ] All logical commits are pushed and remote CI passes on the exact branch.

The unchecked repository gates are the remaining work in this implementation
branch. They must be updated only with direct evidence.

## External validation gates

Repository work cannot check these boxes:

- [ ] Ten qualified problem interviews across the three target user groups.
- [ ] Three independent evaluators complete a sandbox order evaluation.
- [ ] Two independent evaluators complete evaluate through refund adjustment.
- [ ] Two active design-partner integrations with named technical owners.
- [ ] One permissioned, referenceable end-to-end restaurant implementation.
- [ ] Measured activation time, with a target median under 15 minutes.
- [ ] Search Console and AI-search visibility on a verified production domain.
- [ ] Production SLO attainment from a deployed regional runtime.
- [ ] A sanitized Toast certification corpus from authorized source access.

## Distribution operating plan

### Weeks 1-2: make evaluation obvious

- Ship one reviewed release with the landing walkthrough, Admin, wallet,
  Compose quickstart, product OpenAPI, architecture, security, Square, and
  migration evidence.
- Configure the public PostHog project token only after its cookieless project
  setting and retention policy are verified.
- Ensure GitHub description/topics point to restaurant loyalty, POS, ordering,
  TypeScript, self-hosting, and the verified live walkthrough.

### Weeks 3-4: founder-led discovery

- Publish short LinkedIn posts built around one hard restaurant edge at a time:
  idempotent retry, failed-payment reversal, partial-refund clawback, modifier
  mapping, or customer-data portability.
- Each post links to one executable artifact and asks one target role for a
  specific integration edge. No generic launch hype or unverified comparison.
- Recruit ten interviews; record role, current system, pain, authority, timing,
  and next technical proof privately and securely.

### Weeks 5-8: turn friction into public leverage

- Help three independent evaluators complete the quickstart and first API call.
- Convert repeated questions into docs, examples, good-first issues, and
  searchable technical pages.
- Publish sanitized failure and reconciliation learnings, not customer data.

### Weeks 9-12: prove a wedge

- Select up to two design partners with a real ordering/refund edge and weekly
  technical owner.
- Produce a source adapter report, staging lifecycle trace, migration rehearsal,
  security/operations record, and rollback plan.
- Publish partner identity, metrics, screenshots, or quotes only with written
  approval. A stopped pilot is acceptable evidence; fabricated momentum is not.

## Publication gates and known provider work

- Never recreate or move immutable release tag `v0.2.0`.
- Verify the current npm registry state before claiming a package/version is
  public. Publishing requires valid npm authority or trusted publishing.
- Verify anonymous GHCR pulls before advertising the container as public.
  Changing package visibility can be irreversible and organization-policy
  controlled, so it requires action-time owner confirmation.
- Keep the verified Vercel canonical URL until the custom domain is live and
  independently verified; do not publish an aspirational DNS claim.
- Do not claim Square or Toast partnership/certification from repository tests.

## Definition of success

The repository is complete for this milestone when every repository verification
gate above has direct evidence and remote CI is green. The business is working
when independent teams can self-host, integrate one restaurant source through
refund, operate marketer and guest workflows, and choose to stay because the
open platform is more trustworthy and adaptable—not merely because it is free.
