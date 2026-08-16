import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaRegistry, validate } from "@loyalty-interchange/protocol";
import { parse as parseYaml } from "yaml";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ASSET_ROOT = resolve(PACKAGE_DIR, "../assets");
export const REPO_ROOT = existsSync(resolve(BUNDLED_ASSET_ROOT, "llms.txt"))
  ? BUNDLED_ASSET_ROOT
  : resolve(PACKAGE_DIR, "../../..");

const ALLOWED_READ_PREFIXES = [
  "docs/",
  "spec/",
  "skills/",
  "examples/typescript/",
  "llms.txt",
  "llms-full.txt",
  "PLAN.md",
  "README.md"
];

export function assertReadable(relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, "");
  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed");
  }
  const allowed = ALLOWED_READ_PREFIXES.some(
    (prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix)
  );
  if (!allowed) {
    throw new Error(
      `Path not exposed. Allowed prefixes: ${ALLOWED_READ_PREFIXES.join(", ")}`
    );
  }
  return resolve(REPO_ROOT, normalized);
}

export async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(assertReadable(relativePath), "utf8");
}

export async function listApiOperations(): Promise<string> {
  const raw = await readRepoFile("spec/openapi.yaml");
  const document = parseYaml(raw) as {
    paths?: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
  };
  const lines: string[] = ["# LIP HTTP operations (from spec/openapi.yaml)", ""];
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method === "parameters") continue;
      const tag = operation.tags?.[0] ?? "Other";
      const summary = operation.summary ?? "";
      lines.push(`- ${method.toUpperCase()} ${path} [${tag}] — ${summary}`);
    }
  }
  return lines.join("\n");
}

export function validateJsonPayload(
  schemaName: string,
  json: string
): { ok: true } | { ok: false; message: string } {
  const entry = schemaRegistry[schemaName as keyof typeof schemaRegistry];
  if (!entry) {
    return { ok: false, message: `Unknown schema: ${schemaName}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const result = validate(entry, parsed);
  if (result.ok) return { ok: true };
  const issues = result.issues.map((i) => `${i.path} ${i.message} (${i.keyword})`).join("\n");
  return { ok: false, message: issues };
}

export const CHECKOUT_FLOW = `# LIP foodservice checkout lifecycle

1. orders/evaluate — preview earn + redeem eligibility (before payment)
2. redemptions/reserve — optional reward hold
3. [payment provider — not LIP]
4. accruals — post earned points
5. redemptions/capture — finalize redemption

On failure after reserve: redemptions/reverse
On full refund: redemptions/reverse (if redeemed) + orders/adjust (negative spend delta)

Idempotency keys must be stable per business id (order_id), not random per retry.
Apps must use a BFF; never expose the merchant API key to mobile/web clients.
`;

export const SDK_SNIPPETS: Record<string, string> = {
  enroll: `const enrolled = await lip.members.enroll({
  program_id: "demo-foodservice",
  identity: { type: "token", value: guestToken },
  member_id: "member-001"
});`,
  evaluate: `const preview = await lip.orders.evaluate({
  member_id: memberId,
  order: draftOrder
});
// preview.estimated_accrual.amount, preview.rewards[].status`,
  accrue: `await lip.accruals.post(
  { member_id: memberId, order },
  { idempotencyKey: \`accrual:\${order.order_id}\` }
);`,
  reserve: `const reserved = await lip.redemptions.reserve(
  {
    redemption_id: \`redemption-\${order.order_id}\`,
    member_id: memberId,
    reward_id: "five-off",
    order
  },
  { idempotencyKey: \`\${order.order_id}-reserve\` }
);`,
  capture: `await lip.redemptions.capture(
  { reservation_id: reserved.reservation.reservation_id, order_id: order.order_id },
  { idempotencyKey: \`\${order.order_id}-capture\` }
);`,
  reverse: `await lip.redemptions.reverse(
  { reservation_id, reason: "Payment failed" },
  { idempotencyKey: \`\${order.order_id}-reverse\` }
);`,
  adjust: `await lip.orders.adjust({
  member_id: memberId,
  program_id: "demo-foodservice",
  adjustment: {
    adjustment_id: \`adjust-\${order.order_id}\`,
    original_order_id: order.order_id,
    type: "full_refund",
    reason: "Customer refund",
    occurred_at: new Date().toISOString(),
    order_total_delta: { amount: -order.totals.total.amount, currency: "USD" },
    eligible_spend_delta: { amount: -eligibleSpend, currency: "USD" }
  }
}, { idempotencyKey: \`\${order.order_id}-refund-adjust\` });`,
  webhook: `import { verifyWebhook } from "@loyalty-interchange/sdk";

await verifyWebhook({
  payload: rawBody,
  secret: process.env.LIP_WEBHOOK_SECRET!,
  timestamp: headers["lip-webhook-timestamp"],
  signature: headers["lip-webhook-signature"]
});`
};
