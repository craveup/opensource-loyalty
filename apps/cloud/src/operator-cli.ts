#!/usr/bin/env node

/**
 * Operator directory CLI  — manage per-operator control-plane
 * credentials over the /cloud/v1/operators API.
 *
 * Bootstrap the FIRST platform-admin with the legacy shared key, then throw
 * that key away:
 *
 *   LIP_CLOUD_API_KEY=<shared key> npm run cloud:operator -- create \
 *     --cloud-url https://lip-cloud.example.com \
 *     --subject operator@example.com --email operator@example.com \
 *     --role platform-admin
 *
 * Every later call authenticates with an operator key instead:
 *
 *   LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:operator -- create \
 *     --cloud-url ... --subject brand-bff --role org-scoped --org-ids org_a,org_b
 *   LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:operator -- list --cloud-url ...
 *
 * The printed `secret` is shown exactly once — store it in the password
 * manager. Keys come ONLY from the environment, never a flag.
 */

import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "cloud-url": { type: "string" },
    subject: { type: "string" },
    email: { type: "string" },
    role: { type: "string", default: "platform-admin" },
    "org-ids": { type: "string" },
    "key-name": { type: "string" },
    "key-expires-at": { type: "string" }
  }
});

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== "string" || !value.trim()) {
    console.error(`--${String(name)} is required`);
    process.exit(1);
  }
  return value.trim();
}

const apiKey = process.env["LIP_CLOUD_OPERATOR_KEY"] ?? process.env["LIP_CLOUD_API_KEY"];
if (!apiKey || apiKey.length < 16) {
  console.error(
    "LIP_CLOUD_OPERATOR_KEY (or, for bootstrap only, the legacy " +
    "LIP_CLOUD_API_KEY) is required in the environment"
  );
  process.exit(1);
}

const command = positionals[0] ?? "create";
if (!["create", "list"].includes(command)) {
  console.error(`Unknown command ${command}; use create or list`);
  process.exit(1);
}

const base = required("cloud-url").replace(/\/+$/, "");
const headers: Record<string, string> = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json"
};

interface ProblemBody { code?: string; detail?: string; title?: string }

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = (await response.json().catch(() => ({}))) as
    | { data?: T }
    | ProblemBody;
  if (!response.ok) {
    const problem = payload as ProblemBody;
    throw new Error(
      `${method} ${path} failed with ${response.status}: ` +
      `${problem.code ?? "request_failed"} ${problem.detail ?? problem.title ?? ""}`.trim()
    );
  }
  return (payload as { data: T }).data;
}

try {
  if (command === "list") {
    const operators = await call<unknown[]>("GET", "/cloud/v1/operators");
    console.log(JSON.stringify({ event: "operators_listed", operators }, undefined, 2));
  } else {
    const role = required("role");
    if (!["platform-admin", "org-scoped"].includes(role)) {
      console.error("--role must be platform-admin or org-scoped");
      process.exit(1);
    }
    const organizationIds = values["org-ids"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const created = await call<{
      operator: { operator_id: string };
      secret: string;
    }>("POST", "/cloud/v1/operators", {
      subject: required("subject"),
      role,
      ...(values.email ? { email: values.email } : {}),
      ...(organizationIds?.length ? { organization_ids: organizationIds } : {}),
      ...(values["key-name"] || values["key-expires-at"]
        ? {
            key: {
              ...(values["key-name"] ? { name: values["key-name"] } : {}),
              ...(values["key-expires-at"]
                ? { expires_at: values["key-expires-at"] }
                : {})
            }
          }
        : {})
    });
    console.log(JSON.stringify({ event: "operator_created", ...created }, undefined, 2));
    console.error(
      "[note] The secret above is shown exactly once — store it in the " +
      "password manager and set LIP_CLOUD_OPERATOR_KEY on the consumer now."
    );
  }
} catch (error) {
  console.error(JSON.stringify({
    event: "operator_command_failed",
    message: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
}
