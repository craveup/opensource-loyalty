#!/usr/bin/env node

/**
 * Operator CLI for onboarding one brand (= one tenant) onto the shared LIP
 * cluster via the control-plane API:
 *
 *   LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:provision -- \
 *     --cloud-url https://lip-cloud.example.com \
 *     --org-slug demo-restaurants --org-name "Demo Restaurants" \
 *     --project-slug loyalty --project-name Loyalty \
 *     --env-slug production --env-name Production \
 *     --kind production --region us-east-1 --program-id demo-rewards
 *
 * Optionally add `--webhook-url https://... --webhook-secret <>=16 chars>` to
 * create the tenant's first webhook subscription at provision time (mints and
 * prints the merchant credential as a side effect; requires network reach to
 * the tenant runtime).
 *
 * Rotate (or first-retrieve) the merchant credential of a provisioned
 * environment without reading credential files from the data-plane host:
 *
 *   LIP_CLOUD_OPERATOR_KEY=lip_ok_... npm run cloud:provision -- rotate-credentials \
 *     --cloud-url https://lip-cloud.example.com \
 *     --environment env_... \
 *     [--overlap-seconds 0]   # emergency cutover: replaced key dies at once
 *
 * Authentication: `LIP_CLOUD_OPERATOR_KEY` (a per-operator
 * `lip_ok_` key) is required — identity comes from the key, so `--subject` is
 * optional and purely an on-behalf-of audit annotation. The legacy shared
 * `LIP_CLOUD_API_KEY` is rejected: it only bootstraps the first operator and
 * cannot authenticate these commands. Keys come ONLY from the environment
 * (never a flag, to keep them out of shell history); see
 * docs/runbooks/shared-cluster-provisioning.md.
 */

import { parseArgs } from "node:util";
import { provisionTenant, rotateTenantCredentials } from "./tenant-onboarding.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    environment: { type: "string" },
    "cloud-url": { type: "string" },
    subject: { type: "string" },
    email: { type: "string" },
    "org-slug": { type: "string" },
    "org-name": { type: "string" },
    "project-slug": { type: "string" },
    "project-name": { type: "string" },
    "env-slug": { type: "string" },
    "env-name": { type: "string" },
    kind: { type: "string", default: "production" },
    region: { type: "string" },
    "program-id": { type: "string" },
    "timeout-seconds": { type: "string", default: "120" },
    "overlap-seconds": { type: "string" },
    "webhook-url": { type: "string" },
    "webhook-secret": { type: "string" }
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

const operatorKey = process.env["LIP_CLOUD_OPERATOR_KEY"];
const legacyKey = process.env["LIP_CLOUD_API_KEY"];
const apiKey = operatorKey ?? legacyKey;
if (!apiKey || apiKey.length < 16) {
  console.error(
    "LIP_CLOUD_OPERATOR_KEY (lip_ok_..., >= 16 characters) is required in " +
    "the environment"
  );
  process.exit(1);
}
// The shared LIP_CLOUD_API_KEY only bootstraps the first operator,
// so it cannot drive provisioning or rotation. Reject it up front instead of
// asking for a --subject that would not make the request succeed.
if (!apiKey.startsWith("lip_ok_")) {
  console.error(
    "LIP_CLOUD_OPERATOR_KEY (lip_ok_...) is required: the shared " +
    "LIP_CLOUD_API_KEY only bootstraps the first operator and cannot " +
    "authenticate provisioning or rotation. Create an operator with " +
    "`npm run cloud:operator -- create --subject <you> --role platform-admin`."
  );
  process.exit(1);
}

const command = positionals[0] ?? "provision";
if (!["provision", "rotate-credentials"].includes(command)) {
  console.error(`Unknown command ${command}; use provision or rotate-credentials`);
  process.exit(1);
}

if (command === "rotate-credentials") {
  let overlapSeconds: number | undefined;
  if (values["overlap-seconds"] !== undefined) {
    overlapSeconds = Number.parseInt(values["overlap-seconds"], 10);
    if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0) {
      console.error("--overlap-seconds must be a non-negative integer (0 = immediate cutover)");
      process.exit(1);
    }
  }
  try {
    const rotated = await rotateTenantCredentials(
      {
        cloudUrl: required("cloud-url"),
        apiKey,
        ...(values.subject ? { subject: values.subject } : {}),
        ...(values.email ? { email: values.email } : {})
      },
      required("environment"),
      overlapSeconds !== undefined ? { overlapSeconds } : {}
    );
    console.log(JSON.stringify({ event: "tenant_credentials_rotated", ...rotated }, undefined, 2));
    console.error(
      "[note] Store merchant_api_key in the password manager and update the " +
      "consuming BFF now; the replaced key stops working at " +
      `${rotated.replaced_api_key_expires_at ?? "the end of the overlap window"}.`
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "tenant_credential_rotation_failed",
      message: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
  process.exit(0);
}

const kind = required("kind");
if (!["development", "staging", "production"].includes(kind)) {
  console.error("--kind must be development, staging, or production");
  process.exit(1);
}
const timeoutSeconds = Number.parseInt(required("timeout-seconds"), 10);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
  console.error("--timeout-seconds must be a positive integer");
  process.exit(1);
}

if (Boolean(values["webhook-url"]) !== Boolean(values["webhook-secret"])) {
  console.error("--webhook-url and --webhook-secret must be provided together");
  process.exit(1);
}

try {
  const result = await provisionTenant(
    {
      cloudUrl: required("cloud-url"),
      apiKey,
      ...(values.subject ? { subject: values.subject } : {}),
      ...(values.email ? { email: values.email } : {})
    },
    {
      organization: { name: required("org-name"), slug: required("org-slug") },
      project: { name: required("project-name"), slug: required("project-slug") },
      environment: {
        name: required("env-name"),
        slug: required("env-slug"),
        kind: kind as "development" | "staging" | "production",
        region: required("region"),
        programId: required("program-id")
      },
      ...(values["webhook-url"] && values["webhook-secret"]
        ? { webhook: { url: values["webhook-url"], secret: values["webhook-secret"] } }
        : {}),
      poll: { timeoutMs: timeoutSeconds * 1_000 }
    }
  );
  console.log(JSON.stringify({ event: "tenant_provisioned", ...result }, undefined, 2));
  if (result.credentials) {
    console.error(
      "[note] Webhook onboarding minted the merchant API key above " +
      "(credentials.merchant_api_key): store it in the password manager and " +
      "set it on the consuming BFF now."
    );
  } else if (result.status === "ready") {
    console.error(
      "[note] Retrieve the merchant API key with: npm run cloud:provision -- " +
      `rotate-credentials --cloud-url <url> --environment ${result.environment_id}`
    );
  }
  if (result.status !== "ready" || result.timed_out) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    event: "tenant_provisioning_failed",
    message: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
}
