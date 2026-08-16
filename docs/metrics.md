# Adoption and reliability metrics

LIP distinguishes attention from successful integration.

| Stage | Metric | Qualified definition |
| --- | --- | --- |
| Acquisition | Qualified repository/docs visits | Human session from target role/company; exclude bots, CI, maintainers |
| Activation | Walkthrough completed | Same anonymous session runs evaluate and sees a ledger effect |
| Integration | First sandbox evaluation | Independent API key posts a valid source-mapped order |
| Integration depth | Refund-safe lifecycle | Same integration reaches adjustment linked to original order |
| Reliability | Mutation success and p95 latency | Per operation, excluding caller validation errors |
| Reliability | Duplicate conflict and webhook age | Replays, real payload conflicts, oldest undelivered signed event |
| Commercial | Qualified design-partner conversation | Problem, authority, timeline, and integration owner recorded |
| Commercial | Active pilot | Staging traffic and named weekly owner in the last 14 days |

Privacy-safe event names are `landing_cta`, `walkthrough_started`,
`walkthrough_step`, `walkthrough_completed`, `docs_quickstart`,
`self_host_selected`, and `design_partner_selected`. Allowed properties are
page, CTA, step, anonymous session id, referrer class, and coarse device class.
Do not send order contents, member ids, emails, API keys, or free-form errors.

GitHub stars, clones, npm downloads, and raw page views are distribution
signals only. Exclude GitHub Actions package installs, known bot user agents,
synthetic monitors, staff sessions when possible, and repeated retries from
activation claims. Publish cohort windows and denominators with every rate.
