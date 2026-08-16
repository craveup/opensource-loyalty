# LIP 0.2 launch and adoption plan

Status: publication blocked on npm authentication
Owner: CraveUp
Target: `0.2.0`

## Decision

LIP will win first as the open, foodservice-native loyalty infrastructure for
ordering platforms and multi-location restaurant technology teams. The moat is
correct checkout, refund, replay, offline, franchise, and migration behavior —
not generic campaign breadth.

The product is separated into three explicit layers:

1. **LIP Protocol** — vendor-neutral contracts and conformance.
2. **LIP Reference Platform** — Apache-2.0 self-hosted implementation.
3. **Crave Loyalty Cloud** — managed hosting, migration, adapters, operations,
   and support.

## Evidence behind this plan

- The supported Node 22 baseline passes 311 tests without PostgreSQL and all 319
  tests with PostgreSQL 17, with 87.23% statement coverage, runnable lifecycle
  examples, the Admin build, and inspection of all 11 publishable packages.
- The reference platform already implements the complete foodservice lifecycle,
  multiple program models, engagement, tenant/location scope, SQLite/Postgres,
  signed webhooks, an Admin console, a TypeScript SDK, CLI, MCP, and conformance.
- The latest published npm release (`0.1.2`) predates dozens of substantive
  commits and still understates the current product.
- The live product has had little qualified discovery: the August 15 audit found
  one GitHub star, no forks, no Discussions, no open product issues, and ten
  unique repository viewers over the preceding 14 days.
- The live landing and docs had stale repository links, no hosted walkthrough,
  no commercial path, no customer proof, and a mobile overflow defect.
- Commercial APIs are mature, and OfferKit is a direct open-source competitor.
  Open source, TypeScript, CLI, and MCP are therefore table stakes; foodservice
  correctness and credible operations are the differentiation.

## Release acceptance criteria

Every checked item below must be backed by code, tests, a rendered page, a live
repository setting, or an explicit artifact. No customer, revenue, uptime,
search-ranking, or production-usage claim may be checked from repository work
alone.

### 1. Release truth and developer contract

- [x] Promote the latest linear `dev` and release-manifest work into the launch
      branch without rewriting either history.
- [x] Version all public packages and release surfaces as `0.2.0`.
- [x] Use the canonical `craveup/opensource-loyalty` repository URL everywhere
      and add an automated absence check for the retired personal namespace.
- [x] Standardize the supported local and CI runtime on Node 22, provide a
      version pin, and test the release runtime separately.
- [x] Publish a truthful changelog, support policy, version matrix, and release
      checklist that distinguish protocol, reference, and Cloud maturity.
- [x] Keep immutable release-manifest generation and validation in the release
      gate.

### 2. Zero-install evaluation and activation

- [x] Add a hosted, browser-only lifecycle walkthrough that visibly runs
      evaluate, reserve, accrue, capture, reverse, and refund-safe adjustment
      against sample foodservice data without collecting credentials.
- [x] Show request, response, idempotency key, and ledger effects for every
      walkthrough step.
- [x] Add one primary quickstart, one self-host path, and one design-partner path
      across the landing page and docs.
- [x] Define privacy-safe activation events and a funnel contract without
      coupling the project to a specific analytics vendor.
- [x] Add automated landing checks for canonical links, critical copy, crawl
      files, and mobile overflow-prone markup.

### 3. Foodservice integration moat

- [x] Publish `@loyalty-interchange/adapter-kit` with a stable adapter contract,
      normalized lifecycle result, fixture runner, and certification report.
- [x] Cover modifiers, combos, split tenders, comps, discounts, taxes, tips,
      offline accrual, duplicate delivery, void, and partial-refund fixtures.
- [x] Add a runnable ordering-BFF reference that keeps the merchant key on the
      server and maps checkout/payment outcomes to the LIP lifecycle.
- [x] Add vendor-neutral mapping guides for Square, Toast, Olo, PAR Brink, NCR
      Aloha, and Oracle Simphony; label unverified partner-specific details.
- [x] Add Punchh/Paytronix-style migration guidance plus a machine-readable
      member/balance import planner and reconciliation report.

### 4. Managed-provider readiness

- [x] Encrypt local Cloud credential files at rest with authenticated encryption,
      require an operator-supplied key, and retain an explicit legacy migration
      path.
- [x] Add backup, restore, suspend, and resume operations for local provisioned
      environments with failure-safe atomic writes.
