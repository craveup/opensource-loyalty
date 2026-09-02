import { readFile } from "node:fs/promises";
import {
  createDemoPlatform,
  startReferenceServer,
  type RunningServer
} from "@loyalty-interchange/server";
import type { ProgramDefinition } from "@loyalty-interchange/reference";
import { formatServerReady } from "./presentation.js";

export interface MockOptions {
  host: string;
  port: number;
  apiKey: string;
  databasePath?: string;
  reset?: boolean;
  seed?: boolean;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
  structuredLogs?: boolean;
  /** Path to a JSON program definition that replaces the built-in demo program. */
  programPath?: string;
  /** Start with /lip/v1 writes frozen (maintenance mode). */
  writeFrozen?: boolean;
  /** Development-only opt-in for loopback/private webhook receivers. */
  allowPrivateWebhookNetworks?: boolean;
}

async function loadProgram(path: string): Promise<ProgramDefinition> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Program file ${path} must contain a JSON object`);
  }
  return parsed as ProgramDefinition;
}

export async function startMockServer(options: MockOptions): Promise<RunningServer> {
  const program = options.programPath ? await loadProgram(options.programPath) : undefined;
  const platform = await createDemoPlatform({
    databasePath: options.databasePath ?? ":memory:",
    ...(options.reset ? { reset: true } : {}),
    ...(options.seed === false ? { seed: false } : {}),
    ...(program ? { program } : {}),
    ...(options.allowPrivateWebhookNetworks ? { allowPrivateWebhookNetworks: true } : {})
  });
  const running = await startReferenceServer(platform.engine, {
    host: options.host,
    port: options.port,
    apiKey: options.apiKey,
    reservationTtlSeconds: 120,
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.writeFrozen ? { writeFrozen: true } : {}),
    ...(options.structuredLogs ? {
      requestLogger: (entry) => console.log(JSON.stringify({ event: "http_request", ...entry }))
    } : {}),
    persistState: (state) => platform.store.save(state),
    admin: {
      ...(platform.adminAssetRoot ? { assetRoot: platform.adminAssetRoot } : {}),
      storage: platform.store.status,
      programs: platform.programs,
      campaigns: platform.campaigns,
      customerData: platform.customerData,
      memberships: platform.memberships,
      access: platform.access,
      engagement: platform.engagement,
      locations: platform.locations,
      webhookManager: platform.webhooks
    }
  });
  return {
    ...running,
    close: async () => {
      await running.close();
      await platform.close();
    }
  };
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function runMockServer(
  options: MockOptions,
  output: (message: string) => void = console.log
): Promise<void> {
  const running = await startMockServer(options);
  const displayHost = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
  const port = new URL(running.url).port;
  const apiBaseUrl = `http://${displayHost}:${port}`;
  const commandPrefix = process.env.npm_lifecycle_event ? "npm run lip --" : "lip";
  const connectionArgs = `${shellToken(apiBaseUrl)} --api-key ${shellToken(options.apiKey)}`;
  output(formatServerReady({
    adminUrl: `${apiBaseUrl}/admin/`,
    apiBaseUrl,
    apiKey: options.apiKey,
    databasePath: options.databasePath ?? ":memory:",
    discoveryUrl: `${apiBaseUrl}/.well-known/lip`,
    doctorCommand: `${commandPrefix} doctor ${connectionArgs}`,
    testCommand: `${commandPrefix} test ${connectionArgs}`
  }));

  await new Promise<void>((resolve) => {
    const close = (): void => {
      void running.close().then(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}
