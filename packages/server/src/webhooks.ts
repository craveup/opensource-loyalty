import { createHash, createHmac, randomUUID } from "node:crypto";
import type { LoyaltyEvent, LoyaltyEventType } from "@loyalty-interchange/protocol";

export interface WebhookSubscription {
  subscription_id?: string;
  url: string;
  secret: string;
  /** Optional allowlist of event types. All events are delivered when omitted. */
  events?: readonly LoyaltyEventType[];
  active?: boolean;
  retry_policy?: {
    max_attempts: number;
    backoff_ms: number;
    timeout_ms: number;
  };
}

export interface ManagedWebhookSubscription extends WebhookSubscription {
  subscription_id: string;
  active: boolean;
}

export interface WebhookDeliveryRecord {
  delivery_id: string;
  event_id: string;
  event_type: LoyaltyEventType;
  url: string;
  attempts: number;
  status: "delivered" | "failed";
  completed_at: string;
  last_error?: string;
}

export interface WebhookDeliveryArchiveEntry extends WebhookDeliveryRecord {
  event: LoyaltyEvent;
}

export interface WebhookHistoryStore {
  list(): Promise<WebhookDeliveryArchiveEntry[]>;
  save(entries: readonly WebhookDeliveryArchiveEntry[]): Promise<void>;
}

export interface WebhookOutboxEntry {
  delivery_id: string;
  event: LoyaltyEvent;
  url: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error?: string;
}

export interface WebhookOutboxStore {
  list(): Promise<WebhookOutboxEntry[]>;
  put(entry: WebhookOutboxEntry): Promise<void>;
  remove(deliveryId: string): Promise<void>;
}

export interface WebhookSubscriptionSummary {
  subscription_id: string;
  url: string;
  active: boolean;
  events?: readonly LoyaltyEventType[];
  retry_policy?: WebhookSubscription["retry_policy"];
}

export interface WebhookAdminStatus {
  enabled: boolean;
  subscriptions?: WebhookSubscriptionSummary[];
  pending: Array<{
    delivery_id: string;
    event_id: string;
    event_type: LoyaltyEventType;
    url: string;
    attempts: number;
    created_at: string;
    updated_at: string;
    last_error?: string;
  }>;
  recent: WebhookDeliveryRecord[];
}

export interface WebhookDeliveryHealth {
  enabled: boolean;
  subscription_count: number;
  pending_count: number;
  recent_total: number;
  recent_succeeded: number;
  recent_failed: number;
  success_rate: number | null;
  healthy: boolean;
  checked_at: string;
}

export interface WebhookDispatcherOptions {
  subscriptions: readonly WebhookSubscription[];
  /** Total attempts per delivery including the first one. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay between attempts; doubles per retry. Defaults to 250ms. */
  backoffMs?: number;
  /** Per-request timeout. Defaults to 5000ms. */
  timeoutMs?: number;
  /** How many completed delivery records to retain. Defaults to 200. */
  historyLimit?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  onError?: (message: string) => void;
  onSubscriptionsChanged?: (subscriptions: readonly ManagedWebhookSubscription[]) => void | Promise<void>;
  /**
   * Durable storage for pending deliveries. Failed deliveries remain in the
   * outbox and are retried when `resumePending()` is called after restart.
   */
  outbox?: WebhookOutboxStore;
  historyStore?: WebhookHistoryStore;
}

