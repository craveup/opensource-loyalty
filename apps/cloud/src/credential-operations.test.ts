import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryCredentialOperationStore } from "./credential-operation-store.js";
import {
  CREDENTIAL_HANDOFF_RETENTION_MS,
  ManagedCredentialService,
  assertIdempotencyKey,
  decryptHandoff,
  encryptHandoff,
  type CredentialOperationStore,
  type MerchantCredentialIssuer
} from "./credential-operations.js";
import { CloudError } from "./service.js";

const ENCRYPTION_KEY = randomBytes(32).toString("base64url");
const ENVIRONMENT = "env-alpha";

/**
 * A stand-in for the tenant runtime's access-control service. It mints a fresh
 * key id per call and remembers which keys are still live, so the tests can ask
 * the question that matters after a crash: is there a working credential nobody
 * holds?
 */
function issuer(overrides: Partial<MerchantCredentialIssuer> = {}): MerchantCredentialIssuer & {
  live: Set<string>;
  minted: string[];
  revoked: string[];
} {
  const live = new Set<string>();
  const minted: string[] = [];
  const revoked: string[] = [];
  let sequence = 0;
  return {
    live,
    minted,
    revoked,
    issueMerchantCredential: overrides.issueMerchantCredential ?? (async (environmentId) => {
      sequence += 1;
      const keyId = `key-${sequence}`;
      live.add(keyId);
      minted.push(keyId);
      return {
        environment_id: environmentId,
        tenant_id: "tenant-alpha",
        program_id: "program-alpha",
        api_url: `https://loyalty.example.com/runtime/v1/environments/${environmentId}`,
        admin_url: `https://loyalty.example.com/runtime/v1/environments/${environmentId}`,
        merchant_api_key: `lip_sk_secret-${sequence}`,
        merchant_api_key_id: keyId,
        ...(sequence > 1 ? { replaced_api_key_expires_at: "2026-01-02T00:00:00.000Z" } : {})
      };
    }),
    revokeMerchantKey: overrides.revokeMerchantKey ?? (async (_environmentId, keyId) => {
      live.delete(keyId);
      revoked.push(keyId);
    })
  };
}

function service(options: {
  store?: CredentialOperationStore;
  issuer?: MerchantCredentialIssuer;
  now?: () => Date;
} = {}): {
  service: ManagedCredentialService;
  store: CredentialOperationStore;
  issuer: ReturnType<typeof issuer>;
} {
  const store = options.store ?? new MemoryCredentialOperationStore();
  const issuing = (options.issuer ?? issuer()) as ReturnType<typeof issuer>;
  let sequence = 0;
  return {
    service: new ManagedCredentialService({
      store,
      issuer: issuing,
      encryptionKey: ENCRYPTION_KEY,
      ...(options.now ? { now: options.now } : {}),
      newId: () => `operation-${++sequence}`,
      onEvent: () => undefined
    }),
    store,
    issuer: issuing
  };
}

const request = {
  environmentId: ENVIRONMENT,
  idempotencyKey: "idem-1",
  operation: "rotate" as const,
  subject: "operator@crave"
};

describe("idempotency key validation", () => {
  it("requires a key and rejects unusable ones", () => {
    expect(() => assertIdempotencyKey(undefined)).toThrow(/Idempotency-Key is required/);
    expect(() => assertIdempotencyKey("   ")).toThrow(/Idempotency-Key is required/);
    expect(() => assertIdempotencyKey("has spaces")).toThrow(/at most 255/);
    expect(() => assertIdempotencyKey("a".repeat(256))).toThrow(/at most 255/);
    expect(assertIdempotencyKey(" idem-1 ")).toBe("idem-1");
  });
});

