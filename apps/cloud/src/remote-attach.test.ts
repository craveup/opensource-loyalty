import { describe, expect, it } from "vitest";
import { RemoteEnvironmentAttacher, apiKeyFingerprint } from "./remote-attach.js";

// A stub fetch that routes by URL + method + auth header.
function stubFetch(handlers: (url: string, init: RequestInit) => Response | undefined): typeof globalThis.fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const res = handlers(String(input), init);
    return res ?? new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

const GOOD = "lip_sk_realkey_abcdefghijklmnop";
function bearer(init: RequestInit): string | undefined {
  const h = new Headers(init.headers); const v = h.get("authorization");
  return v?.startsWith("Bearer ") ? v.slice(7) : undefined;
}
// Full happy-path host: health ok, discovery valid, real key 200 / bogus 401, program matches.
function happyHost(url: string, init: RequestInit): Response | undefined {
  if (url.endsWith("/health")) return Response.json({ status: "ok" });
  if (url.endsWith("/.well-known/lip")) return Response.json({ protocol_version: "1.0", profiles: ["foodservice/1.0"] });
  if (url.endsWith("/lip/v1/capabilities")) return new Response(null, { status: bearer(init) === GOOD ? 200 : 401 });
  if (url.endsWith("/lip/v1/programs/get")) return Response.json({ program: { program_id: "demo-rewards" } });
  return undefined;
}

describe("RemoteEnvironmentAttacher", () => {
  const attacher = (h: Parameters<typeof stubFetch>[0]) =>
    new RemoteEnvironmentAttacher({ fetch: stubFetch(h) });

  it("returns a binding when every check passes", async () => {
    const r = await attacher(happyHost).validate({ endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toEqual({ ok: true, binding: {
      api_url: "https://lip.example.com",
      admin_url: "https://lip.example.com/admin/",
      api_key_fingerprint: apiKeyFingerprint(GOOD)
    }});
  });

  it("rejects a non-TLS non-localhost url with not_tls", async () => {
    const r = await attacher(happyHost).validate({ endpoint_url: "http://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "not_tls" });
  });

  it("allows http on localhost", async () => {
    const r = await new RemoteEnvironmentAttacher({
      fetch: stubFetch(happyHost),
      allowPrivateNetworks: true
    }).validate({ endpoint_url: "http://127.0.0.1:13210", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: true });
  });

  it("rejects loopback and private destinations by default", async () => {
    const loopback = await attacher(happyHost).validate({
      endpoint_url: "http://127.0.0.1:13210",
      api_key: GOOD,
      program_id: "demo-rewards"
    });
    const privateNetwork = await attacher(happyHost).validate({
      endpoint_url: "https://10.0.0.5",
      api_key: GOOD,
      program_id: "demo-rewards"
    });
    expect(loopback).toMatchObject({ ok: false, code: "unsafe_destination" });
    expect(privateNetwork).toMatchObject({ ok: false, code: "unsafe_destination" });
  });

  it("reports health_unreachable when /health is not ok", async () => {
    const r = await attacher((u) => u.endsWith("/health") ? new Response(null, { status: 503 }) : happyHost(u, {})).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "health_unreachable" });
  });

  it("reports discovery_invalid on a version mismatch", async () => {
    const r = await attacher((u, i) => u.endsWith("/.well-known/lip") ? Response.json({ protocol_version: "9.9", profiles: ["x"] }) : happyHost(u, i)).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "discovery_invalid" });
  });

  it("reports auth_rejected when the real key is refused", async () => {
    const r = await attacher((u) => u.endsWith("/lip/v1/capabilities") ? new Response(null, { status: 401 }) : happyHost(u, {})).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "auth_rejected" });
  });

  it("reports auth_not_enforced when a bogus key is accepted", async () => {
    const r = await attacher((u) => u.endsWith("/lip/v1/capabilities") ? new Response(null, { status: 200 }) : happyHost(u, {})).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "auth_not_enforced" });
  });

  it("reports program_mismatch when the host serves another program", async () => {
    const r = await attacher((u, i) => u.endsWith("/lip/v1/programs/get") ? Response.json({ program: { program_id: "other" } }) : happyHost(u, i)).validate(
      { endpoint_url: "https://lip.example.com", api_key: GOOD, program_id: "demo-rewards" });
    expect(r).toMatchObject({ ok: false, code: "program_mismatch" });
  });

  it("fingerprint never contains the full key", () => {
    const fp = apiKeyFingerprint(GOOD);
    expect(fp).not.toContain(GOOD);
    expect(fp).toContain("…");
  });

  it("fully masks a short key so it can't be reconstructed", () => {
    const short = "lip_sk_short1"; // 13 chars
    const fp = apiKeyFingerprint(short);
    expect(fp).toBe("…");
    expect(fp).not.toContain("short");
  });
});
