# Using LIP with AI

Loyalty Interchange Protocol (LIP) is designed for agent-assisted development.
Whether you are using Cursor, Claude Code, Codex, or another coding agent to
build a restaurant loyalty integration, or wiring an automation that reacts to
loyalty events, these guides cover the fastest path from zero to a correct
implementation.

Canonical source and install examples use
[`craveup/opensource-loyalty`](https://github.com/craveup/opensource-loyalty).

LIP is not an identity provider. Your app or backend-for-frontend (BFF) owns
customer sign-in; LIP owns the loyalty ledger. Agents should follow that split
unless you are building a provider adapter.

## Start here: `llms.txt`

The repo root includes [`llms.txt`](../llms.txt), a compact index of the
normative spec, OpenAPI contract, SDK entry points, CLI commands, and the files
agents should read before changing behavior. Point your agent at it first:

```text
@llms.txt
```

If your tool supports URL context, prefer the checked-in file in the clone over
generated summaries.

## Skills

LIP ships installable [Agent Skills](https://agentskills.io/) in the `skills/`
directory. They give coding agents specialized knowledge for checkout lifecycle,
webhooks, the BFF pattern, SDK usage, and conformance.

```bash
npx skills add .
```

Install one skill:

```bash
npx skills add . --skill lip-checkout
```

| Skill             | When to use                                    |
| ----------------- | ---------------------------------------------- |
| `lip`             | **Router** — start here                        |
| `lip-cli`         | `serve`, `doctor`, `test`, `validate`          |
| `lip-sdk`         | `LipClient`, idempotency, errors               |
| `lip-checkout`    | evaluate → reserve → accrue → capture → refund |
| `lip-webhooks`    | signed CloudEvents, receivers                  |
| `lip-bff`         | customer app + backend-for-frontend            |
| `lip-conformance` | doctor, test, e2e patterns                     |

Works with Cursor, Claude Code, Codex, Windsurf, GitHub Copilot, and other
agents that support skills. See [`skills/README.md`](../skills/README.md).

`lip init` prints the install command when you bootstrap a new project.

## CLI

The `lip` CLI is the primary tool for agents and humans to validate, serve, and
test a LIP deployment. From the repo root:

```bash
npm run lip -- init
npm run lip -- serve --api-key lip-dev-key
npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- test http://127.0.0.1:3210 --api-key lip-dev-key
```

Useful commands for agent workflows:

| Command                                         | Purpose                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `lip init`                                      | Create `lip.config.json` with default base URL and API key env var |
| `lip serve`                                     | Start the reference API, Admin dashboard, and SQLite sandbox       |
| `lip serve --program ./my-program.json`         | Boot with a custom program definition                              |
| `lip doctor`                                    | Check discovery, health, auth, and capabilities                    |
| `lip test`                                      | Run baseline non-destructive HTTP conformance checks               |
| `lip validate -s FoodserviceOrder ./order.json` | Validate a payload against a schema                                |
| `lip schemas`                                   | List schema names accepted by `lip validate`                       |

Load a custom program when building a brand-specific integration (for example
a demo rewards program in a companion app):

```bash
LIP_WEBHOOK_URL=http://127.0.0.1:8787/loyalty/webhook \
LIP_WEBHOOK_SECRET=your-shared-secret \
npm run lip -- serve --program ./my-program.json --api-key lip-dev-key
```

See [Getting started](getting-started.md) and [Five-minute quickstart](quickstart.md)
for the full local setup path.

## Spec and OpenAPI as agent context

LIP's contract is machine-readable. Before implementing or modifying loyalty
behavior, agents should load:

| Resource               | Path                                                                                | Use when                                          |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| OpenAPI 3.1 binding    | [`spec/openapi.yaml`](../spec/openapi.yaml)                                         | HTTP paths, auth, request/response shapes         |
| JSON Schemas           | [`spec/schemas/`](../spec/schemas/)                                                 | Payload validation and code generation            |
| Lifecycle rules        | [`spec/lifecycle.md`](../spec/lifecycle.md)                                         | Reserve → capture → reverse, refunds, idempotency |
| Foodservice profile    | [`spec/profiles/foodservice.md`](../spec/profiles/foodservice.md)                   | Order lines, modifiers, tenders, earning rules    |
| Webhook profile        | [`spec/webhooks.md`](../spec/webhooks.md)                                           | Signature verification and deduplication          |
| Full lifecycle example | [`examples/typescript/full-lifecycle.ts`](../examples/typescript/full-lifecycle.ts) | End-to-end SDK usage                              |

When docs and spec disagree, treat `spec/` as canonical.

Recommended agent read order for a new integration:

1. [`llms.txt`](../llms.txt)
2. [`spec/lifecycle.md`](../spec/lifecycle.md)
3. [`examples/typescript/full-lifecycle.ts`](../examples/typescript/full-lifecycle.ts)
4. [`docs/typescript-sdk.md`](typescript-sdk.md)
5. [`docs/api-endpoints.md`](api-endpoints.md)

## TypeScript SDK

The idiomatic client handles protocol context, validation, typed errors, and
retry-safe reads. Agents should prefer `LipClient` over hand-rolled `fetch`
calls:

```ts
import { LipClient } from "@loyalty-interchange/sdk";

const lip = new LipClient({
  baseUrl: process.env.LIP_URL!,
  apiKey: process.env.LIP_API_KEY!,
  source: { system: "my-ordering-app", instance: "production" },
});

const evaluation = await lip.orders.evaluate({
  member_id: memberId,
  order: draftOrder,
});
```

Mutations must use stable idempotency keys derived from business identifiers
(order id, reservation id), not random UUIDs per attempt:

```ts
await lip.accruals.post(
  { member_id: memberId, order },
  { idempotencyKey: `accrual:${order.order_id}` },
);
```

Run the runnable example:

```bash
npm run example:sdk
```

See [TypeScript SDK](typescript-sdk.md) for operations, money helpers, the order
builder, and webhook verification.

## Webhooks and event-driven agents

The reference platform emits signed CloudEvents after successful mutations
(enrollment, accrual, adjustment, reserve, capture, reverse). Enable delivery
with environment variables or the `webhooks` option on `createDemoPlatform`.

Receivers must verify the raw body with `verifyWebhook` from
`@loyalty-interchange/sdk` and deduplicate on CloudEvent `source` + `id`. See
[Webhook delivery](webhook-delivery.md) for configuration and semantics.

This is the primary event surface for agents that need to react to loyalty
changes without polling the ledger. A typical pattern:

1. Your BFF or worker exposes `POST /loyalty/webhook`.
2. The LIP server pushes signed events after mutations.
3. The receiver verifies, deduplicates, and triggers downstream automation
   (CRM sync, push notifications, analytics).

A reference BFF that implements this pattern typically exposes received
events at an endpoint like `GET /loyalty/events` for local inspection.

## Build integrations with AI coding tools

### The BFF pattern

Mobile and web apps should not hold the LIP merchant API key. Agents building
customer-facing apps should introduce a thin backend that:

- Owns customer auth (email, OTP, social — outside LIP today)
- Maps app users to `member_id` and enrolls via `members/enroll`
- Prices orders server-side and calls `orders/evaluate` for earn/redeem previews
- Runs checkout: `redemptions/reserve` → payment → `accruals` →
  `redemptions/capture`, with `redemptions/reverse` on failure
- Posts `orders/adjust` on refunds

A typical reference for this pattern is a mobile app → Node BFF → LIP server
stack, with webhooks wired for event inspection.

### Checkout preview

Never compute points or reward eligibility client-side when the program can
change (tiers, campaigns, availability windows). Call `orders/evaluate` from
your BFF and surface `estimated_accrual` and `rewards[].status` to the app.

### Conformance before you ship

Agents should run these checks after implementing loyalty flows:

```bash
npm run lip -- doctor http://127.0.0.1:3210 --api-key lip-dev-key
npm run lip -- test http://127.0.0.1:3210 --api-key lip-dev-key
npm run test
```

For a full-stack integration, add HTTP end-to-end tests that boot the real
server and drive the lifecycle end to end.

## Use LIP's MCP server

LIP includes an official MCP server that exposes spec lookups, the `llms.txt`
index, OpenAPI operation lists, schema validation, checkout lifecycle checklists,
and SDK snippets — so agents do not guess loyalty semantics from training data.

**Cursor:** enable the repo root [`mcp.json`](../mcp.json) (Settings → MCP).

**Manual:**

```json
{
  "mcpServers": {
    "lip": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/server.ts"]
    }
  }
}
```

Run standalone:

```bash
npm run mcp
```

### MCP tools

| Tool                      | Purpose                               |
| ------------------------- | ------------------------------------- |
| `lip_index`               | Return `llms.txt`                     |
| `lip_read_doc`            | Read allowed docs/spec files          |
| `lip_list_api_operations` | Summarize `spec/openapi.yaml`         |
| `lip_list_schemas`        | Schema names for validation           |
| `lip_validate_json`       | Validate JSON against a schema        |
| `lip_checkout_flow`       | Checkout + refund lifecycle checklist |
| `lip_sdk_snippet`         | TypeScript snippet for an operation   |

## MCP terminology

In MCP, the **client** is the LLM application (Cursor, Claude) and the **server**
is the tool provider. LIP's MCP server supplies docs and validation — it does
not hold member data or merchant keys. Runtime loyalty calls still go through
your BFF and the HTTP API.

To expose live loyalty operations as MCP tools in your product, wrap
`LipClient` in a custom server and keep the merchant key server-side.

## AI prompts

Curated prompts help agents implement LIP correctly on the first pass — enroll
flows, checkout lifecycle, webhook receivers, refund adjustments, and
conformance checks. See [AI prompts](ai-prompts.md).

## What is not in the protocol (agent pitfalls)

Agents often assume `/lip/v1` provides platform features it deliberately
leaves out. Do not implement these against the protocol:

- Customer sign-in, OTP, or social auth. LIP is a merchant-key API;
  customer authentication belongs in your BFF. See
  [Customer identity](customer-identity.md).
- Issued coupon wallets or QR check-in flows. Build these in your BFF on
  top of the portable issued-reward and redemption operations.
- Push or email delivery itself. The platform signs, retries, and journals
  messages, but provider SDKs plug in through `MessagingConnectorAdapter`.

Several features agents expect **do** exist — as non-normative platform
features under `/admin/api/v1`, not as portable protocol operations. Use them
to operate a deployment; do not depend on them for cross-vendor portability:

- Campaigns and segments, including dynamic segments and a scheduler
- Program editing at runtime: versioned drafts, validation, optimistic
  publish, retained revision history, and rollback in the Admin Configure
  view (boot-time `--program` remains available for a fixed program)
- CRM member exports as JSON or formula-safe CSV, and persisted messaging jobs

See [Reference platform](reference-platform.md) for the full platform layer.

See [Punchh compatibility](punchh-compatibility.md) for migration mapping and
[API and documentation gap analysis](api-docs-gap-analysis.md) for the full
platform comparison.