describe("merchant credential issuance", () => {
  it("issues once and returns the secret", async () => {
    const harness = service();
    const issued = await harness.service.issue(request);
    expect(issued.merchant_api_key).toBe("lip_sk_secret-1");
    expect(issued.merchant_api_key_id).toBe("key-1");
    expect(issued.environment_id).toBe(ENVIRONMENT);
    expect(harness.issuer.minted).toEqual(["key-1"]);
  });

  it("returns the identical credential for a same-key replay without minting again", async () => {
    const harness = service();
    const first = await harness.service.issue(request);
    const replayed = await harness.service.issue(request);
    expect(replayed).toEqual(first);
    expect(harness.issuer.minted).toEqual(["key-1"]);
  });

  it("refuses the same key carrying a different request", async () => {
    const harness = service();
    await harness.service.issue(request);
    await expect(
      harness.service.issue({ ...request, overlapSeconds: 3_600 })
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(harness.issuer.minted).toEqual(["key-1"]);
  });

  it("treats a different environment under the same key as its own operation", async () => {
    const harness = service();
    await harness.service.issue(request);
    const other = await harness.service.issue({ ...request, environmentId: "env-beta" });
    expect(other.merchant_api_key_id).toBe("key-2");
  });

  it("never stores the secret in recoverable plaintext", async () => {
    const store = new MemoryCredentialOperationStore();
    const harness = service({ store });
    const issued = await harness.service.issue(request);
    const record = await store.findById("operation-1");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(issued.merchant_api_key);
    expect(record?.handoff_envelope?.algorithm).toBe("aes-256-gcm");
  });
});

describe("lost responses and crashes", () => {
  it("recovers a crash between minting and persisting by revoking the orphan", async () => {
    const store = new MemoryCredentialOperationStore();
    const harness = service({ store });
    // Reproduce the exact window: the key exists and its id is recorded, but
    // the response was never stored, so nobody outside the process holds it.
    await store.claim({
      credential_operation_id: "operation-crashed",
      environment_id: ENVIRONMENT,
      idempotency_key: request.idempotencyKey,
      request_fingerprint: (await import("./credential-operations.js")).requestFingerprint({
        environmentId: ENVIRONMENT,
        operation: "rotate"
      }),
      operation: "rotate",
      state: "pending",
      actor_subject: request.subject,
      created_at: "2026-01-01T00:00:00.000Z"
    });
    harness.issuer.live.add("key-orphan");
    await store.recordIssuedKey({
      credentialOperationId: "operation-crashed",
      issuedKeyId: "key-orphan"
    });

    const recovered = await harness.service.issue(request);
    expect(harness.issuer.revoked).toEqual(["key-orphan"]);
    expect(harness.issuer.live.has("key-orphan")).toBe(false);
    expect(harness.issuer.live.has(recovered.merchant_api_key_id)).toBe(true);
  });

  it("refuses to mint a replacement when the orphan cannot be revoked", async () => {
    const store = new MemoryCredentialOperationStore();
    const failing = issuer({
      revokeMerchantKey: async () => {
        throw new Error("tenant runtime unavailable");
      }
    });
    const harness = service({ store, issuer: failing });
    await store.claim({
      credential_operation_id: "operation-crashed",
      environment_id: ENVIRONMENT,
      idempotency_key: request.idempotencyKey,
      request_fingerprint: (await import("./credential-operations.js")).requestFingerprint({
        environmentId: ENVIRONMENT,
        operation: "rotate"
      }),
      operation: "rotate",
      state: "pending",
      actor_subject: request.subject,
      created_at: "2026-01-01T00:00:00.000Z"
    });
    await store.recordIssuedKey({
      credentialOperationId: "operation-crashed",
      issuedKeyId: "key-orphan"
    });
    // Minting anyway would leave two live owner keys, one of them unclaimed.
    await expect(harness.service.issue(request)).rejects.toThrow(/tenant runtime unavailable/);
    expect(failing.minted).toEqual([]);
  });

  it("gives a recovered issuance no overlap, so the orphan lineage cannot linger", async () => {
    const store = new MemoryCredentialOperationStore();
    const overlaps: Array<number | undefined> = [];
    const recording = issuer();
    const inner = recording.issueMerchantCredential.bind(recording);
    recording.issueMerchantCredential = async (environmentId, options) => {
      overlaps.push(options.overlap_seconds);
      return inner(environmentId, options);
    };
    const harness = service({ store, issuer: recording });
    await store.claim({
      credential_operation_id: "operation-crashed",
      environment_id: ENVIRONMENT,
      idempotency_key: request.idempotencyKey,
      request_fingerprint: (await import("./credential-operations.js")).requestFingerprint({
        environmentId: ENVIRONMENT,
        operation: "rotate"
      }),
      operation: "rotate",
      state: "pending",
      actor_subject: request.subject,
      created_at: "2026-01-01T00:00:00.000Z"
    });
    await harness.service.issue(request);
    expect(overlaps).toEqual([0]);
  });

  it("records a failed issuance instead of leaving the key claimed forever", async () => {
    const store = new MemoryCredentialOperationStore();
    const broken = issuer({
      issueMerchantCredential: async () => {
        throw new Error("runtime unavailable");
      }
    });
    const harness = service({ store, issuer: broken });
    await expect(harness.service.issue(request)).rejects.toThrow(/runtime unavailable/);
    const record = await store.findById("operation-1");
    expect(record?.state).toBe("failed");
    expect(record?.last_error).toContain("runtime unavailable");
  });
});

describe("handoff retention", () => {
  it("stops serving a replay once the retention window closes", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const harness = service({ now: () => new Date(clock) });
    await harness.service.issue(request);
    clock += CREDENTIAL_HANDOFF_RETENTION_MS + 1_000;
    await expect(harness.service.issue(request)).rejects.toMatchObject({
      code: "credential_handoff_expired",
      status: 410
    });
  });

  it("erases the expired envelope but keeps the operation record", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const store = new MemoryCredentialOperationStore();
    const harness = service({ store, now: () => new Date(clock) });
    await harness.service.issue(request);
    clock += CREDENTIAL_HANDOFF_RETENTION_MS + 1_000;

    expect(await harness.service.purgeExpiredHandoffs()).toBe(1);
    const record = await store.findById("operation-1");
    expect(record?.handoff_envelope).toBeUndefined();
    // The audit trail is the part that must outlive the secret.
    expect(record).toMatchObject({
      state: "issued",
      issued_key_id: "key-1",
      actor_subject: "operator@crave",
      operation: "rotate"
    });
  });

  it("leaves a live handoff alone", async () => {
    const harness = service();
    await harness.service.issue(request);
    expect(await harness.service.purgeExpiredHandoffs()).toBe(0);
  });
});

