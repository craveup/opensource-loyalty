import { createHash, randomUUID } from "node:crypto";
import type { LoyaltyEngine, LoyaltyEngineState } from "@loyalty-interchange/reference";
import { EngineError } from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";

const MAX_EVENT_PROPERTIES_BYTES = 65_536;
const MAX_IMPORT_ROWS = 1_000;

export interface CustomerConsent {
  marketing: boolean;
  updated_at: string;
  source: string;
}

export interface CustomerProfile {
  member_id: string;
  external_id?: string;
  display_name?: string;
  email?: string;
  phone?: string;
  birth_date?: string;
  attributes: Record<string, unknown>;
  consent: CustomerConsent;
  created_at: string;
  updated_at: string;
}

export interface CustomerEvent {
  event_id: string;
  idempotency_key: string;
  member_id: string;
  type: string;
  occurred_at: string;
  source: string;
  campaign_id?: string;
  value_minor_units?: number;
  currency?: string;
  properties: Record<string, unknown>;
  received_at: string;
}

export interface MemberImportJob {
  import_id: string;
  idempotency_key: string;
  status: "completed" | "partial" | "failed";
  submitted: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; code: string; detail: string }>;
  created_at: string;
  completed_at: string;
}

export interface CustomerDataState {
  version: 1;
  profiles: CustomerProfile[];
  events: CustomerEvent[];
  imports: MemberImportJob[];
}

export interface CustomerDataSnapshot {
  profiles: CustomerProfile[];
  events: CustomerEvent[];
  imports: MemberImportJob[];
}

export interface CustomerDataServiceOptions {
  store: AsyncStateStore<CustomerDataState>;
  engine: LoyaltyEngine;
  persistEngine: (state: LoyaltyEngineState) => void;
  executeEngineOperation?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  reset?: boolean;
}

export interface CustomerSegmentFacts {
  profile?: CustomerProfile;
  events: CustomerEvent[];
}

export interface CustomerDataAnalytics {
  generated_at: string;
  profiles: {
    total: number;
    marketing_consented: number;
    with_email: number;
    with_phone: number;
  };
  events: {
    total: number;
    unique_members: number;
    by_type: Array<{ type: string; count: number }>;
    by_day: Array<{ date: string; count: number }>;
  };
  imports: {
    total: number;
    completed: number;
    failed_rows: number;
  };
}

export interface CustomerAttributionReport {
  campaign_id: string;
  targeted_members: number;
  converted_members: number;
  conversions: number;
  attributed_value_minor_units: number;
  conversion_rate: number;
}

export type CustomerProfileInput = {
  member_id: string;
  external_id?: string;
  display_name?: string;
  email?: string;
  phone?: string;
  birth_date?: string;
  attributes?: Record<string, unknown>;
  consent?: {
    marketing: boolean;
    source?: string;
    updated_at?: string;
  };
};

function timestamp(): string {
  return new Date().toISOString();
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(normalized)) {
    throw new EngineError(
      "validation_failed",
      `${name} must contain 1-255 URL-safe identifier characters`,
      422
    );
  }
  return normalized;
}

function optionalText(value: string | undefined, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new EngineError(
      "validation_failed",
      `${name} must contain between 1 and ${max} characters`,
      422
    );
  }
  return normalized;
}

function optionalIsoDate(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new EngineError("validation_failed", `${name} must be an ISO-8601 date`, 422);
  }
  return new Date(parsed).toISOString();
}

function validateProperties(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties = structuredClone(value ?? {});
  if (Object.keys(properties).length > 100) {
    throw new EngineError("validation_failed", "At most 100 properties are allowed", 422);
  }
  if (Buffer.byteLength(JSON.stringify(properties)) > MAX_EVENT_PROPERTIES_BYTES) {
    throw new EngineError("validation_failed", "Properties exceed 64 KiB", 422);
  }
  return properties;
}

