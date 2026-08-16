import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoyaltyEventSchema, validate, type LoyaltyEvent } from "@loyalty-interchange/protocol";
import {
  EventedLoyaltyEngine,
  WebhookHistoryJournal,
  WebhookOutboxJournal,
  type WebhookHistoryState,
  type WebhookOutboxState,
  WebhookDispatcher,
  createDemoPlatform,
  webhookSubscriptionsFromEnv
} from "@loyalty-interchange/server";
import { verifyWebhook } from "@loyalty-interchange/sdk";
import {
  MutableClock,
  makeContext,
  makeEnroll,
  makeOrder,
  makeProgram,
  sequentialIds
} from "../fixtures.js";

interface CapturedRequest {
  url: string;
  timestamp: string;
  signature: string;
  body: string;
}

function capturingFetch(captured: CapturedRequest[], statuses: number[] = []): typeof fetch {
  let call = 0;
  return async (input, init) => {
    const status = statuses[call] ?? 200;
    call += 1;
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(input),
      timestamp: headers.get("lip-webhook-timestamp") ?? "",
      signature: headers.get("lip-webhook-signature") ?? "",
      body: String(init?.body)
    });
    return new Response(null, { status });
  };
}

function makeEvent(overrides: Partial<LoyaltyEvent> = {}): LoyaltyEvent {
  return {
    specversion: "1.0",
    id: "evt-test-001",
    source: "urn:lip:program:demo-foodservice",
    type: "org.loyalty-interchange.member.enrolled.v1",
    subject: "member-001",
    time: "2026-07-01T00:00:00.000Z",
    datacontenttype: "application/json",
    lipversion: "1.0",
    data: {
      member: {
        member_id: "member-001",
        program_id: "demo-foodservice",
        status: "active",
        tier_id: "regular",
        joined_at: "2026-07-01T00:00:00.000Z",
        identities: [{ type: "token", value: "guest-token-001", issuer: "test-identity" }]
      }
    },
    ...overrides
  };
}

function eventedEngine(emitted: LoyaltyEvent[], clock = new MutableClock()): EventedLoyaltyEngine {
  return new EventedLoyaltyEngine(makeProgram(), {
    clock,
    ids: sequentialIds(),
    emit: (event) => emitted.push(event)
  });
}

