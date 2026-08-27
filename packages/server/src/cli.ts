#!/usr/bin/env node

import { resolve } from "node:path";
import { createDemoPlatform, createPostgresProtocolPlatform } from "./platform.js";
import { assertStrongApiKey, startReferenceServer } from "./server.js";

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const port = Number.parseInt(process.env.PORT ?? "3210", 10);
const host = process.env.HOST ?? "127.0.0.1";
const apiKey = process.env.LIP_API_KEY ?? "lip-dev-key";
const databasePath = resolve(process.env.LIP_DATABASE_PATH ?? ".lip/reference.db");
const databaseUrl = process.env.LIP_DATABASE_URL;
const rateLimit = positiveIntegerEnvironment("LIP_RATE_LIMIT_REQUESTS", 120);
const rateWindowMs = positiveIntegerEnvironment("LIP_RATE_LIMIT_WINDOW_MS", 60_000);
// Postgres mode means a shared/cloud deployment: refuse to boot with the
// local development default or a short key (PLA-416 static-key hygiene).
if (databaseUrl) assertStrongApiKey(apiKey);
const platform = databaseUrl
  ? await createPostgresProtocolPlatform({
      connectionString: databaseUrl,
      ...(process.env.LIP_TENANT_ID ? { tenantId: process.env.LIP_TENANT_ID } : {}),
      seed: process.env.LIP_SEED_DEMO !== "false",
      reset: process.env.LIP_RESET === "true"
    })
  : await createDemoPlatform({
      databasePath,
      seed: process.env.LIP_SEED_DEMO !== "false",
      reset: process.env.LIP_RESET === "true"
    });

const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m"
};

function useColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
}

function paint(value: string, code: keyof typeof ansi, enabled: boolean): string {
  return enabled ? `${ansi[code]}${value}${ansi.reset}` : value;
}

function row(label: string, value: string, color: boolean): string {
  return `  ${paint(label.padEnd(10), "dim", color)} ${value}`;
}

function formatRuntimeReady(details: {
  adminUrl: string;
  apiBaseUrl: string;
  apiKey: string;
  databasePath: string;
  bindUrl: string;
}): string {
  const color = useColor();
  const divider = paint("=".repeat(62), "cyan", color);
  return [
    "",
    divider,
    `${paint("Loyalty Interchange", "bold", color)} ${paint("local runtime", "dim", color)}`,
    `${paint("[ready]", "green", color)} Reference API and Admin dashboard are running.`,
    "",
    row("Admin", details.adminUrl, color),
    row("API", `${details.apiBaseUrl}/lip/v1`, color),
    row("Health", `${details.apiBaseUrl}/health`, color),
    row("Key", paint(details.apiKey, "yellow", color), color),
    row("Storage", details.databasePath, color),
    row("Bind", details.bindUrl, color),
    "",
    "Use the Admin/API key for both dashboard sign-in and Bearer API requests.",
    "",
    paint("Press Ctrl+C to stop the local server.", "dim", color),
    divider,
    ""
  ].join("\n");
}

const running = await startReferenceServer(platform.engine, {
  apiKey,
  host,
  port,
  reservationTtlSeconds: 120,
  rateLimit: {
    maxRequests: rateLimit,
    windowMs: rateWindowMs
  },
  ...(process.env.LIP_STRUCTURED_LOGS === "false" ? {} : {
    requestLogger: (entry) => console.log(JSON.stringify({ event: "http_request", ...entry }))
  }),
  ...("executeEngineOperation" in platform
    ? {
        executeEngineOperation: platform.executeEngineOperation,
        readEngineSnapshot: platform.readEngineSnapshot
      }
    : { persistState: (state) => platform.store.save(state) }),
  admin: {
    ...(platform.adminAssetRoot ? { assetRoot: platform.adminAssetRoot } : {}),
    storage: platform.store.status,
    ...("programs" in platform
      ? {
          programs: platform.programs,
          campaigns: platform.campaigns,
          customerData: platform.customerData,
          memberships: platform.memberships,
          access: platform.access,
          engagement: platform.engagement,
          locations: platform.locations
        }
      : {}),
    webhookManager: platform.webhooks
  }
});

const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
const displayUrl = `http://${displayHost}:${new URL(running.url).port}`;

console.log(formatRuntimeReady({
  adminUrl: `${displayUrl}/admin/`,
  apiBaseUrl: displayUrl,
  apiKey,
  databasePath: databaseUrl ? "Postgres (tenant-scoped normalized tables)" : databasePath,
  bindUrl: running.url
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void running.close().then(() => {
      void Promise.resolve(platform.close()).then(() => process.exit(0));
    });
  });
}