function profileFingerprint(input: CustomerProfileInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class CustomerDataService {
  private readonly store: AsyncStateStore<CustomerDataState>;
  private readonly engine: LoyaltyEngine;
  private readonly persistEngine: (state: LoyaltyEngineState) => void;
  private readonly executeEngineOperation: <T>(operation: () => T | Promise<T>) => Promise<T>;
  private state: CustomerDataState;
  private revision: number;

  private constructor(
    options: CustomerDataServiceOptions,
    state: CustomerDataState,
    revision: number
  ) {
    this.store = options.store;
    this.engine = options.engine;
    this.persistEngine = options.persistEngine;
    this.executeEngineOperation = options.executeEngineOperation ?? (async (operation) => operation());
    this.state = state;
    this.revision = revision;
  }

  public static async create(options: CustomerDataServiceOptions): Promise<CustomerDataService> {
    if (options.reset) await options.store.clear();
    const loaded = await options.store.load();
    const state = loaded?.state ?? {
      version: 1 as const,
      profiles: [],
      events: [],
      imports: []
    };
    if (state.version !== 1) {
      await options.store.close();
      throw new EngineError("invalid_state", "Stored customer data is incompatible", 500);
    }
    const service = new CustomerDataService(options, state, loaded?.revision ?? 0);
    await service.save();
    return service;
  }

  public snapshot(): CustomerDataSnapshot {
    return structuredClone(this.state);
  }

  public listProfiles(): CustomerProfile[] {
    return structuredClone(this.state.profiles);
  }

  public profile(memberId: string): CustomerProfile | undefined {
    const profile = this.state.profiles.find((candidate) => candidate.member_id === memberId);
    return profile ? structuredClone(profile) : undefined;
  }

  public factsForMember(memberId: string): CustomerSegmentFacts {
    const profile = this.profile(memberId);
    return {
      ...(profile ? { profile } : {}),
      events: this.listEvents({ member_id: memberId, limit: 10_000 })
    };
  }

  public async upsertProfile(input: CustomerProfileInput): Promise<CustomerProfile> {
    let result: CustomerProfile | undefined;
    await this.executeEngineOperation(() => {
      const existingMember = this.engine.inspectAdmin().members.some(
        ({ member }) => member.member_id === input.member_id.trim()
      );
      result = this.upsertProfileInMemory(input, !existingMember);
      this.persistEngine(this.engine.exportState());
    });
    await this.save();
    return structuredClone(result!);
  }

  /**
   * Copies profile-shaped attributes from already-enrolled synthetic/demo
   * members into the non-protocol customer store. Existing profiles win.
   */
  public async seedProfilesFromEngine(): Promise<number> {
    let created = 0;
    for (const { member } of this.engine.inspectAdmin().members) {
      if (this.state.profiles.some(({ member_id }) => member_id === member.member_id)) continue;
      const attributes = member.attributes ?? {};
      const profile = this.upsertProfileInMemory({
        member_id: member.member_id,
        ...(typeof attributes["name"] === "string"
          ? { display_name: attributes["name"] }
          : typeof attributes["display_name"] === "string"
            ? { display_name: attributes["display_name"] }
            : {}),
        ...(typeof attributes["email"] === "string" ? { email: attributes["email"] } : {}),
        ...(typeof attributes["phone"] === "string" ? { phone: attributes["phone"] } : {}),
        attributes: Object.fromEntries(Object.entries(attributes).filter(([key]) =>
          !["name", "display_name", "email", "phone", "marketing_consent"].includes(key)
        )),
        consent: {
          marketing: attributes["marketing_consent"] === true,
          source: "demo-seed"
        }
      }, false);
      if (profile) created += 1;
    }
    if (created > 0) await this.save();
    return created;
  }

  public async ingestEvent(input: {
    event_id?: string;
    idempotency_key: string;
    member_id: string;
    type: string;
    occurred_at?: string;
    source?: string;
    campaign_id?: string;
    value_minor_units?: number;
    currency?: string;
    properties?: Record<string, unknown>;
  }): Promise<CustomerEvent> {
    const idempotencyKey = requiredIdentifier(input.idempotency_key, "idempotency_key");
    const prior = this.state.events.find((event) => event.idempotency_key === idempotencyKey);
    if (prior) {
      const priorFacts = {
        member_id: prior.member_id,
        type: prior.type,
        occurred_at: prior.occurred_at,
        source: prior.source,
        campaign_id: prior.campaign_id,
        value_minor_units: prior.value_minor_units,
        currency: prior.currency,
        properties: prior.properties
      };
      const nextFacts = this.normalizedEventFacts({
        ...input,
        occurred_at: input.occurred_at ?? prior.occurred_at
      });
      if (JSON.stringify(priorFacts) !== JSON.stringify(nextFacts)) {
        throw new EngineError("conflict", "Event idempotency key has different facts", 409);
      }
      return structuredClone(prior);
    }
    const facts = this.normalizedEventFacts(input);
    if (!this.engine.inspectAdmin().members.some(({ member }) => member.member_id === facts.member_id)) {
      throw new EngineError("not_found", "Customer member was not found", 404);
    }
    const event: CustomerEvent = {
      event_id: input.event_id
        ? requiredIdentifier(input.event_id, "event_id")
        : `event_${randomUUID()}`,
      idempotency_key: idempotencyKey,
      ...facts,
      received_at: timestamp()
    };
    if (this.state.events.some((candidate) => candidate.event_id === event.event_id)) {
      throw new EngineError("conflict", "Event id already exists", 409);
    }
    this.state = { ...this.state, events: [event, ...this.state.events].slice(0, 100_000) };
    await this.save();
    return structuredClone(event);
  }

  public listEvents(filter: {
    member_id?: string;
    type?: string;
    campaign_id?: string;
    limit?: number;
  } = {}): CustomerEvent[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 10_000));
    return structuredClone(this.state.events.filter((event) =>
      (!filter.member_id || event.member_id === filter.member_id) &&
      (!filter.type || event.type === filter.type) &&
      (!filter.campaign_id || event.campaign_id === filter.campaign_id)
    ).slice(0, limit));
  }

  public async importMembers(input: {
    idempotency_key: string;
    rows: CustomerProfileInput[];
  }): Promise<MemberImportJob> {
    const idempotencyKey = requiredIdentifier(input.idempotency_key, "idempotency_key");
    if (input.rows.length === 0 || input.rows.length > MAX_IMPORT_ROWS) {
      throw new EngineError(
        "validation_failed",
        `Member imports require between 1 and ${MAX_IMPORT_ROWS} rows`,
        422
      );
    }
    const prior = this.state.imports.find((job) => job.idempotency_key === idempotencyKey);
    if (prior) return structuredClone(prior);
    const startedAt = timestamp();
    let created = 0;
    let updated = 0;
    const errors: MemberImportJob["errors"] = [];
    await this.executeEngineOperation(() => {
      for (const [index, row] of input.rows.entries()) {
        try {
          const memberId = row.member_id.trim();
          const existed = this.engine.inspectAdmin().members.some(
            ({ member }) => member.member_id === memberId
          );
          this.upsertProfileInMemory(row, !existed);
          if (existed) updated += 1;
          else created += 1;
        } catch (error) {
          errors.push({
            row: index + 1,
            code: error instanceof EngineError ? error.code : "import_failed",
            detail: error instanceof Error ? error.message : "Import row failed"
          });
        }
      }
      this.persistEngine(this.engine.exportState());
    });
    const job: MemberImportJob = {
      import_id: `import_${randomUUID()}`,
      idempotency_key: idempotencyKey,
      status: errors.length === input.rows.length
        ? "failed"
        : errors.length > 0
          ? "partial"
          : "completed",
      submitted: input.rows.length,
      created,
      updated,
      failed: errors.length,
      errors,
      created_at: startedAt,
      completed_at: timestamp()
    };
    this.state = { ...this.state, imports: [job, ...this.state.imports].slice(0, 1_000) };
    await this.save();
    return structuredClone(job);
  }

  public analytics(): CustomerDataAnalytics {
    const byType = new Map<string, number>();
    const byDay = new Map<string, number>();
    for (const event of this.state.events) {
      byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
      const date = event.occurred_at.slice(0, 10);
      byDay.set(date, (byDay.get(date) ?? 0) + 1);
    }
    return {
      generated_at: timestamp(),
      profiles: {
        total: this.state.profiles.length,
        marketing_consented: this.state.profiles.filter(({ consent }) => consent.marketing).length,
        with_email: this.state.profiles.filter(({ email }) => Boolean(email)).length,
        with_phone: this.state.profiles.filter(({ phone }) => Boolean(phone)).length
      },
      events: {
        total: this.state.events.length,
        unique_members: new Set(this.state.events.map(({ member_id }) => member_id)).size,
        by_type: [...byType.entries()]
          .map(([type, count]) => ({ type, count }))
          .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
        by_day: [...byDay.entries()]
          .map(([date, count]) => ({ date, count }))
          .sort((left, right) => left.date.localeCompare(right.date))
      },
      imports: {
        total: this.state.imports.length,
        completed: this.state.imports.filter(({ status }) => status === "completed").length,
        failed_rows: this.state.imports.reduce((total, job) => total + job.failed, 0)
      }
    };
  }

  public attribution(campaignId: string, targetedMemberIds: string[]): CustomerAttributionReport {
    const target = new Set(targetedMemberIds);
    const conversions = this.state.events.filter((event) =>
      event.campaign_id === campaignId && target.has(event.member_id)
    );
    const convertedMembers = new Set(conversions.map(({ member_id }) => member_id)).size;
    return {
      campaign_id: campaignId,
      targeted_members: target.size,
      converted_members: convertedMembers,
      conversions: conversions.length,
      attributed_value_minor_units: conversions.reduce(
        (total, event) => total + (event.value_minor_units ?? 0),
        0
      ),
      conversion_rate: target.size === 0 ? 0 : convertedMembers / target.size
    };
  }

  public async close(): Promise<void> {
    await this.store.close();
  }

  private upsertProfileInMemory(input: CustomerProfileInput, enrollMember: boolean): CustomerProfile {
    const memberId = requiredIdentifier(input.member_id, "member_id");
    const externalId = optionalText(input.external_id, "external_id", 255);
    const displayName = optionalText(input.display_name, "display_name", 200);
    const email = optionalText(input.email, "email", 320);
    const phone = optionalText(input.phone, "phone", 50);
    const birthDate = optionalIsoDate(input.birth_date, "birth_date")?.slice(0, 10);
    const attributes = validateProperties(input.attributes);
    const existing = this.state.profiles.find((profile) => profile.member_id === memberId);
    if (enrollMember) {
      this.engine.enroll({
        context: {
          protocol_version: "1.0",
          profile: "foodservice/1.0",
          request_id: `platform-member-${randomUUID()}`,
          idempotency_key: `platform-member-${profileFingerprint(input)}`,
          occurred_at: timestamp(),
          source: { system: "reference-platform", instance: "platform-api" }
        },
        program_id: this.engine.getProgramDefinition().program_id,
        member_id: memberId,
        identity: {
          type: "external",
          value: externalId ?? `platform:${memberId}`,
          issuer: "reference-platform"
        },
        attributes: {
          ...attributes,
          ...(displayName ? { display_name: displayName } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          marketing_consent: input.consent?.marketing ?? false
        }
      });
    }
    const now = timestamp();
    const profile: CustomerProfile = {
      member_id: memberId,
      ...(externalId ? { external_id: externalId } : existing?.external_id ? { external_id: existing.external_id } : {}),
      ...(displayName ? { display_name: displayName } : existing?.display_name ? { display_name: existing.display_name } : {}),
      ...(email ? { email } : existing?.email ? { email: existing.email } : {}),
      ...(phone ? { phone } : existing?.phone ? { phone: existing.phone } : {}),
      ...(birthDate ? { birth_date: birthDate } : existing?.birth_date ? { birth_date: existing.birth_date } : {}),
      attributes: { ...(existing?.attributes ?? {}), ...attributes },
      consent: input.consent
        ? {
            marketing: input.consent.marketing,
            source: optionalText(input.consent.source, "consent.source", 100) ?? "api",
            updated_at: optionalIsoDate(input.consent.updated_at, "consent.updated_at") ?? now
          }
        : existing?.consent ?? { marketing: false, source: "api", updated_at: now },
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    this.state = {
      ...this.state,
      profiles: existing
        ? this.state.profiles.map((candidate) => candidate.member_id === memberId ? profile : candidate)
        : [profile, ...this.state.profiles]
    };
    return profile;
  }

  private normalizedEventFacts(input: {
    member_id: string;
    type: string;
    occurred_at?: string;
    source?: string;
    campaign_id?: string;
    value_minor_units?: number;
    currency?: string;
    properties?: Record<string, unknown>;
  }): Omit<CustomerEvent, "event_id" | "idempotency_key" | "received_at"> {
    const occurredAt = optionalIsoDate(input.occurred_at, "occurred_at") ?? timestamp();
    if (
      input.value_minor_units !== undefined &&
      (!Number.isSafeInteger(input.value_minor_units) || input.value_minor_units < 0)
    ) {
      throw new EngineError(
        "validation_failed",
        "value_minor_units must be a non-negative safe integer",
        422
      );
    }
    const currency = optionalText(input.currency, "currency", 3)?.toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      throw new EngineError("validation_failed", "currency must be a three-letter code", 422);
    }
    return {
      member_id: requiredIdentifier(input.member_id, "member_id"),
      type: requiredIdentifier(input.type, "type"),
      occurred_at: occurredAt,
      source: optionalText(input.source, "source", 100) ?? "api",
      ...(input.campaign_id
        ? { campaign_id: requiredIdentifier(input.campaign_id, "campaign_id") }
        : {}),
      ...(input.value_minor_units !== undefined
        ? { value_minor_units: input.value_minor_units }
        : {}),
      ...(currency ? { currency } : {}),
      properties: validateProperties(input.properties)
    };
  }

  private async save(): Promise<void> {
    this.revision = await this.store.save(this.state, this.revision);
  }
}
