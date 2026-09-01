import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { LoyaltyEvent, LoyaltyEventType } from "@loyalty-interchange/protocol";
import {
  LoyaltyEngine,
  programDefinitionFingerprint,
  retargetProgramState,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";
import { AsyncSqliteStateStore, SqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import {
  PostgresEngineRepository,
  PostgresJsonStateStore,
  assertSessionLeaseCompatibleUrl,
  createPostgresPool
} from "@loyalty-interchange/storage-postgres";
import { createDemoProgram, seedDemoData, seedDemoLocations } from "./demo.js";
import { CampaignService, type CampaignState } from "./campaigns.js";
import { CustomerDataService, type CustomerDataState } from "./customer-data.js";
import { MembershipService, type MembershipAuditState } from "./memberships.js";
import { AccessControlService, type AccessControlState } from "./access-control.js";
import { EventedLoyaltyEngine } from "./evented-engine.js";
import { EngagementService, type EngagementState } from "./engagement.js";
import { LocationDirectoryService, type LocationDirectoryState } from "./locations.js";
import { ProgramManagementService, type ProgramManagementState } from "./program-management.js";
import { TelemetryService, type TelemetryState } from "./telemetry.js";
import { WebhookOutboxJournal, type WebhookOutboxState } from "./webhook-outbox.js";
import { WebhookHistoryJournal, type WebhookHistoryState } from "./webhook-history.js";
import { WebhookSubscriptionJournal, type WebhookSubscriptionState } from "./webhook-subscriptions.js";
import { WebhookDispatcher, type WebhookSubscription } from "./webhooks.js";

export interface DemoPlatformOptions {
  databasePath: string;
  reset?: boolean;
  seed?: boolean;
  adminAssetRoot?: string;
  /**
   * Custom program definition. When provided it replaces the built-in demo
   * program and demo seeding is skipped, because the synthetic members and
   * activity are only valid against the demo program.
   */
  program?: ProgramDefinition;
  /**
   * Webhook subscriptions to deliver CloudEvents to. When omitted, a single
   * subscription is read from LIP_WEBHOOK_URL / LIP_WEBHOOK_SECRET (and
   * optionally LIP_WEBHOOK_EVENTS, a comma-separated event-type allowlist).
   */
  webhooks?: WebhookSubscription[];
  /** Development-only opt-in for loopback/private webhook receivers. */
  allowPrivateWebhookNetworks?: boolean;
  telemetry?: {
    enabled?: boolean;
    endpoint?: string;
    fetchImpl?: typeof fetch;
  };
}

export interface DemoPlatform {
  engine: LoyaltyEngine;
  store: SqliteStateStore<LoyaltyEngineState>;
  adminAssetRoot?: string;
  webhooks: WebhookDispatcher;
  programs: ProgramManagementService;
  campaigns: CampaignService;
  customerData: CustomerDataService;
  memberships: MembershipService;
  access: AccessControlService;
  engagement: EngagementService;
  locations: LocationDirectoryService;
  telemetry: TelemetryService;
  close(): Promise<void>;
}

export interface PostgresProtocolPlatform {
  engine: LoyaltyEngine;
  store: PostgresEngineRepository;
  adminAssetRoot?: string;
  webhooks: WebhookDispatcher;
  programs: ProgramManagementService;
  campaigns: CampaignService;
  customerData: CustomerDataService;
  memberships: MembershipService;
  access: AccessControlService;
  engagement: EngagementService;
  locations: LocationDirectoryService;
  telemetry: TelemetryService;
  executeEngineOperation<T>(operation: () => T | Promise<T>): Promise<T>;
  /**
   * Runs a read-only computation against a scratch engine hydrated from the
   * latest committed state. Unlike executeEngineOperation this takes no
   * advisory lock, skips the in-process serialization queue, and never saves,
   * so it cannot stall concurrent accruals/redemptions. The snapshot may lag
   * in-flight mutations by one revision — acceptable for reporting.
   */
  readEngineSnapshot<T>(read: (engine: LoyaltyEngine) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresProtocolPlatformOptions {
  connectionString: string;
  /**
   * Shared pg pool. A managed deployment runs many tenant platforms in one
   * process against one database; without a shared pool each would open its own
   * and the process would exhaust the database's connection budget long before
   * it exhausts anything else. A supplied pool is not closed by close().
   */
  pool?: Pool;
  tenantId?: string;
  reset?: boolean;
  seed?: boolean;
  adminAssetRoot?: string;
  program?: ProgramDefinition;
  webhooks?: WebhookSubscription[];
  /** Development-only opt-in for loopback/private webhook receivers. */
  allowPrivateWebhookNetworks?: boolean;
  telemetry?: {
    enabled?: boolean;
    endpoint?: string;
    fetchImpl?: typeof fetch;
  };
}

export function webhookSubscriptionsFromEnv(
  env: Record<string, string | undefined> = process.env
): WebhookSubscription[] {
  const url = env["LIP_WEBHOOK_URL"];
  if (!url) return [];
  const secret = env["LIP_WEBHOOK_SECRET"];
  if (!secret) {
    throw new Error("LIP_WEBHOOK_SECRET is required when LIP_WEBHOOK_URL is set");
  }
  if (secret.length < 16) {
    throw new Error("LIP_WEBHOOK_SECRET must contain at least 16 characters");
  }
  const events = env["LIP_WEBHOOK_EVENTS"]
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) as LoyaltyEventType[] | undefined;
  return [{ url, secret, ...(events && events.length > 0 ? { events } : {}) }];
}

function discoverAdminAssetRoot(): string | undefined {
  const candidates = [
    fileURLToPath(new URL("./admin/", import.meta.url)),
    fileURLToPath(new URL("../dist/admin/", import.meta.url)),
    fileURLToPath(new URL("../../../apps/admin/dist/", import.meta.url))
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export async function createDemoPlatform(options: DemoPlatformOptions): Promise<DemoPlatform> {
  const configuredProgram = options.program ?? createDemoProgram();
  const programs = await ProgramManagementService.create({
    store: new AsyncSqliteStateStore<ProgramManagementState>({
      path: options.databasePath,
      key: "reference:program-management"
    }),
    initialProgram: configuredProgram,
    ...(options.reset ? { reset: true } : {})
  });
  const program = programs.activeProgram();
  const store = new SqliteStateStore<LoyaltyEngineState>({
    path: options.databasePath,
    key: program.program_id
  });
  let webhookOutbox: WebhookOutboxJournal | undefined;
  let webhookHistory: WebhookHistoryJournal | undefined;
  let webhookSubscriptionStore: WebhookSubscriptionJournal | undefined;
  let campaigns: CampaignService | undefined;
  let customerData: CustomerDataService | undefined;
  let memberships: MembershipService | undefined;
  let access: AccessControlService | undefined;
  let engagement: EngagementService | undefined;
  let locations: LocationDirectoryService | undefined;
  let telemetry: TelemetryService | undefined;
  try {
    if (options.reset) store.clear();
    let state = store.load();
    if (state && state.program_fingerprint !== programDefinitionFingerprint(program)) {
      const previousProgram = programs.programForFingerprint(state.program_fingerprint);
      if (previousProgram) {
        state = retargetProgramState(state, previousProgram, program);
        store.save(state);
      }
    }
    webhookSubscriptionStore = new WebhookSubscriptionJournal({
      store: new AsyncSqliteStateStore<WebhookSubscriptionState>({
        path: options.databasePath,
        key: `${program.program_id}:webhook-subscriptions`
      })
    });
    if (options.reset) await webhookSubscriptionStore.clear();
    const subscriptions =
      await webhookSubscriptionStore.load() ??
      options.webhooks ??
      webhookSubscriptionsFromEnv();
    webhookOutbox = await WebhookOutboxJournal.create({
      store: new AsyncSqliteStateStore<WebhookOutboxState>({
        path: options.databasePath,
        key: `${program.program_id}:webhook-outbox`
      })
    });
    if (options.reset) await webhookOutbox.clear();
    webhookHistory = new WebhookHistoryJournal({
      store: new AsyncSqliteStateStore<WebhookHistoryState>({
        path: options.databasePath,
        key: `${program.program_id}:webhook-history`
      })
    });
    if (options.reset) await webhookHistory.clear();
    const dispatcher = await WebhookDispatcher.create({
      subscriptions,
      ...(options.allowPrivateWebhookNetworks ? { allowPrivateNetworks: true } : {}),
      outbox: webhookOutbox,
      historyStore: webhookHistory,
      onSubscriptionsChanged: (next) => webhookSubscriptionStore!.save(next),
      onError: (message) => console.error(`[lip] ${message}`)
    });
    // Demo seeding replays synthetic history; suppress emissions until it is done.
    let armed = false;
    const engine = new EventedLoyaltyEngine(program, {
      ...(state ? { state } : {}),
      emit: (event) => {
        if (armed) dispatcher.emit(event);
      }
    });
    if (!state && options.seed !== false && !options.program) seedDemoData(engine);
    armed = true;
    customerData = await CustomerDataService.create({
      store: new AsyncSqliteStateStore<CustomerDataState>({
        path: options.databasePath,
        key: `${program.program_id}:customer-data`
      }),
      engine,
      persistEngine: (nextState) => store.save(nextState),
      ...(options.reset ? { reset: true } : {})
    });
    if (options.seed !== false && !options.program) {
      await customerData.seedProfilesFromEngine();
    }
    campaigns = await CampaignService.create({
      store: new AsyncSqliteStateStore<CampaignState>({
        path: options.databasePath,
        key: `${program.program_id}:campaigns`
      }),
      engine,
      persistEngine: (nextState) => store.save(nextState),
      customerFacts: (memberId) => customerData!.factsForMember(memberId),
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    memberships = await MembershipService.create({
      store: new AsyncSqliteStateStore<MembershipAuditState>({
        path: options.databasePath,
        key: `${program.program_id}:memberships`
      }),
      engine,
      persistEngine: (nextState) => store.save(nextState),
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    access = await AccessControlService.create({
      store: new AsyncSqliteStateStore<AccessControlState>({
        path: options.databasePath,
        key: `${program.program_id}:access-control`
      }),
      tenantId: program.program_id,
      tenantName: program.name ?? program.program_id,
      ...(options.reset ? { reset: true } : {})
    });
    engagement = await EngagementService.create({
      store: new AsyncSqliteStateStore<EngagementState>({
        path: options.databasePath,
        key: `${program.program_id}:engagement`
      }),
      engine,
      campaigns,
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    locations = await LocationDirectoryService.create({
      store: new AsyncSqliteStateStore<LocationDirectoryState>({
        path: options.databasePath,
        key: `${program.program_id}:locations`
      }),
      ...(options.reset ? { reset: true } : {})
    });
    telemetry = await TelemetryService.create({
      store: new AsyncSqliteStateStore<TelemetryState>({
        path: options.databasePath,
        key: `${program.program_id}:telemetry`
      }),
      storageDriver: "sqlite",
      features: ["admin", "campaigns", "customer-data", "platform-api", "wallet-bff"],
      ...options.telemetry,
      ...(options.reset ? { reset: true } : {})
    });
    if (options.seed !== false && !options.program) await seedDemoLocations(locations);
    programs.bindPublisher((nextProgram) => {
      const previousProgram = engine.getProgramDefinition();
      try {
        campaigns?.assertCompatibleProgram(nextProgram);
        memberships?.assertCompatibleProgram(
          nextProgram.membership_policy?.plans.map((plan) => plan.plan_id) ?? []
        );
        engine.reconfigureProgram(nextProgram);
        store.save(engine.exportState());
      } catch (error) {
        engine.reconfigureProgram(previousProgram);
        throw error;
      }
    });
    dispatcher.resumePending();
    store.save(engine.exportState());
    const adminAssetRoot = options.adminAssetRoot ?? discoverAdminAssetRoot();
    return {
      engine,
      store,
      ...(adminAssetRoot ? { adminAssetRoot } : {}),
      webhooks: dispatcher,
      programs,
      campaigns,
      customerData,
      memberships,
      access,
      engagement,
      locations,
      telemetry,
      close: async () => {
        await campaigns?.close();
        await customerData?.close();
        await memberships?.close();
        await access?.close();
        await engagement?.close();
        await locations?.close();
        await telemetry?.close();
        await programs.close();
        store.close();
        await webhookSubscriptionStore?.close();
        await webhookHistory?.close();
        if (!webhookOutbox) return;
        const outboxToClose = webhookOutbox;
        if (dispatcher.inFlightDeliveries() === 0) {
          await outboxToClose.close();
          return;
        }
        void dispatcher.flush().finally(() => {
          void outboxToClose.close();
        });
      }
    };
  } catch (error) {
    await webhookOutbox?.close();
    await webhookHistory?.close();
    await webhookSubscriptionStore?.close();
    await campaigns?.close();
    await customerData?.close();
    await memberships?.close();
    await access?.close();
    await engagement?.close();
    await locations?.close();
    await telemetry?.close();
    await programs.close();
    store.close();
    throw error;
  }
}

export async function createPostgresProtocolPlatform(
  options: PostgresProtocolPlatformOptions
): Promise<PostgresProtocolPlatform> {
  assertSessionLeaseCompatibleUrl(options.connectionString, "LIP_DATABASE_URL");
  const configuredProgram = options.program ?? createDemoProgram();
  const tenantId = options.tenantId ?? configuredProgram.program_id;
  const sharedPool = options.pool;
  const pool = sharedPool ?? createPostgresPool({ connectionString: options.connectionString });
  const stateStore = <T>(key: string): AsyncStateStore<T> =>
    new PostgresJsonStateStore<T>({ pool, tenantId, key });

  let programs: ProgramManagementService | undefined;
  let store: PostgresEngineRepository | undefined;
  let subscriptionJournal: WebhookSubscriptionJournal | undefined;
  let outboxJournal: WebhookOutboxJournal | undefined;
  let historyJournal: WebhookHistoryJournal | undefined;
  let campaigns: CampaignService | undefined;
  let customerData: CustomerDataService | undefined;
  let memberships: MembershipService | undefined;
  let access: AccessControlService | undefined;
  let engagement: EngagementService | undefined;
  let locations: LocationDirectoryService | undefined;
  let telemetry: TelemetryService | undefined;
  let bootDispatcher: WebhookDispatcher | undefined;
  try {
    const migrator = new PostgresJsonStateStore({ pool, tenantId, key: "migration-probe" });
    await migrator.migrate();

    programs = await ProgramManagementService.create({
      store: stateStore<ProgramManagementState>("program-management"),
      initialProgram: configuredProgram,
      ...(options.reset ? { reset: true } : {})
    });
    const program = programs.activeProgram();
    store = new PostgresEngineRepository({
      pool,
      tenantId,
      programId: program.program_id
    });
    if (options.reset) await store.clear();
    let stored = await store.load();
    if (
      stored &&
      stored.state.program_fingerprint !== programDefinitionFingerprint(program)
    ) {
      const previousProgram = programs.programForFingerprint(stored.state.program_fingerprint);
      if (!previousProgram) {
        throw new Error(
          "Postgres engine state uses a different program definition; publish a compatible migration or reset explicitly"
        );
      }
      const retargeted = retargetProgramState(stored.state, previousProgram, program);
      const revision = await store.save(retargeted, stored.revision);
      stored = { state: retargeted, revision };
    }

    subscriptionJournal = new WebhookSubscriptionJournal({
      store: stateStore<WebhookSubscriptionState>("webhook-subscriptions")
    });
    if (options.reset) await subscriptionJournal.clear();
    const subscriptions =
      await subscriptionJournal.load() ??
      options.webhooks ??
      webhookSubscriptionsFromEnv();
    outboxJournal = await WebhookOutboxJournal.create({
      store: stateStore<WebhookOutboxState>("webhook-outbox")
    });
    if (options.reset) await outboxJournal.clear();
    historyJournal = new WebhookHistoryJournal({
      store: stateStore<WebhookHistoryState>("webhook-history")
    });
    if (options.reset) await historyJournal.clear();
    const journal = subscriptionJournal;
    const dispatcher = await WebhookDispatcher.create({
      subscriptions,
      ...(options.allowPrivateWebhookNetworks ? { allowPrivateNetworks: true } : {}),
      outbox: outboxJournal,
      historyStore: historyJournal,
      onSubscriptionsChanged: (next) => journal.save(next),
      onError: (message) => console.error(`[lip] ${message}`)
    });
    bootDispatcher = dispatcher;

    let armed = false;
    let transactionEvents: LoyaltyEvent[] | undefined;
    const engine = new EventedLoyaltyEngine(program, {
      ...(stored ? { state: stored.state } : {}),
      emit: (event) => {
        if (!armed) return;
        if (transactionEvents) transactionEvents.push(event);
        else dispatcher.emit(event);
      }
    });
    if (!stored && options.seed !== false && !options.program) seedDemoData(engine);
    armed = true;
    if (!stored) await store.save(engine.exportState(), 0);

    const engineStore = store;
    const executeEngineOperation = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      const committed = await engineStore.mutate(engine, async () => {
        const events: LoyaltyEvent[] = [];
        transactionEvents = events;
        try {
          return { result: await operation(), events };
        } finally {
          transactionEvents = undefined;
        }
      });
      for (const event of committed.events) dispatcher.emit(event);
      return committed.result;
    };
    // Engine snapshots are committed by store.mutate() inside
    // executeEngineOperation, so the services' direct persist hook is a no-op.
    const persistEngine = (): void => undefined;

    // True read path (lock-free reporting): load the latest committed state without the
    // per-tenant advisory lock or the mutation queue, hydrate a throwaway
    // engine, and run the read against it. Nothing is saved, so side effects
    // computed during the read (e.g. reservation expiry inside
    // inspectLedger()) stay in the scratch copy until a real write persists
    // them. The scratch engine is a plain LoyaltyEngine — it has no emit
    // hook, so no webhook events can ever fire from a read. Reads may lag
    // in-flight mutations by one revision (see docs/postgres.md).
    const boundPrograms = programs;
    const readEngineSnapshot = async <T>(
      read: (snapshot: LoyaltyEngine) => T | Promise<T>
    ): Promise<T> => {
      const current = await engineStore.load();
      const activeProgram = engine.getProgramDefinition();
      let snapshotState = current?.state;
      if (
        snapshotState &&
        snapshotState.program_fingerprint !== programDefinitionFingerprint(activeProgram)
      ) {
        // A program publish can race this read; retarget like boot does.
        const previousProgram = boundPrograms.programForFingerprint(
          snapshotState.program_fingerprint
        );
        if (!previousProgram) {
          throw new Error(
            "Stored engine state uses an unknown program definition; cannot serve a read snapshot"
          );
        }
        snapshotState = retargetProgramState(snapshotState, previousProgram, activeProgram);
      }
      const scratch = new LoyaltyEngine(
        activeProgram,
        snapshotState ? { state: snapshotState } : {}
      );
      return read(scratch);
    };

    customerData = await CustomerDataService.create({
      store: stateStore<CustomerDataState>("customer-data"),
      engine,
      persistEngine,
      executeEngineOperation,
      ...(options.reset ? { reset: true } : {})
    });
    if (options.seed !== false && !options.program) {
      await customerData.seedProfilesFromEngine();
    }
    campaigns = await CampaignService.create({
      store: stateStore<CampaignState>("campaigns"),
      engine,
      persistEngine,
      executeEngineOperation,
      customerFacts: (memberId) => customerData!.factsForMember(memberId),
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    memberships = await MembershipService.create({
      store: stateStore<MembershipAuditState>("memberships"),
      engine,
      persistEngine,
      executeEngineOperation,
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    access = await AccessControlService.create({
      store: stateStore<AccessControlState>("access-control"),
      tenantId,
      tenantName: program.name ?? tenantId,
      ...(options.reset ? { reset: true } : {})
    });
    engagement = await EngagementService.create({
      store: stateStore<EngagementState>("engagement"),
      engine,
      campaigns,
      schedulerIntervalMs: 30_000,
      ...(options.reset ? { reset: true } : {})
    });
    locations = await LocationDirectoryService.create({
      store: stateStore<LocationDirectoryState>("locations"),
      ...(options.reset ? { reset: true } : {})
    });
    telemetry = await TelemetryService.create({
      store: stateStore<TelemetryState>("telemetry"),
      storageDriver: "postgres",
      features: ["admin", "campaigns", "customer-data", "platform-api", "wallet-bff"],
      ...options.telemetry,
      ...(options.reset ? { reset: true } : {})
    });
    if (options.seed !== false && !options.program) await seedDemoLocations(locations);
    const boundCampaigns = campaigns;
    const boundMemberships = memberships;
    programs.bindPublisher(async (nextProgram) => {
      const previousProgram = engine.getProgramDefinition();
      try {
        await executeEngineOperation(() => {
          boundCampaigns.assertCompatibleProgram(nextProgram);
          boundMemberships.assertCompatibleProgram(
            nextProgram.membership_policy?.plans.map((plan) => plan.plan_id) ?? []
          );
          engine.reconfigureProgram(nextProgram);
        });
      } catch (error) {
        engine.reconfigureProgram(previousProgram);
        throw error;
      }
    });
    dispatcher.resumePending();

    const adminAssetRoot = options.adminAssetRoot ?? discoverAdminAssetRoot();
    return {
      engine,
      store,
      ...(adminAssetRoot ? { adminAssetRoot } : {}),
      webhooks: dispatcher,
      programs,
      campaigns,
      customerData,
      memberships,
      access,
      engagement,
      locations,
      telemetry,
      executeEngineOperation,
      readEngineSnapshot,
      close: async () => {
        await campaigns?.close();
        await customerData?.close();
        await memberships?.close();
        await access?.close();
        await engagement?.close();
        await locations?.close();
        await telemetry?.close();
        await programs?.close();
        await dispatcher.flush();
        await subscriptionJournal?.close();
        await historyJournal?.close();
        await outboxJournal?.close();
        await engineStore.close();
        if (!sharedPool) await pool.end();
      }
    };
  } catch (error) {
    await campaigns?.close();
    await customerData?.close();
    await memberships?.close();
    await access?.close();
    await engagement?.close();
    await locations?.close();
    await telemetry?.close();
    await programs?.close();
    await bootDispatcher?.flush();
    await subscriptionJournal?.close();
    await historyJournal?.close();
    await outboxJournal?.close();
    await store?.close();
    if (!sharedPool) await pool.end();
    throw error;
  }
}