describe("WebhookDispatcher", () => {
  it("validates and updates managed subscriptions without exposing secrets", async () => {
    const persisted: unknown[] = [];
    const captured: CapturedRequest[] = [];
    const dispatcher = await WebhookDispatcher.create({
      subscriptions: [],
      fetch: capturingFetch(captured, [204]),
      onSubscriptionsChanged: (subscriptions) => { persisted.push(subscriptions); }
    });
    expect(() => dispatcher.upsertSubscription({
      url: "ftp://receiver.example/hooks",
      secret: "long-enough-secret"
    })).toThrowError(/HTTP/);
    expect(() => dispatcher.upsertSubscription({
      url: "https://user:pass@receiver.example/hooks",
      secret: "long-enough-secret"
    })).toThrowError(/credentials/);
    expect(() => dispatcher.upsertSubscription({
      url: "https://receiver.example/hooks",
      secret: "short"
    })).toThrowError(/16/);
    expect(() => dispatcher.upsertSubscription({
      url: "https://receiver.example/hooks",
      secret: "long-enough-secret",
      retry_policy: { max_attempts: 0, backoff_ms: -1, timeout_ms: 10 }
    })).toThrowError(/retry policy/);

    const created = dispatcher.upsertSubscription({
      url: "https://receiver.example/hooks",
      secret: "long-enough-secret",
      events: [
        "org.loyalty-interchange.member.enrolled.v1",
        "org.loyalty-interchange.member.enrolled.v1"
      ],
      retry_policy: { max_attempts: 2, backoff_ms: 10, timeout_ms: 1000 }
    });
    expect(created).not.toHaveProperty("secret");
    expect(created.events).toHaveLength(1);
    expect(created.retry_policy?.max_attempts).toBe(2);
    dispatcher.rotateSecret(created.subscription_id, "replacement-secret");
    dispatcher.upsertSubscription({
      subscription_id: created.subscription_id,
      url: created.url,
      secret: "replacement-secret",
      active: false
    });
    dispatcher.emit(makeEvent());
    await dispatcher.flush();
    expect(captured).toHaveLength(0);
    expect(dispatcher.removeSubscription("missing")).toBe(false);
    expect(dispatcher.retryDelivery("missing")).toBe(false);
    expect(dispatcher.replayDelivery("missing")).toBe(false);
    expect(() => dispatcher.rotateSecret("missing", "replacement-secret")).toThrowError(/not found/);
    expect(dispatcher.removeSubscription(created.subscription_id)).toBe(true);
    expect(persisted.length).toBeGreaterThan(2);
  });

  it("signs deliveries so SDK receivers can verify them", async () => {
    const captured: CapturedRequest[] = [];
    const dispatcher = await WebhookDispatcher.create({
      subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
      fetch: capturingFetch(captured)
    });
    const event = makeEvent();
    dispatcher.emit(event);
    await dispatcher.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.body).toBe(JSON.stringify(event));
    await expect(
      verifyWebhook({
        payload: captured[0]!.body,
        secret: "hook-secret",
        timestamp: captured[0]!.timestamp,
        signature: captured[0]!.signature
      })
    ).resolves.toBeUndefined();
    await expect(
      verifyWebhook({
        payload: captured[0]!.body,
        secret: "wrong-secret",
        timestamp: captured[0]!.timestamp,
        signature: captured[0]!.signature
      })
    ).rejects.toMatchObject({ code: "invalid_signature" });
    expect(dispatcher.deliveries()).toEqual([
      expect.objectContaining({
        event_id: "evt-test-001",
        status: "delivered",
        attempts: 1
      })
    ]);
    expect(dispatcher.deliveryHealth(() => new Date("2026-07-17T00:00:00.000Z"))).toMatchObject({
      enabled: true,
      pending_count: 0,
      recent_total: 1,
      recent_succeeded: 1,
      recent_failed: 0,
      success_rate: 1,
      healthy: true,
      checked_at: "2026-07-17T00:00:00.000Z"
    });
  });

  it("reports unhealthy delivery when recent deliveries failed", async () => {
    const dispatcher = await WebhookDispatcher.create({
      subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
      fetch: capturingFetch([], [500, 500, 500]),
      maxAttempts: 1,
      backoffMs: 1,
      timeoutMs: 1000
    });
    dispatcher.emit(makeEvent({ id: "evt-fail-001" }));
    await dispatcher.flush();
    expect(dispatcher.deliveryHealth()).toMatchObject({
      enabled: true,
      recent_failed: 1,
      success_rate: 0,
      healthy: false
    });
    expect(
      (await WebhookDispatcher.create({ subscriptions: [] })).deliveryHealth()
    ).toMatchObject({
      enabled: false,
      pending_count: 0,
      recent_total: 0,
      success_rate: null,
      healthy: false
    });
  });

  it("retries failed deliveries with backoff and gives up after max attempts", async () => {
    const retried: CapturedRequest[] = [];
    const recovering = await WebhookDispatcher.create({
      subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
      fetch: capturingFetch(retried, [500, 503, 200]),
      backoffMs: 1
    });
    recovering.emit(makeEvent());
    await recovering.flush();
    expect(retried).toHaveLength(3);
    expect(recovering.deliveries()).toEqual([
      expect.objectContaining({ status: "delivered", attempts: 3 })
    ]);

    const exhausted: CapturedRequest[] = [];
    const errors: string[] = [];
    const failing = await WebhookDispatcher.create({
      subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
      fetch: capturingFetch(exhausted, [500, 500, 500]),
      backoffMs: 1,
      onError: (message) => errors.push(message)
    });
    failing.emit(makeEvent());
    await failing.flush();
    expect(exhausted).toHaveLength(3);
    expect(failing.deliveries()).toEqual([
      expect.objectContaining({
        status: "failed",
        attempts: 3,
        last_error: "receiver responded with HTTP 500"
      })
    ]);
    expect(errors).toHaveLength(1);

    const policyAttempts: CapturedRequest[] = [];
    const policyDispatcher = await WebhookDispatcher.create({
      subscriptions: [{
        url: "https://receiver.example/policy",
        secret: "hook-secret",
        retry_policy: { max_attempts: 2, backoff_ms: 0, timeout_ms: 1000 }
      }],
      fetch: capturingFetch(policyAttempts, [500, 500, 200])
    });
    policyDispatcher.emit(makeEvent());
    await policyDispatcher.flush();
    expect(policyAttempts).toHaveLength(2);
  });

  it("does not resurrect pending deliveries after subscription removal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-webhook-remove-"));
    const databasePath = join(directory, "reference.db");
    let resolveStarted!: () => void;
    let resolveFetch!: (response: Response) => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const blockingFetch: typeof fetch = async () => {
      resolveStarted();
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    };

    try {
      const outbox = await WebhookOutboxJournal.create({
        store: new AsyncSqliteStateStore<WebhookOutboxState>({
          path: databasePath,
          key: "webhook-outbox"
        })
      });
      const dispatcher = await WebhookDispatcher.create({
        subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
        outbox,
        fetch: blockingFetch,
        maxAttempts: 1
      });
      const [subscription] = dispatcher.listSubscriptions();
      expect(subscription).toBeDefined();

      dispatcher.emit(makeEvent());
      await fetchStarted;
      expect(dispatcher.removeSubscription(subscription!.subscription_id)).toBe(true);
      resolveFetch(new Response(null, { status: 500 }));
      await dispatcher.flush();

      expect(dispatcher.pendingDeliveries()).toEqual([]);
      expect(await outbox.list()).toEqual([]);
      await outbox.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves pending deliveries when subscription delivery is paused", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-webhook-pause-"));
    const databasePath = join(directory, "reference.db");
    let resolveStarted!: () => void;
    let resolveFetch!: (response: Response) => void;
    let attempts = 0;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const pausingFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        resolveStarted();
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      }
      return new Response(null, { status: 204 });
    };

    try {
      const outbox = await WebhookOutboxJournal.create({
        store: new AsyncSqliteStateStore<WebhookOutboxState>({
          path: databasePath,
          key: "webhook-outbox"
        })
      });
      const dispatcher = await WebhookDispatcher.create({
        subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret-value" }],
        outbox,
        fetch: pausingFetch,
        maxAttempts: 2,
        backoffMs: 1
      });
      const [subscription] = dispatcher.listSubscriptions();
      expect(subscription).toBeDefined();

      dispatcher.emit(makeEvent());
      await fetchStarted;
      dispatcher.upsertSubscription({
        subscription_id: subscription!.subscription_id,
        url: subscription!.url,
        secret: "hook-secret-value",
        active: false
      });
      resolveFetch(new Response(null, { status: 500 }));
      await dispatcher.flush();

      const [pending] = dispatcher.pendingDeliveries();
      expect(pending).toMatchObject({
        attempts: 1,
        last_error: "receiver responded with HTTP 500"
      });
      expect(await outbox.list()).toEqual([
        expect.objectContaining({
          delivery_id: pending!.delivery_id,
          attempts: 1,
          last_error: "receiver responded with HTTP 500"
        })
      ]);

      dispatcher.upsertSubscription({
        subscription_id: subscription!.subscription_id,
        url: subscription!.url,
        secret: "hook-secret-value",
        active: true
      });
      dispatcher.resumePending();
      await dispatcher.flush();

      expect(attempts).toBe(2);
      expect(dispatcher.pendingDeliveries()).toEqual([]);
      expect(await outbox.list()).toEqual([]);
      await outbox.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists completed delivery history and replays archived events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-webhook-history-"));
    const databasePath = join(directory, "reference.db");
    const captured: CapturedRequest[] = [];
    try {
      const firstStore = new WebhookHistoryJournal({
        store: new AsyncSqliteStateStore<WebhookHistoryState>({
          path: databasePath,
          key: "webhook-history"
        })
      });
      const first = await WebhookDispatcher.create({
        subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
        fetch: capturingFetch(captured, [204]),
        historyStore: firstStore
      });
      first.emit(makeEvent());
      await first.flush();
      const deliveryId = first.deliveries()[0]!.delivery_id;
      await firstStore.close();

      const secondStore = new WebhookHistoryJournal({
        store: new AsyncSqliteStateStore<WebhookHistoryState>({
          path: databasePath,
          key: "webhook-history"
        })
      });
      const second = await WebhookDispatcher.create({
        subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
        fetch: capturingFetch(captured, [204]),
        historyStore: secondStore
      });
      expect(second.deliveries()).toEqual([
        expect.objectContaining({ delivery_id: deliveryId, status: "delivered" })
      ]);
      expect(second.replayDelivery(deliveryId)).toBe(true);
      await second.flush();
      expect(captured).toHaveLength(2);
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("respects per-subscription event-type filters", async () => {
    const captured: CapturedRequest[] = [];
    const dispatcher = await WebhookDispatcher.create({
      subscriptions: [
        {
          url: "https://receiver.example/redemptions",
          secret: "hook-secret",
          events: ["org.loyalty-interchange.redemption.captured.v1"]
        }
      ],
      fetch: capturingFetch(captured)
    });
    dispatcher.emit(makeEvent());
    await dispatcher.flush();
    expect(captured).toHaveLength(0);
  });

  it("persists failed deliveries and resumes them after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-webhook-outbox-"));
    const databasePath = join(directory, "reference.db");
    const outboxKey = "demo-foodservice:webhook-outbox";
    try {
      const firstAttempts: CapturedRequest[] = [];
      const firstOutbox = await WebhookOutboxJournal.create({ store: new AsyncSqliteStateStore<WebhookOutboxState>({ path: databasePath, key: outboxKey }) });
      const first = await WebhookDispatcher.create({
        subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
        outbox: firstOutbox,
        fetch: capturingFetch(firstAttempts, [503]),
        maxAttempts: 1
      });
      first.emit(makeEvent());
      await first.flush();

      expect(firstAttempts).toHaveLength(1);
      expect(first.pendingDeliveries()).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ id: "evt-test-001" }),
          attempts: 1,
          last_error: "receiver responded with HTTP 503"
        })
      ]);
      await firstOutbox.close();

      const resumedAttempts: CapturedRequest[] = [];
      const secondOutbox = await WebhookOutboxJournal.create({ store: new AsyncSqliteStateStore<WebhookOutboxState>({ path: databasePath, key: outboxKey }) });
      const second = await WebhookDispatcher.create({
        subscriptions: [{ url: "https://receiver.example/hooks", secret: "hook-secret" }],
        outbox: secondOutbox,
        fetch: capturingFetch(resumedAttempts),
        maxAttempts: 1
      });
      second.resumePending();
      await second.flush();

      expect(resumedAttempts).toHaveLength(1);
      expect(second.pendingDeliveries()).toEqual([]);
      expect(second.deliveries()).toEqual([
        expect.objectContaining({
          event_id: "evt-test-001",
          status: "delivered",
          attempts: 2
        })
      ]);
      expect(await secondOutbox.list()).toEqual([]);
      await secondOutbox.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("EventedLoyaltyEngine", () => {
  it("emits schema-valid events across the loyalty lifecycle", () => {
    const emitted: LoyaltyEvent[] = [];
    const engine = eventedEngine(emitted);

    engine.enroll(makeEnroll());
    engine.postAccrual({
      context: makeContext("webhook-accrual-key"),
      member_id: "member-001",
      order: makeOrder()
    });
    const reserved = engine.reserve({
      context: makeContext("webhook-reserve-key"),
      redemption_id: "redemption-001",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      order: makeOrder({ order_id: "order-redemption" })
    });
    engine.capture({
      context: makeContext("webhook-capture-key"),
      reservation_id: reserved.reservation.reservation_id,
      order_id: "order-redemption"
    });
    engine.postManualAdjustment({
      context: makeContext("webhook-manual-key"),
      member_id: "member-001",
      program_id: "demo-foodservice",
      adjustment_id: "webhook-manual-001",
      amount: 10,
      classification: "bonus",
      reason: "Birthday bonus",
      qualifies_for_tier: false
    });
    engine.issueReward({
      context: makeContext("webhook-issued-reward"),
      issued_reward_id: "issued-webhook-001",
      member_id: "member-001",
      program_id: "demo-foodservice",
      reward_id: "one-dollar-off"
    });
    const issuedReservation = engine.reserve({
      context: makeContext("webhook-issued-reserve"),
      redemption_id: "redemption-issued-001",
      member_id: "member-001",
      reward_id: "one-dollar-off",
      issued_reward_id: "issued-webhook-001",
      order: makeOrder({ order_id: "order-issued-redemption" })
    });
    engine.capture({
      context: makeContext("webhook-issued-capture"),
      reservation_id: issuedReservation.reservation.reservation_id,
      order_id: "order-issued-redemption"
    });
    engine.reverse({
      context: makeContext("webhook-issued-reverse"),
      reservation_id: issuedReservation.reservation.reservation_id,
      reason: "Order voided"
    });
    engine.issueReward({
      context: makeContext("webhook-issued-cancel"),
      issued_reward_id: "issued-webhook-002",
      member_id: "member-001",
      program_id: "demo-foodservice",
      reward_id: "one-dollar-off"
    });
    engine.cancelIssuedReward({
      context: makeContext("webhook-cancel-reward"),
      issued_reward_id: "issued-webhook-002",
      reason: "Campaign cancelled"
    });

    expect(emitted.map((event) => event.type)).toEqual([
      "org.loyalty-interchange.member.enrolled.v1",
      "org.loyalty-interchange.order.accrued.v1",
      "org.loyalty-interchange.redemption.reserved.v1",
      "org.loyalty-interchange.redemption.captured.v1",
      "org.loyalty-interchange.balance.changed.v1",
      "org.loyalty-interchange.issued-reward.issued.v1",
      "org.loyalty-interchange.redemption.reserved.v1",
      "org.loyalty-interchange.redemption.captured.v1",
      "org.loyalty-interchange.issued-reward.redeemed.v1",
      "org.loyalty-interchange.redemption.reversed.v1",
      "org.loyalty-interchange.issued-reward.restored.v1",
      "org.loyalty-interchange.issued-reward.issued.v1",
      "org.loyalty-interchange.issued-reward.cancelled.v1"
    ]);
    for (const event of emitted) {
      const result = validate(LoyaltyEventSchema, event);
      expect(result.ok, JSON.stringify("issues" in result ? result.issues : [])).toBe(true);
      expect(event.source).toBe("urn:lip:program:demo-foodservice");
      expect(event.subject).toBe("member-001");
    }
  });

  it("derives event ids from resource ids so idempotent replays stay deduplicable", () => {
    const emitted: LoyaltyEvent[] = [];
    const engine = eventedEngine(emitted);
    engine.enroll(makeEnroll());

    const request = {
      context: makeContext("webhook-replay-key"),
      member_id: "member-001",
      order: makeOrder()
    };
    engine.postAccrual(request);
    engine.postAccrual({
      ...request,
      context: { ...request.context, request_id: "webhook-replay-request-2" }
    });

    const accrualEvents = emitted.filter(
      (event) => event.type === "org.loyalty-interchange.order.accrued.v1"
    );
    expect(accrualEvents).toHaveLength(2);
    expect(accrualEvents[0]!.id).toBe(accrualEvents[1]!.id);
  });
});

