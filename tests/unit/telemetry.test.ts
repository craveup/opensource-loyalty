import { describe, expect, it, vi } from "vitest";
import type { AsyncStateStore, VersionedState } from "@loyalty-interchange/storage";
import {
  TelemetryService,
  type TelemetryHeartbeat,
  type TelemetryState
} from "@loyalty-interchange/server";

class MemoryStore implements AsyncStateStore<TelemetryState> {
  private value: VersionedState<TelemetryState> | null = null;

  public async load(): Promise<VersionedState<TelemetryState> | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  public async save(state: TelemetryState, expectedRevision = this.value?.revision ?? 0): Promise<number> {
    expect(expectedRevision).toBe(this.value?.revision ?? 0);
    const revision = expectedRevision + 1;
    this.value = { state: structuredClone(state), revision };
    return revision;
  }

  public async clear(): Promise<void> { this.value = null; }
  public async close(): Promise<void> { return; }
}

describe("self-host telemetry", () => {
  it("is disabled by default and performs no network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = await TelemetryService.create({
      store: new MemoryStore(),
      storageDriver: "sqlite",
      fetchImpl
    });
    await expect(service.sendHeartbeat()).resolves.toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends only the documented allowlisted fields and throttles repeats", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const service = await TelemetryService.create({
      store: new MemoryStore(),
      enabled: true,
      endpoint: "https://telemetry.example.test/v1/heartbeat",
      storageDriver: "postgres",
      features: ["platform-api", "admin", "invalid feature"],
      fetchImpl,
      now: () => new Date("2026-08-27T12:00:00.000Z")
    });
    await expect(service.sendHeartbeat()).resolves.toBe("sent");
    await expect(service.sendHeartbeat()).resolves.toBe("throttled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, request] = fetchImpl.mock.calls[0]!;
    const payload = JSON.parse(String(request?.body)) as TelemetryHeartbeat;
    expect(Object.keys(payload).sort()).toEqual(["features", "installation_id", "runtime", "schema", "sent_at"]);
    expect(payload).toMatchObject({
      schema: "lip.self_host.heartbeat.v1",
      sent_at: "2026-08-27T12:00:00.000Z",
      runtime: { storage_driver: "postgres" },
      features: ["admin", "platform-api"]
    });
    expect(JSON.stringify(payload)).not.toMatch(/member|email|order|location|credential|error/i);
  });

  it("rejects enabled telemetry without a safe explicit endpoint", async () => {
    await expect(TelemetryService.create({
      store: new MemoryStore(),
      enabled: true,
      storageDriver: "sqlite"
    })).rejects.toThrow("LIP_TELEMETRY_ENDPOINT is required");
    await expect(TelemetryService.create({
      store: new MemoryStore(),
      enabled: true,
      endpoint: "http://telemetry.example.test/collect",
      storageDriver: "sqlite"
    })).rejects.toThrow("must use HTTPS");
  });
});
