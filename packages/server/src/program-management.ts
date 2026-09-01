import {
  EngineError,
  LoyaltyEngine,
  assertCompatibleProgramUpdate,
  programDefinitionFingerprint,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";

export interface ProgramValidationIssue {
  path: string;
  message: string;
}

export interface ProgramValidationResult {
  ok: boolean;
  issues: ProgramValidationIssue[];
}

export interface ProgramDraft {
  version: number;
  updated_at: string;
  updated_by: string;
  program: unknown;
  validation: ProgramValidationResult;
}

export interface ProgramRevision {
  revision: number;
  published_at: string;
  published_by: string;
  program: ProgramDefinition;
}

export interface ProgramAuditEntry {
  audit_id: string;
  action: "draft.saved" | "draft.discarded" | "program.published" | "program.rolled_back";
  actor: string;
  occurred_at: string;
  revision?: number;
  draft_version?: number;
}

export interface ProgramManagementSnapshot {
  active_revision: number;
  active_published_at: string;
  active_published_by: string;
  active_program: ProgramDefinition;
  draft?: ProgramDraft;
  history: ProgramRevision[];
  audit: ProgramAuditEntry[];
}

export interface ProgramManagementState extends ProgramManagementSnapshot {
  version: 1;
}

export interface ProgramManagementServiceOptions {
  store: AsyncStateStore<ProgramManagementState>;
  initialProgram: ProgramDefinition;
  reset?: boolean;
}

const allowedProgramFields = new Set([
  "program_id",
  "name",
  "description",
  "currency",
  "accounts",
  "metrics",
  "tiers",
  "tier_policy",
  "point_expiration",
  "balance_expiration",
  "earning_policy",
  "earn_rate",
  "visit_stamp_policy",
  "wallet_credit_policy",
  "membership_policy",
  "evaluation_ttl_seconds",
  "reservation_ttl_seconds",
  "rewards",
  "metadata"
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now(): string {
  return new Date().toISOString();
}

function validationIssue(error: unknown): ProgramValidationIssue {
  const message = error instanceof Error ? error.message : "Program definition is invalid";
  const path = message.includes("currency") || message.includes("Program id")
    ? "/program_id"
    : message.includes("Earn rate")
      ? "/earn_rate"
      : message.includes("TTL")
        ? "/evaluation_ttl_seconds"
        : message.includes("Minimum eligible")
          ? "/earning_policy/minimum_eligible_spend_minor_units"
          : message.includes("Eligible channels")
            ? "/earning_policy/eligible_channels"
            : message.includes("expiration")
              ? "/point_expiration"
              : message.includes("account")
                ? "/accounts"
                : message.includes("Metric")
                  ? "/metrics"
                  : message.includes("Tier")
                    ? "/tiers"
                    : message.includes("Reward") || message.includes("Funding")
                      ? "/rewards"
                      : "/";
  return {
    path,
    message
  };
}

export function validateProgramDefinition(program: unknown): ProgramValidationResult {
  if (!program || typeof program !== "object" || Array.isArray(program)) {
    return { ok: false, issues: [{ path: "/", message: "Program definition must be an object" }] };
  }
  const unknownFields = Object.keys(program).filter((field) => !allowedProgramFields.has(field));
  if (unknownFields.length > 0) {
    return {
      ok: false,
      issues: unknownFields.map((field) => ({
        path: `/${field}`,
        message: "Unknown program field"
      }))
    };
  }
  const values = program as Record<string, unknown>;
  const identityIssues: ProgramValidationIssue[] = [];
  if (typeof values["program_id"] !== "string" || values["program_id"].length === 0) {
    identityIssues.push({ path: "/program_id", message: "Program id is required" });
  }
  if (typeof values["currency"] !== "string" || !/^[A-Z]{3}$/.test(values["currency"])) {
    identityIssues.push({ path: "/currency", message: "Currency must be a three-letter ISO code" });
  }
  if (identityIssues.length > 0) return { ok: false, issues: identityIssues };
  try {
    new LoyaltyEngine(program as ProgramDefinition);
    return { ok: true, issues: [] };
  } catch (error) {
    return { ok: false, issues: [validationIssue(error)] };
  }
}

export class ProgramManagementService {
  private readonly store: AsyncStateStore<ProgramManagementState>;
  private state: ProgramManagementState;
  private revision: number;
  private applyProgram?: (program: ProgramDefinition) => void | Promise<void>;

  private constructor(
    options: ProgramManagementServiceOptions,
    state: ProgramManagementState,
    revision: number
  ) {
    this.store = options.store;
    this.state = state;
    this.revision = revision;
  }

  public static async create(
    options: ProgramManagementServiceOptions
  ): Promise<ProgramManagementService> {
    if (options.reset) await options.store.clear();
    const loaded = await options.store.load();
    if (loaded && loaded.state.version !== 1) {
      await options.store.close();
      throw new Error(
        `Unsupported program-management state version: ${String(loaded.state.version)}`
      );
    }
    const state = loaded?.state ?? (() => {
      const timestamp = now();
      return {
        version: 1 as const,
        active_revision: 1,
        active_published_at: timestamp,
        active_published_by: "bootstrap",
        active_program: clone(options.initialProgram),
        history: [],
        audit: []
      };
    })();
    const validation = validateProgramDefinition(state.active_program);
    if (!validation.ok) {
      await options.store.close();
      throw new EngineError(
        "invalid_program",
        `Published program is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        500
      );
    }
    const service = new ProgramManagementService(options, state, loaded?.revision ?? 0);
    await service.save();
    return service;
  }

  public snapshot(): ProgramManagementSnapshot {
    const { version: _version, ...snapshot } = this.state;
    return clone(snapshot);
  }

  public activeProgram(): ProgramDefinition {
    return clone(this.state.active_program);
  }

  public programForFingerprint(value: string): ProgramDefinition | undefined {
    const candidates = [
      this.state.active_program,
      ...this.state.history.map((revision) => revision.program)
    ];
    const match = candidates.find((program) => programDefinitionFingerprint(program) === value);
    return match ? clone(match) : undefined;
  }

  public async saveDraft(program: unknown, actor: string): Promise<ProgramManagementSnapshot> {
    const timestamp = now();
    const draftVersion = (this.state.draft?.version ?? this.state.active_revision) + 1;
    this.state = {
      ...this.state,
      draft: {
        version: draftVersion,
        updated_at: timestamp,
        updated_by: actor,
        program: clone(program),
        validation: validateProgramDefinition(program)
      }
    };
    this.recordAudit({
      audit_id: `audit_${crypto.randomUUID()}`,
      action: "draft.saved",
      actor,
      occurred_at: timestamp,
      draft_version: draftVersion
    });
    await this.save();
    return this.snapshot();
  }

  public async upsertReward(reward: unknown, actor: string): Promise<ProgramManagementSnapshot> {
    if (!reward || typeof reward !== "object" || Array.isArray(reward)) {
      throw new EngineError("validation_failed", "Reward must be an object", 422);
    }
    const rewardId = (reward as Record<string, unknown>)["reward_id"];
    if (typeof rewardId !== "string" || rewardId.trim().length === 0) {
      throw new EngineError("validation_failed", "reward_id is required", 422);
    }
    const program = this.draftProgramObject();
    const rewards = Array.isArray(program["rewards"])
      ? structuredClone(program["rewards"]) as unknown[]
      : [];
    const index = rewards.findIndex((candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>)["reward_id"] === rewardId
    );
    if (index >= 0) rewards[index] = clone(reward);
    else rewards.push(clone(reward));
    return this.saveDraft({ ...program, rewards }, actor);
  }

  public async deleteReward(rewardId: string, actor: string): Promise<ProgramManagementSnapshot> {
    const program = this.draftProgramObject();
    const rewards = Array.isArray(program["rewards"]) ? program["rewards"] : [];
    const nextRewards = rewards.filter((candidate) =>
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      (candidate as Record<string, unknown>)["reward_id"] !== rewardId
    );
    if (nextRewards.length === rewards.length) {
      throw new EngineError("not_found", "Reward was not found", 404);
    }
    return this.saveDraft({ ...program, rewards: nextRewards }, actor);
  }

  public async validateDraft(): Promise<ProgramValidationResult> {
    const draft = this.state.draft;
    if (!draft) {
      return { ok: false, issues: [{ path: "/", message: "No program draft exists" }] };
    }
    const validation = validateProgramDefinition(draft.program);
    this.state = {
      ...this.state,
      draft: { ...draft, validation }
    };
    await this.save();
    return clone(validation);
  }

  public async discardDraft(actor: string): Promise<ProgramManagementSnapshot> {
    if (!this.state.draft) throw new EngineError("not_found", "No program draft exists", 404);
    const draftVersion = this.state.draft.version;
    const { draft: _draft, ...remaining } = this.state;
    this.state = remaining;
    this.recordAudit({
      audit_id: `audit_${crypto.randomUUID()}`,
      action: "draft.discarded",
      actor,
      occurred_at: now(),
      draft_version: draftVersion
    });
    await this.save();
    return this.snapshot();
  }

  public bindPublisher(apply: (program: ProgramDefinition) => void | Promise<void>): void {
    this.applyProgram = apply;
  }

  public async publish(
    expectedDraftVersion: number,
    actor: string
  ): Promise<ProgramManagementSnapshot> {
    const draft = this.state.draft;
    if (!draft) throw new EngineError("not_found", "No program draft exists", 404);
    if (draft.version !== expectedDraftVersion) {
      throw new EngineError("conflict", "Program draft changed; refresh before publishing", 409);
    }
    const validation = validateProgramDefinition(draft.program);
    if (!validation.ok) {
      this.state = {
        ...this.state,
        draft: { ...draft, validation }
      };
      await this.save();
      throw new EngineError(
        "invalid_program",
        validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
        422
      );
    }
    const nextProgram = clone(draft.program as ProgramDefinition);
    assertCompatibleProgramUpdate(this.state.active_program, nextProgram);
    return this.applyPublishedProgram(nextProgram, actor, "program.published");
  }

  public async rollback(
    revision: number,
    actor: string
  ): Promise<ProgramManagementSnapshot> {
    const target = this.state.history.find((candidate) => candidate.revision === revision);
    if (!target) throw new EngineError("not_found", `Program revision ${revision} was not found`, 404);
    assertCompatibleProgramUpdate(this.state.active_program, target.program);
    return this.applyPublishedProgram(target.program, actor, "program.rolled_back");
  }

  public async close(): Promise<void> {
    await this.store.close();
  }

  private async applyPublishedProgram(
    program: ProgramDefinition,
    actor: string,
    action: "program.published" | "program.rolled_back"
  ): Promise<ProgramManagementSnapshot> {
    const apply = this.applyProgram;
    if (!apply) throw new Error("Program publisher is not bound");
    const publishedProgram = clone(program);
    if (publishedProgram.metadata?.["lip_bootstrap"] === true) {
      const { lip_bootstrap: _bootstrapMarker, ...metadata } = publishedProgram.metadata;
      publishedProgram.metadata = metadata;
    }
    const previous = clone(this.state);
    const timestamp = now();
    const revision = this.state.active_revision + 1;
    const { draft: _draft, ...remaining } = this.state;
    this.state = {
      ...remaining,
      history: [
        {
          revision: this.state.active_revision,
          published_at: this.state.active_published_at,
          published_by: this.state.active_published_by,
          program: clone(this.state.active_program)
        },
        ...this.state.history
      ].slice(0, 20),
      active_revision: revision,
      active_published_at: timestamp,
      active_published_by: actor,
      active_program: clone(publishedProgram)
    };
    this.recordAudit({
      audit_id: `audit_${crypto.randomUUID()}`,
      action,
      actor,
      occurred_at: timestamp,
      revision
    });
    // Persist intent first. Startup can safely retarget the previous engine
    // snapshot to this compatible published definition after an interrupted write.
    await this.save();
    try {
      await apply(clone(publishedProgram));
    } catch (error) {
      this.state = previous;
      await this.save();
      throw error;
    }
    return this.snapshot();
  }

  private recordAudit(entry: ProgramAuditEntry): void {
    this.state = {
      ...this.state,
      audit: [entry, ...this.state.audit].slice(0, 100)
    };
  }

  private draftProgramObject(): Record<string, unknown> {
    const value = this.state.draft?.program ?? this.state.active_program;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new EngineError("invalid_program", "Program draft must be an object", 422);
    }
    return clone(value as Record<string, unknown>);
  }

  private async save(): Promise<void> {
    this.revision = await this.store.save(this.state, this.revision);
  }
}