describe("platform webhook wiring", () => {
  it("parses subscriptions from the environment", () => {
    expect(webhookSubscriptionsFromEnv({})).toEqual([]);
    expect(
      webhookSubscriptionsFromEnv({
        LIP_WEBHOOK_URL: "https://receiver.example/hooks",
        LIP_WEBHOOK_SECRET: "hook-secret-16-chars",
        LIP_WEBHOOK_EVENTS: "org.loyalty-interchange.order.accrued.v1, org.loyalty-interchange.redemption.captured.v1"
      })
    ).toEqual([
      {
        url: "https://receiver.example/hooks",
        secret: "hook-secret-16-chars",
        events: [
          "org.loyalty-interchange.order.accrued.v1",
          "org.loyalty-interchange.redemption.captured.v1"
        ]
      }
    ]);
    expect(() => webhookSubscriptionsFromEnv({ LIP_WEBHOOK_URL: "https://x.example" })).toThrowError(
      /LIP_WEBHOOK_SECRET/
    );
    expect(() => webhookSubscriptionsFromEnv({
      LIP_WEBHOOK_URL: "https://x.example",
      LIP_WEBHOOK_SECRET: "short"
    })).toThrowError(/at least 16 characters/);
  });

  it("delivers signed events from a live platform to an HTTP receiver", async () => {
    const received: Array<{ timestamp: string; signature: string; body: string }> = [];
    const receiver = await startReceiver(received);
    const directory = mkdtempSync(join(tmpdir(), "lip-webhooks-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false,
      webhooks: [{ url: receiverUrl(receiver), secret: "platform-secret" }]
    });
    try {
      platform.engine.enroll(makeEnroll("platform-webhook-enroll-key"));
      await platform.webhooks!.flush();

      expect(received).toHaveLength(1);
      await expect(
        verifyWebhook({
          payload: received[0]!.body,
          secret: "platform-secret",
          timestamp: received[0]!.timestamp,
          signature: received[0]!.signature
        })
      ).resolves.toBeUndefined();
      const event = JSON.parse(received[0]!.body) as LoyaltyEvent;
      expect(event.type).toBe("org.loyalty-interchange.member.enrolled.v1");
      expect(validate(LoyaltyEventSchema, event).ok).toBe(true);
    } finally {
      await platform.close();
      receiver.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists runtime subscription CRUD and secret rotation across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-webhook-subscriptions-"));
    const databasePath = join(directory, "reference.db");
    try {
      const first = await createDemoPlatform({ databasePath, reset: true, seed: false });
      expect(first.webhooks.listSubscriptions()).toEqual([]);
      const created = first.webhooks.upsertSubscription({
        url: "https://receiver.example/hooks",
        secret: "initial-secret-value"
      });
      expect(created).toMatchObject({ active: true, url: "https://receiver.example/hooks" });
      await first.close();

      const second = await createDemoPlatform({ databasePath, seed: false });
      expect(second.webhooks.listSubscriptions()).toEqual([
        expect.objectContaining({ subscription_id: created.subscription_id })
      ]);
      second.webhooks.rotateSecret(created.subscription_id, "rotated-secret-value");
      expect(second.webhooks.removeSubscription(created.subscription_id)).toBe(true);
      await second.close();

      const third = await createDemoPlatform({ databasePath, seed: false });
      expect(third.webhooks.listSubscriptions()).toEqual([]);
      await third.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function startReceiver(
  received: Array<{ timestamp: string; signature: string; body: string }>
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        received.push({
          timestamp: String(request.headers["lip-webhook-timestamp"] ?? ""),
          signature: String(request.headers["lip-webhook-signature"] ?? ""),
          body
        });
        response.writeHead(204).end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function receiverUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/hooks`;
}