/**
 * Computes the `LIP-Webhook-Signature` value for a payload per spec/webhooks.md:
 * unpadded base64url of HMAC-SHA256(secret, `${timestamp}.${body}`).
 */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
  return `v1=${digest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deliveryId(event: LoyaltyEvent, url: string): string {
  return createHash("sha256")
    .update(`${event.source}\0${event.id}\0${url}`)
    .digest("hex");
}

class MemoryWebhookOutbox implements WebhookOutboxStore {
  private readonly entries = new Map<string, WebhookOutboxEntry>();

  public async list(): Promise<WebhookOutboxEntry[]> {
    return [...this.entries.values()];
  }

  public async put(entry: WebhookOutboxEntry): Promise<void> {
    this.entries.set(entry.delivery_id, entry);
  }

  public async remove(deliveryIdValue: string): Promise<void> {
    this.entries.delete(deliveryIdValue);
  }
}

/**
 * Delivers CloudEvents to webhook subscribers with the normative LIP signature
 * headers, bounded retry cycles, a durable outbox, and an inspectable delivery
 * history. Deliveries are fire-and-forget from the caller's perspective; use
 * `flush()` to await the current retry cycle (for tests and graceful shutdown).
 */
export class WebhookDispatcher {
  private subscriptions: ManagedWebhookSubscription[];
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly historyLimit: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly onError: ((message: string) => void) | undefined;
  private readonly onSubscriptionsChanged:
    ((subscriptions: readonly ManagedWebhookSubscription[]) => void) | undefined;
  private readonly outbox: WebhookOutboxStore;
  private readonly historyStore: WebhookHistoryStore | undefined;
  private readonly queued = new Map<string, WebhookOutboxEntry>();
  private readonly history: WebhookDeliveryArchiveEntry[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private persistTail: Promise<void> = Promise.resolve();

  private constructor(options: WebhookDispatcherOptions) {
    this.subscriptions = options.subscriptions.map((subscription) => ({
      ...subscription,
      subscription_id: subscription.subscription_id ?? `webhook_${deliveryId({
        source: "subscription",
        id: subscription.url
      } as LoyaltyEvent, subscription.url).slice(0, 20)}`,
      active: subscription.active ?? true
    }));
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.historyLimit = options.historyLimit ?? 200;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
    this.onSubscriptionsChanged = options.onSubscriptionsChanged;
    this.outbox = options.outbox ?? new MemoryWebhookOutbox();
    this.historyStore = options.historyStore;
  }

  public static async create(options: WebhookDispatcherOptions): Promise<WebhookDispatcher> {
    const dispatcher = new WebhookDispatcher(options);
    dispatcher.history.push(
      ...(await dispatcher.historyStore?.list() ?? []).slice(-dispatcher.historyLimit)
    );
    for (const entry of await dispatcher.outbox.list()) {
      dispatcher.queued.set(entry.delivery_id, entry);
    }
    dispatcher.persistSubscriptions();
    return dispatcher;
  }

  /**
   * Serializes durable writes in call order so the sync emit path can enqueue
   * persistence without awaiting; failures surface through onError instead of
   * breaking delivery.
   */
  private persist(operation: () => Promise<void>): void {
    this.persistTail = this.persistTail
      .then(operation)
      .catch((error: unknown) => {
        this.onError?.(
          `webhook persistence failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  public emit(event: LoyaltyEvent): void {
    for (const subscription of this.subscriptions) {
      if (!subscription.active) continue;
      if (subscription.events && !subscription.events.includes(event.type)) continue;
      const id = deliveryId(event, subscription.url);
      const existing = this.queued.get(id);
      const timestamp = this.now().toISOString();
      const entry: WebhookOutboxEntry = existing ?? {
        delivery_id: id,
        event,
        url: subscription.url,
        attempts: 0,
        created_at: timestamp,
        updated_at: timestamp
      };
      this.queued.set(id, entry);
      this.persist(() => this.outbox.put(entry));
      this.schedule(entry, subscription);
    }
  }

  /**
   * Retries every persisted delivery whose subscription is still configured.
   * Call once after platform startup.
   */
  public resumePending(): void {
    for (const entry of this.queued.values()) {
      const subscription = this.subscriptions.find((candidate) =>
        candidate.url === entry.url && candidate.active
      );
      if (!subscription) {
        this.onError?.(`webhook delivery ${entry.delivery_id} has no configured subscription for ${entry.url}`);
        continue;
      }
      this.schedule(entry, subscription);
    }
  }

  /**
   * Waits until every in-flight delivery has completed its current retry cycle
   * and every enqueued durable write has been persisted.
   */
  public async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending.values()]);
    }
    await this.persistTail;
  }

  /** Persisted deliveries still awaiting a successful 2xx response. */
  public pendingDeliveries(): WebhookOutboxEntry[] {
    return [...this.queued.values()];
  }

  public inFlightDeliveries(): number {
    return this.pending.size;
  }

  public adminStatus(): WebhookAdminStatus {
    return {
      enabled: this.subscriptions.some((subscription) => subscription.active),
      subscriptions: this.listSubscriptions(),
      pending: [...this.queued.values()].map((entry) => ({
        delivery_id: entry.delivery_id,
        event_id: entry.event.id,
        event_type: entry.event.type,
        url: entry.url,
        attempts: entry.attempts,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        ...(entry.last_error ? { last_error: entry.last_error } : {})
      })),
      recent: this.deliveries()
    };
  }

  /**
   * Secret-free cutover/ops probe: recent delivery success vs failure plus
   * pending backlog. `healthy` is true when webhooks are enabled, the outbox
   * is empty, and every retained recent delivery succeeded (or there is no
   * recent history yet).
   */
  public deliveryHealth(now: () => Date = () => new Date()): WebhookDeliveryHealth {
    const recent = this.deliveries();
    const recentSucceeded = recent.filter((entry) => entry.status === "delivered").length;
    const recentFailed = recent.filter((entry) => entry.status === "failed").length
    const pendingCount = this.queued.size;
    const enabled = this.subscriptions.some((subscription) => subscription.active);
    const recentTotal = recent.length;
    const successRate = recentTotal === 0 ? null : recentSucceeded / recentTotal;
    return {
      enabled,
      subscription_count: this.subscriptions.filter((subscription) => subscription.active).length,
      pending_count: pendingCount,
      recent_total: recentTotal,
      recent_succeeded: recentSucceeded,
      recent_failed: recentFailed,
      success_rate: successRate,
      healthy: enabled && pendingCount === 0 && recentFailed === 0,
      checked_at: now().toISOString()
    };
  }

  /** Completed delivery records, oldest first. */
  public deliveries(): WebhookDeliveryRecord[] {
    return this.history.map(({ event: _event, ...record }) => structuredClone(record));
  }

  public listSubscriptions(): WebhookSubscriptionSummary[] {
    return this.subscriptions.map(({ secret: _secret, ...subscription }) => ({
      subscription_id: subscription.subscription_id,
      url: subscription.url,
      active: subscription.active,
      ...(subscription.events ? { events: [...subscription.events] } : {}),
      ...(subscription.retry_policy
        ? { retry_policy: structuredClone(subscription.retry_policy) }
        : {})
    }));
  }

  public upsertSubscription(input: WebhookSubscription): WebhookSubscriptionSummary {
    const parsed = new URL(input.url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Webhook URL must be an HTTP(S) URL without embedded credentials");
    }
    if (input.secret.length < 16) throw new Error("Webhook secret must contain at least 16 characters");
    const subscription: ManagedWebhookSubscription = {
      subscription_id: input.subscription_id ?? `webhook_${randomUUID()}`,
      url: parsed.toString(),
      secret: input.secret,
      active: input.active ?? true,
      ...(input.events ? { events: [...new Set(input.events)] } : {}),
      ...(input.retry_policy ? { retry_policy: structuredClone(input.retry_policy) } : {})
    };
    if (
      subscription.retry_policy &&
      (!Number.isInteger(subscription.retry_policy.max_attempts) ||
        subscription.retry_policy.max_attempts < 1 ||
        subscription.retry_policy.max_attempts > 10 ||
        !Number.isInteger(subscription.retry_policy.backoff_ms) ||
        subscription.retry_policy.backoff_ms < 0 ||
        !Number.isInteger(subscription.retry_policy.timeout_ms) ||
        subscription.retry_policy.timeout_ms < 100)
    ) {
      throw new Error("Webhook retry policy is invalid");
    }
    const index = this.subscriptions.findIndex((candidate) =>
      candidate.subscription_id === subscription.subscription_id
    );
    if (index >= 0) this.subscriptions[index] = subscription;
    else this.subscriptions.push(subscription);
    this.persistSubscriptions();
    return this.listSubscriptions().find((candidate) =>
      candidate.subscription_id === subscription.subscription_id
    )!;
  }

  public removeSubscription(subscriptionId: string): boolean {
    const subscription = this.subscriptions.find((candidate) =>
      candidate.subscription_id === subscriptionId
    );
    if (!subscription) return false;
    this.subscriptions = this.subscriptions.filter((candidate) =>
      candidate.subscription_id !== subscriptionId
    );
    for (const entry of this.queued.values()) {
      if (entry.url !== subscription.url) continue;
      this.queued.delete(entry.delivery_id);
      const removedId = entry.delivery_id;
      this.persist(() => this.outbox.remove(removedId));
    }
    this.persistSubscriptions();
    return true;
  }

  public rotateSecret(subscriptionId: string, secret: string): void {
    const subscription = this.subscriptions.find((candidate) =>
      candidate.subscription_id === subscriptionId
    );
    if (!subscription) throw new Error("Webhook subscription was not found");
    this.upsertSubscription({ ...subscription, secret });
  }

  public retryDelivery(deliveryIdValue: string): boolean {
    const entry = this.queued.get(deliveryIdValue);
    if (!entry) return false;
    const subscription = this.subscriptions.find((candidate) =>
      candidate.url === entry.url && candidate.active
    );
    if (!subscription) return false;
    this.schedule(entry, subscription);
    return true;
  }

  public replayDelivery(deliveryIdValue: string): boolean {
    const archived = [...this.history].reverse().find((entry) =>
      entry.delivery_id === deliveryIdValue
    );
    if (!archived) return false;
    const subscription = this.subscriptions.find((candidate) =>
      candidate.url === archived.url && candidate.active
    );
    if (!subscription) return false;
    const timestamp = this.now().toISOString();
    const entry: WebhookOutboxEntry = {
      delivery_id: deliveryId(archived.event, archived.url),
      event: structuredClone(archived.event),
      url: archived.url,
      attempts: 0,
      created_at: timestamp,
      updated_at: timestamp
    };
    this.queued.set(entry.delivery_id, entry);
    this.persist(() => this.outbox.put(entry));
    this.schedule(entry, subscription);
    return true;
  }

  private record(record: WebhookDeliveryArchiveEntry): void {
    this.history.push(record);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    if (!this.historyStore) return;
    const historyStore = this.historyStore;
    const snapshot = structuredClone(this.history);
    this.persist(() => historyStore.save(snapshot));
  }

  private persistSubscriptions(): void {
    if (!this.onSubscriptionsChanged) return;
    const snapshot = structuredClone(this.subscriptions);
    this.persist(async () => {
      await this.onSubscriptionsChanged?.(snapshot);
    });
  }

  private schedule(entry: WebhookOutboxEntry, subscription: ManagedWebhookSubscription): void {
    if (this.pending.has(entry.delivery_id)) return;
    const delivery = this.deliver(subscription, entry).catch((error: unknown) => {
      this.onError?.(`webhook delivery crashed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.pending.set(entry.delivery_id, delivery);
    void delivery.finally(() => this.pending.delete(entry.delivery_id));
  }

  private subscriptionDeliveryState(
    subscription: ManagedWebhookSubscription
  ): "active" | "paused" | "removed" {
    const configured = this.subscriptions.find((candidate) =>
      candidate.subscription_id === subscription.subscription_id &&
      candidate.url === subscription.url
    );
    if (!configured) return "removed";
    return configured.active ? "active" : "paused";
  }

  private async deliver(
    subscription: ManagedWebhookSubscription,
    entry: WebhookOutboxEntry
  ): Promise<void> {
    const body = JSON.stringify(entry.event);
    const maxAttempts = subscription.retry_policy?.max_attempts ?? this.maxAttempts;
    const backoffMs = subscription.retry_policy?.backoff_ms ?? this.backoffMs;
    const timeoutMs = subscription.retry_policy?.timeout_ms ?? this.timeoutMs;
    let lastError = "delivery was not attempted";
    let current = entry;
    // Each attempt replaces the queued entry with a fresh snapshot; the
    // snapshot handed to persist() is never mutated afterwards, so what lands
    // in the outbox is the state at enqueue time.
    const advance = (next: WebhookOutboxEntry): "active" | "paused" | "removed" => {
      const state = this.subscriptionDeliveryState(subscription);
      if (state === "removed") {
        return "removed";
      }
      current = next;
      this.queued.set(next.delivery_id, next);
      this.persist(() => this.outbox.put(next));
      return state;
    };
    for (let cycleAttempt = 1; cycleAttempt <= maxAttempts; cycleAttempt += 1) {
      if (cycleAttempt > 1) await sleep(backoffMs * 2 ** (cycleAttempt - 2));
      if (this.subscriptionDeliveryState(subscription) !== "active") return;
      const { last_error: _cleared, ...rest } = current;
      if (advance({
        ...rest,
        attempts: current.attempts + 1,
        updated_at: this.now().toISOString()
      }) !== "active") return;
      const timestamp = Math.floor(this.now().getTime() / 1000);
      try {
        const response = await this.fetchImpl(subscription.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "lip-webhook-timestamp": `${timestamp}`,
            "lip-webhook-signature": signWebhookPayload(subscription.secret, timestamp, body)
          },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.ok) {
          this.queued.delete(current.delivery_id);
          const deliveredId = current.delivery_id;
          this.persist(() => this.outbox.remove(deliveredId));
          this.record({
            delivery_id: current.delivery_id,
            event: structuredClone(current.event),
            event_id: current.event.id,
            event_type: current.event.type,
            url: subscription.url,
            attempts: current.attempts,
            status: "delivered",
            completed_at: this.now().toISOString()
          });
          return;
        }
        lastError = `receiver responded with HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (advance({
        ...current,
        last_error: lastError,
        updated_at: this.now().toISOString()
      }) !== "active") return;
    }
    this.record({
      delivery_id: current.delivery_id,
      event: structuredClone(current.event),
      event_id: current.event.id,
      event_type: current.event.type,
      url: subscription.url,
      attempts: current.attempts,
      status: "failed",
      completed_at: this.now().toISOString(),
      last_error: lastError
    });
    this.onError?.(
      `webhook delivery to ${subscription.url} failed after ${maxAttempts} attempts: ${lastError}`
    );
  }
}