describe("handoff envelope", () => {
  const handoff = {
    environment_id: ENVIRONMENT,
    tenant_id: "tenant-alpha",
    program_id: "program-alpha",
    api_url: "https://loyalty.example.com/runtime/v1/environments/env-alpha",
    admin_url: "https://loyalty.example.com/runtime/v1/environments/env-alpha",
    merchant_api_key: "lip_sk_secret",
    merchant_api_key_id: "key-1",
    issued_at: "2026-01-01T00:00:00.000Z"
  };
  const key = Buffer.from(ENCRYPTION_KEY, "base64url");

  it("round-trips under its own binding", () => {
    const envelope = encryptHandoff({ handoff, key, credentialOperationId: "operation-1" });
    expect(decryptHandoff({
      envelope,
      key,
      environmentId: ENVIRONMENT,
      credentialOperationId: "operation-1"
    })).toEqual(handoff);
  });

  it("refuses an envelope replayed under another environment or operation", () => {
    const envelope = encryptHandoff({ handoff, key, credentialOperationId: "operation-1" });
    // Both bindings matter: without them, a row copied between environments
    // would hand one tenant's live merchant key to another.
    expect(() => decryptHandoff({
      envelope,
      key,
      environmentId: "env-beta",
      credentialOperationId: "operation-1"
    })).toThrow(CloudError);
    expect(() => decryptHandoff({
      envelope,
      key,
      environmentId: ENVIRONMENT,
      credentialOperationId: "operation-2"
    })).toThrow(CloudError);
  });

  it("refuses an envelope encrypted under a different key", () => {
    const envelope = encryptHandoff({ handoff, key, credentialOperationId: "operation-1" });
    // A rotated encryption key makes stored handoffs unreadable. The caller has
    // to be told the credential is gone, not handed a decryption failure.
    expect(() => decryptHandoff({
      envelope,
      key: randomBytes(32),
      environmentId: ENVIRONMENT,
      credentialOperationId: "operation-1"
    })).toThrowError(
      expect.objectContaining({ code: "credential_handoff_expired", status: 410 })
    );
  });

  it("rejects an encryption key that is not 32 bytes of base64url", () => {
    expect(() => service({
      store: new MemoryCredentialOperationStore()
    })).not.toThrow();
    expect(() => new ManagedCredentialService({
      store: new MemoryCredentialOperationStore(),
      issuer: issuer(),
      encryptionKey: "too-short"
    })).toThrow(/32-byte base64url/);
  });
});

describe("concurrent issuance", () => {
  it("mints one key when the same request arrives many times at once", async () => {
    const harness = service();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => harness.service.issue(request))
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    // Every caller either receives the credential or is told to retry; what
    // must never happen is six live owner keys for one intent.
    expect(harness.issuer.minted.length).toBe(1);
    expect(fulfilled.length).toBeGreaterThan(0);
  });

  it("keeps distinct intents distinct", async () => {
    const harness = service();
    await Promise.all([
      harness.service.issue({ ...request, idempotencyKey: "idem-a" }),
      harness.service.issue({ ...request, idempotencyKey: "idem-b" })
    ]);
    expect(harness.issuer.minted).toEqual(["key-1", "key-2"]);
  });
});
