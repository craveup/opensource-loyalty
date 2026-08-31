import { randomUUID } from "node:crypto";
import type { AsyncStateStore } from "@loyalty-interchange/storage";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 3_000;

export interface TelemetryState {
  version: 1;
  installation_id: string;
  last_sent_at?: string;
}

export interface TelemetryHeartbeat {
  schema: "lip.self_host.heartbeat.v1";
  installation_id: string;
  sent_at: string;
  runtime: {
    node_major: number;
    storage_driver: string;
  };
  features: string[];
}

export type TelemetrySendResult = "disabled" | "throttled" | "sent" | "failed";

export interface TelemetryServiceOptions {
  store: AsyncStateStore<TelemetryState>;
  enabled?: boolean;
  endpoint?: string;
  storageDriver: string;
  features?: string[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
  intervalMs?: number;
  reset?: boolean;
}

function telemetryEndpoint(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LIP_TELEMETRY_ENDPOINT must be an absolute URL");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("LIP_TELEMETRY_ENDPOINT must use HTTPS (HTTP is allowed only for loopback)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("LIP_TELEMETRY_ENDPOINT must not contain credentials, query parameters, or fragments");
  }
  return url;
}

function normalizedFeatures(features: string[] | undefined): string[] {
  return [...new Set(features ?? [])]
    .filter((feature) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(feature))
    .sort()
    .slice(0, 32);
}

export class TelemetryService {
  private readonly store: AsyncStateStore<TelemetryState>;
  private readonly enabled: boolean;
  private readonly endpoint: URL | undefined;
  private readonly storageDriver: string;
  private readonly features: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private state: TelemetryState;
  private revision: number;

  private constructor(
    options: TelemetryServiceOptions,
    state: TelemetryState,
    revision: number
  ) {
    this.store = options.store;
    this.enabled = options.enabled === true;
    this.endpoint = telemetryEndpoint(options.endpoint);
    if (this.enabled && !this.endpoint) {
      throw new Error("LIP_TELEMETRY_ENDPOINT is required when LIP_TELEMETRY_ENABLED=true");
    }
    this.storageDriver = options.storageDriver;
    this.features = normalizedFeatures(options.features);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.state = state;
    this.revision = revision;
  }

  public static async create(options: TelemetryServiceOptions): Promise<TelemetryService> {
    try {
      if (options.reset) await options.store.clear();
      const loaded = await options.store.load();
      const state = loaded?.state ?? {
        version: 1 as const,
        installation_id: randomUUID()
      };
      if (state.version !== 1) {
        throw new Error("Stored telemetry state is incompatible");
      }
      const service = new TelemetryService(options, state, loaded?.revision ?? 0);
      if (!loaded) service.revision = await options.store.save(state, 0);
      return service;
    } catch (error) {
      await options.store.close();
      throw error;
    }
  }

  /**
   * Sends one bounded, pseudonymous heartbeat. This never throws, retries, or
   * blocks platform startup. It contains no customer, order, location, URL,
   * host, credential, error, or free-form fields.
   */
  public async sendHeartbeat(): Promise<TelemetrySendResult> {
    if (!this.enabled || !this.endpoint) return "disabled";
    const sentAt = this.now();
    const previous = this.state.last_sent_at ? Date.parse(this.state.last_sent_at) : undefined;
    if (previous !== undefined && sentAt.getTime() - previous < this.intervalMs) {
      return "throttled";
    }
    const payload: TelemetryHeartbeat = {
      schema: "lip.self_host.heartbeat.v1",
      installation_id: this.state.installation_id,
      sent_at: sentAt.toISOString(),
      runtime: {
        node_major: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
        storage_driver: this.storageDriver
      },
      features: this.features
    };
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) return "failed";
      this.state = { ...this.state, last_sent_at: sentAt.toISOString() };
      this.revision = await this.store.save(this.state, this.revision);
      return "sent";
    } catch {
      return "failed";
    }
  }

  public async close(): Promise<void> {
    await this.store.close();
  }
}