- [x] Implement the Stripe billing provider boundary and signed webhook
      verification without adding billing concepts to `/lip/v1`.
- [x] Expose the existing managed-customer contract through authenticated Cloud
      HTTP routes suitable for a BFF; never turn LIP into a sign-in provider.
- [x] Document the threat model, data boundaries, recovery objectives, incident
      process, service-level objectives, and production-readiness checklist.

### 5. Open-source community and commercial path

- [x] Add Code of Conduct, support, governance, maintainer, PR, bug, integration,
      adapter, and protocol-proposal templates.
- [x] Enable GitHub Discussions and provide Q&A, ideas, integrations, and show-and-
      tell entry points without mixing support questions into defects.
- [x] Add design-partner, pricing/packaging, architecture, migration, security,
      and case-study assets for founder-led sales.
- [x] Publish a comparison page that states observable tradeoffs and avoids
      unverified pricing, performance, or customer claims.
- [x] Add a public roadmap issue set and labels for adapters, integrations,
      protocol proposals, good first issues, and help wanted.

### 6. SEO, GEO, and launch distribution

- [x] Fix titles, metadata, structured data, canonical URLs, mobile layout, and
      crawl artifacts on the landing surface.
- [x] Publish original technical pages for open-source loyalty APIs, restaurant
      checkout/refunds, idempotency, adapters, migration, and provider selection.
- [x] Keep `llms.txt` and `llms-full.txt` useful for agents while treating them as
      developer infrastructure, not ranking shortcuts.
- [x] Add a founder-led launch kit for GitHub releases and evidence-based LinkedIn
      posts, each with one measurable call to action.
- [x] Define acquisition, activation, integration, reliability, and commercial
      metrics with bot/CI traffic excluded from adoption claims.

### 7. Verification and publication

- [x] Pass generation, type checking, the full test suite, coverage, runnable
      examples, builds, package-content inspection, spec drift, docs mirror,
      canonical-link, and launch-surface checks.
- [x] Exercise the CLI, migration planner, adapter certification, Cloud credential
      migration, billing webhook, customer routes, and local recovery flow.
- [x] Render and inspect landing and Admin at desktop and 390px mobile widths.
- [x] Publish through a protected-main pull request and require the remote verify
      check before merge.
- [ ] Tag and publish `0.2.0` only from the verified merge commit, then confirm npm,
      docs, and landing resolve to that release.

## External validation gates

These are business outcomes, not repository checkboxes. They remain open until
first-party evidence exists:

- Ten qualified buyer or developer interviews.
- Three independent sandbox users complete `orders/evaluate`.
- Two independent users complete evaluate through refund adjustment.
- Two active design-partner integrations.
- One referenceable end-to-end restaurant ordering implementation.
- Measured median time from starting the walkthrough to the first successful
  evaluation, with a target under 15 minutes.
- Search Console and ChatGPT-search visibility measured on a verified domain.
- Production SLO attainment measured from a deployed regional runtime.

## Product constraints

- LIP remains a loyalty transaction protocol, not customer authentication.
- Financial mutations require explicit idempotency and are never silently retried.
- Cloud, billing, campaigns, and vendor adapters remain outside normative
  `/lip/v1` routes.
- Generated clients are not called first-party SDKs without an idiomatic wrapper.
- Conformance, performance, customer, and compatibility claims require a
  reproducible report.
- External distribution must lead to a real walkthrough, sandbox, integration,
  or design-partner action; stars and raw clone/download counts are not adoption.

## Publication record

- Protected PRs #50, #51, and #52 passed the required remote `verify` check and
  merged without rewriting the promoted `dev` or release-manifest histories.
- `v0.2.0` points to verified merge commit
  `e6050ce17ea73f783fdd45b2db14cec258332ab8`. The GitHub release, five evidence
  assets, provenance attestation, and GHCR image are public.
- The production landing resolves at `https://opensource-loyalty.vercel.app/`
  with the `0.2.0` walkthrough, canonical metadata, robots, and sitemap. All 15
  new long-form documents resolve from the immutable GitHub tag.
- npm publication remains open. The repository environment currently has no
  valid publishing credential: the prior token returned a package-authorization
  404, and the Infisical value is not a valid modern or legacy npm token shape.
  Rotate the npm credential or configure trusted publishing, then rerun the
  release workflow from the existing tag. Never recreate or move the tag.
