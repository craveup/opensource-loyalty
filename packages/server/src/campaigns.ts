import { createHash, randomUUID } from "node:crypto";
import {
  EngineError,
  type LoyaltyEngine,
  type LoyaltyEngineState,
  type ProgramDefinition
} from "@loyalty-interchange/reference";
import type { AsyncStateStore } from "@loyalty-interchange/storage";
import type { CustomerSegmentFacts } from "./customer-data.js";

export interface SegmentEventRule {
  type: string;
  minimum_count?: number;
  within_days?: number;
  minimum_value_minor_units?: number;
}

export interface SegmentRules {
  statuses?: Array<"active" | "suspended" | "closed">;
  tier_ids?: string[];
  minimum_available_balance?: number;
  attributes?: Record<string, unknown>;
  profile?: {
    has_email?: boolean;
    has_phone?: boolean;
    marketing_consent?: boolean;
    attributes?: Record<string, unknown>;
  };
  event?: SegmentEventRule;
}

export interface StaticSegment {
  segment_id: string;
  name: string;
  mode: "static" | "dynamic";
  member_ids: string[];
  rules?: SegmentRules;
  created_at: string;
  updated_at: string;
}

export interface RewardCampaign {
  campaign_id: string;
  name: string;
  reward_id: string;
  segment_id: string;
  status: "draft" | "active" | "paused" | "scheduled" | "completed" | "expired";
  holdout_percent?: number;
  attribution_window_days?: number;
  issued_reward_ttl_seconds?: number;
  starts_at?: string;
  ends_at?: string;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
}

export interface CampaignRun {
  run_id: string;
  campaign_id: string;
  actor: string;
  started_at: string;
  completed_at: string;
  issued: number;
  skipped: number;
  failed: number;
  holdout: number;
  outcomes: Array<{
    member_id: string;
    issued_reward_id: string;
    status: "issued" | "skipped" | "failed";
    cohort?: "targeted" | "holdout";
    error?: string;
  }>;
}

export interface CampaignSnapshot {
  segments: StaticSegment[];
  campaigns: RewardCampaign[];
  runs: CampaignRun[];
}

export interface CampaignState extends CampaignSnapshot {
  version: 1;
}

export interface CampaignServiceOptions {
  store: AsyncStateStore<CampaignState>;
  engine: LoyaltyEngine;
  persistEngine: (state: LoyaltyEngineState) => void;
  /**
   * Runs an engine mutation inside an external storage transaction (Postgres
   * mode); defaults to a passthrough for the single-writer SQLite runtime.
   */
  executeEngineOperation?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  reset?: boolean;
  schedulerIntervalMs?: number | false;
  customerFacts?: (memberId: string) => CustomerSegmentFacts;
}

function timestamp(): string {
  return new Date().toISOString();
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new EngineError("validation_failed", `${name} is required`, 422);
  return normalized;
}

export class CampaignService {
  private readonly store: AsyncStateStore<CampaignState>;
  private readonly engine: LoyaltyEngine;
  private readonly persistEngine: (state: LoyaltyEngineState) => void;
  private readonly executeEngineOperation: <T>(operation: () => T | Promise<T>) => Promise<T>;
  private readonly scheduler: NodeJS.Timeout | undefined;
  private readonly customerFacts: ((memberId: string) => CustomerSegmentFacts) | undefined;
  private state: CampaignState;
  private revision: number;

  private constructor(
    options: CampaignServiceOptions,
    state: CampaignState,
    revision: number
  ) {
    this.store = options.store;
    this.engine = options.engine;
    this.persistEngine = options.persistEngine;
    this.executeEngineOperation =
      options.executeEngineOperation ?? (async (operation) => operation());
    this.customerFacts = options.customerFacts;
    this.state = state;
    this.revision = revision;
    this.scheduler = options.schedulerIntervalMs
      ? setInterval(() => {
          this.runDueCampaigns("scheduler").catch((error: unknown) => {
            // Individual campaign/member failures are retained in run outcomes.
            console.error(
              `[lip] campaign scheduler failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        }, options.schedulerIntervalMs).unref()
      : undefined;
  }

  public static async create(options: CampaignServiceOptions): Promise<CampaignService> {
    if (options.reset) await options.store.clear();
    const loaded = await options.store.load();
    const stored = loaded?.state ?? {
      version: 1 as const,
      segments: [],
      campaigns: [],
      runs: []
    };
    if (stored.version !== 1) {
      await options.store.close();
      throw new Error(`Unsupported campaign state version: ${String(stored.version)}`);
    }
    const state: CampaignState = {
      ...stored,
      segments: stored.segments.map((segment) => ({
        ...segment,
        mode: segment.mode ?? (segment.rules ? "dynamic" : "static")
      }))
    };
    const service = new CampaignService(options, state, loaded?.revision ?? 0);
    await service.save();
    return service;
  }

  public snapshot(): CampaignSnapshot {
    return structuredClone({
      segments: this.state.segments,
      campaigns: this.state.campaigns,
      runs: this.state.runs
    });
  }

  public membersForSegment(segmentId: string): string[] {
    const segment = this.state.segments.find((candidate) => candidate.segment_id === segmentId);
    if (!segment) {
      throw new EngineError("not_found", `Segment ${segmentId} was not found`, 404);
    }
    return this.resolveSegmentMembers(segment);
  }

  public previewSegment(segmentId: string, sampleSize = 25): {
    segment_id: string;
    estimated_size: number;
    sample_member_ids: string[];
  } {
    const members = this.membersForSegment(segmentId);
    return {
      segment_id: segmentId,
      estimated_size: members.length,
      sample_member_ids: members.slice(0, Math.max(1, Math.min(sampleSize, 100)))
    };
  }

  public async upsertSegment(input: {
    segment_id?: string;
    name: string;
    member_ids?: string[];
    rules?: StaticSegment["rules"];
  }): Promise<StaticSegment> {
    const now = timestamp();
    const segmentId = input.segment_id ?? `segment_${randomUUID()}`;
    const memberIds = [...new Set(
      (input.member_ids ?? []).map((value) => value.trim()).filter(Boolean)
    )];
    const mode = input.rules ? "dynamic" : "static";
    if (mode === "static") {
      if (memberIds.length === 0) {
        throw new EngineError("validation_failed", "A static segment requires at least one member", 422);
      }
      const knownMembers = new Set(
        this.engine.inspectAdmin().members.map(({ member }) => member.member_id)
      );
      const unknown = memberIds.filter((memberId) => !knownMembers.has(memberId));
      if (unknown.length > 0) {
        throw new EngineError("not_found", `Unknown segment members: ${unknown.join(", ")}`, 404);
      }
    } else if (!input.rules || Object.keys(input.rules).length === 0) {
      throw new EngineError("validation_failed", "A dynamic segment requires at least one rule", 422);
    }
    const existing = this.state.segments.find((segment) => segment.segment_id === segmentId);
    const segment: StaticSegment = {
      segment_id: segmentId,
      name: required(input.name, "Segment name"),
      mode,
      member_ids: memberIds,
      ...(input.rules ? { rules: structuredClone(input.rules) } : {}),
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    this.state = {
      ...this.state,
      segments: existing
        ? this.state.segments.map((candidate) =>
            candidate.segment_id === segmentId ? segment : candidate
          )
        : [segment, ...this.state.segments]
    };
    await this.save();
    return structuredClone(segment);
  }

  public async deleteSegment(segmentId: string): Promise<void> {
    if (this.state.campaigns.some((campaign) => campaign.segment_id === segmentId)) {
      throw new EngineError("conflict", "Segment is used by a campaign", 409);
    }
    const segments = this.state.segments.filter((segment) => segment.segment_id !== segmentId);
    if (segments.length === this.state.segments.length) {
      throw new EngineError("not_found", "Segment was not found", 404);
    }
    this.state = { ...this.state, segments };
    await this.save();
  }

  public async upsertCampaign(input: {
    campaign_id?: string;
    name: string;
    reward_id: string;
    segment_id: string;
    issued_reward_ttl_seconds?: number;
    holdout_percent?: number;
    attribution_window_days?: number;
    starts_at?: string;
    ends_at?: string;
  }): Promise<RewardCampaign> {
    if (!this.state.segments.some((segment) => segment.segment_id === input.segment_id)) {
      throw new EngineError("not_found", "Campaign segment was not found", 404);
    }
    if (!this.engine.getProgramDefinition().rewards.some((reward) =>
      reward.reward_id === input.reward_id
    )) {
      throw new EngineError("not_found", "Campaign reward was not found", 404);
    }
    if (
      input.issued_reward_ttl_seconds !== undefined &&
      (!Number.isInteger(input.issued_reward_ttl_seconds) ||
        input.issued_reward_ttl_seconds < 60)
    ) {
      throw new EngineError(
        "validation_failed",
        "Issued reward TTL must be an integer of at least 60 seconds",
        422
      );
    }
    if (
      input.holdout_percent !== undefined &&
      (!Number.isInteger(input.holdout_percent) ||
        input.holdout_percent < 0 || input.holdout_percent > 90)
    ) {
      throw new EngineError(
        "validation_failed",
        "Campaign holdout percent must be an integer between 0 and 90",
        422
      );
    }
    if (
      input.attribution_window_days !== undefined &&
      (!Number.isInteger(input.attribution_window_days) ||
        input.attribution_window_days < 1 || input.attribution_window_days > 90)
    ) {
      throw new EngineError(
        "validation_failed",
        "Attribution window must be an integer between 1 and 90 days",
        422
      );
    }
    const startsAt = input.starts_at ? Date.parse(input.starts_at) : undefined;
    const endsAt = input.ends_at ? Date.parse(input.ends_at) : undefined;
    if (
      (startsAt !== undefined && !Number.isFinite(startsAt)) ||
      (endsAt !== undefined && !Number.isFinite(endsAt)) ||
      (startsAt !== undefined && endsAt !== undefined && endsAt <= startsAt)
    ) {
      throw new EngineError("validation_failed", "Campaign schedule is invalid", 422);
    }
    const now = timestamp();
    const campaignId = input.campaign_id ?? `campaign_${randomUUID()}`;
    const existing = this.state.campaigns.find((campaign) =>
      campaign.campaign_id === campaignId
    );
    const campaign: RewardCampaign = {
      campaign_id: campaignId,
      name: required(input.name, "Campaign name"),
      reward_id: input.reward_id,
      segment_id: input.segment_id,
      status: startsAt !== undefined && startsAt > Date.now()
        ? "scheduled"
        : existing?.status ?? "draft",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...(input.issued_reward_ttl_seconds
        ? { issued_reward_ttl_seconds: input.issued_reward_ttl_seconds }
        : {}),
      ...(input.holdout_percent !== undefined
        ? { holdout_percent: input.holdout_percent }
        : existing?.holdout_percent !== undefined
          ? { holdout_percent: existing.holdout_percent }
          : {}),
      ...(input.attribution_window_days !== undefined
        ? { attribution_window_days: input.attribution_window_days }
        : existing?.attribution_window_days !== undefined
          ? { attribution_window_days: existing.attribution_window_days }
          : { attribution_window_days: 7 }),
      ...(input.starts_at ? { starts_at: new Date(startsAt!).toISOString() } : {}),
      ...(input.ends_at ? { ends_at: new Date(endsAt!).toISOString() } : {})
    };
    this.state = {
      ...this.state,
      campaigns: existing
        ? this.state.campaigns.map((candidate) =>
            candidate.campaign_id === campaignId ? campaign : candidate
          )
        : [campaign, ...this.state.campaigns]
    };
    await this.save();
    return structuredClone(campaign);
  }

  public async deleteCampaign(campaignId: string): Promise<void> {
    const campaigns = this.state.campaigns.filter((campaign) =>
      campaign.campaign_id !== campaignId
    );
    if (campaigns.length === this.state.campaigns.length) {
      throw new EngineError("not_found", "Campaign was not found", 404);
    }
    this.state = { ...this.state, campaigns };
    await this.save();
  }

  public async setCampaignStatus(
    campaignId: string,
    status: "active" | "paused"
  ): Promise<RewardCampaign> {
    const campaign = this.state.campaigns.find((candidate) =>
      candidate.campaign_id === campaignId
    );
    if (!campaign) throw new EngineError("not_found", "Campaign was not found", 404);
    if (["completed", "expired"].includes(campaign.status)) {
      throw new EngineError("conflict", "Completed or expired campaigns cannot be changed", 409);
    }
    const next = { ...campaign, status, updated_at: timestamp() };
    this.replaceCampaign(next);
    await this.save();
    return structuredClone(next);
  }

  public async runCampaign(campaignId: string, actor: string): Promise<CampaignRun> {
    const campaign = this.state.campaigns.find((candidate) =>
      candidate.campaign_id === campaignId
    );
    if (!campaign) throw new EngineError("not_found", "Campaign was not found", 404);
    if (campaign.status === "paused") {
      throw new EngineError("conflict", "Campaign is paused", 409);
    }
    if (campaign.ends_at && Date.parse(campaign.ends_at) <= Date.now()) {
      this.replaceCampaign({ ...campaign, status: "expired", updated_at: timestamp() });
      await this.save();
      throw new EngineError("expired", "Campaign has ended", 409);
    }
    const segment = this.state.segments.find((candidate) =>
      candidate.segment_id === campaign.segment_id
    );
    if (!segment) throw new EngineError("not_found", "Campaign segment was not found", 404);
    const startedAt = timestamp();
    const runId = `run_${randomUUID()}`;
    const outcomes: CampaignRun["outcomes"] = [];
    await this.executeEngineOperation(() => {
      for (const memberId of this.resolveSegmentMembers(segment)) {
        const issuedRewardId = `${campaign.campaign_id}:${memberId}`;
        if (this.inHoldout(campaign, memberId)) {
          outcomes.push({
            member_id: memberId,
            issued_reward_id: issuedRewardId,
            status: "skipped",
            cohort: "holdout"
          });
          continue;
        }
        try {
          const existing = this.engine.inspectAdmin().issued_rewards.find((reward) =>
            reward.issued_reward_id === issuedRewardId
          );
          if (existing) {
            outcomes.push({
              member_id: memberId,
              issued_reward_id: issuedRewardId,
              status: "skipped",
              cohort: "targeted"
            });
            continue;
          }
          const occurredAt = timestamp();
          this.engine.issueReward({
            context: {
              protocol_version: "1.0",
              profile: "foodservice/1.0",
              request_id: `${runId}:${memberId}`,
              idempotency_key: issuedRewardId,
              occurred_at: occurredAt,
              source: { system: "reference-campaigns", instance: actor }
            },
            issued_reward_id: issuedRewardId,
            member_id: memberId,
            program_id: this.engine.getProgramDefinition().program_id,
            reward_id: campaign.reward_id,
            ...(campaign.issued_reward_ttl_seconds
              ? {
                  expires_at: new Date(
                    Date.parse(occurredAt) + campaign.issued_reward_ttl_seconds * 1000
                  ).toISOString()
                }
              : {})
          });
          outcomes.push({
            member_id: memberId,
            issued_reward_id: issuedRewardId,
            status: "issued",
            cohort: "targeted"
          });
        } catch (error) {
          outcomes.push({
            member_id: memberId,
            issued_reward_id: issuedRewardId,
            status: "failed",
            cohort: "targeted",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      this.persistEngine(this.engine.exportState());
    });
    const completedAt = timestamp();
    const run: CampaignRun = {
      run_id: runId,
      campaign_id: campaignId,
      actor,
      started_at: startedAt,
      completed_at: completedAt,
      issued: outcomes.filter(({ status }) => status === "issued").length,
      skipped: outcomes.filter(({ status }) => status === "skipped").length,
      failed: outcomes.filter(({ status }) => status === "failed").length,
      holdout: outcomes.filter(({ cohort }) => cohort === "holdout").length,
      outcomes
    };
    this.state = {
      ...this.state,
      campaigns: this.state.campaigns.map((candidate) =>
        candidate.campaign_id === campaignId
          ? {
              ...candidate,
              status: "completed" as const,
              last_run_at: completedAt,
              updated_at: completedAt
            }
          : candidate
      ),
      runs: [run, ...this.state.runs].slice(0, 100)
    };
    await this.save();
    return structuredClone(run);
  }

  public async runDueCampaigns(actor = "scheduler", at = new Date()): Promise<CampaignRun[]> {
    const nowMs = at.getTime();
    const runs: CampaignRun[] = [];
    const scheduledIds = this.state.campaigns
      .filter((campaign) => campaign.status === "scheduled")
      .map((campaign) => campaign.campaign_id);
    for (const campaignId of scheduledIds) {
      const campaign = this.state.campaigns.find((candidate) =>
        candidate.campaign_id === campaignId
      );
      if (!campaign || campaign.status !== "scheduled") continue;
      if (campaign.ends_at && Date.parse(campaign.ends_at) <= nowMs) {
        this.replaceCampaign({ ...campaign, status: "expired", updated_at: at.toISOString() });
        continue;
      }
      if (!campaign.starts_at || Date.parse(campaign.starts_at) <= nowMs) {
        runs.push(await this.runCampaign(campaign.campaign_id, actor));
      }
    }
    await this.save();
    return runs;
  }

  public assertCompatibleProgram(program: ProgramDefinition): void {
    const rewardIds = new Set(program.rewards.map((reward) => reward.reward_id));
    const incompatible = this.state.campaigns.find((campaign) =>
      !rewardIds.has(campaign.reward_id)
    );
    if (incompatible) {
      throw new EngineError(
        "conflict",
        `Reward ${incompatible.reward_id} is used by campaign ${incompatible.campaign_id}`,
        409
      );
    }
  }

  public async close(): Promise<void> {
    if (this.scheduler) clearInterval(this.scheduler);
    await this.store.close();
  }

  private replaceCampaign(campaign: RewardCampaign): void {
    this.state = {
      ...this.state,
      campaigns: this.state.campaigns.map((candidate) =>
        candidate.campaign_id === campaign.campaign_id ? campaign : candidate
      )
    };
  }

  private async save(): Promise<void> {
    this.revision = await this.store.save(this.state, this.revision);
  }

  private resolveSegmentMembers(segment: StaticSegment): string[] {
    if (segment.mode === "static") return [...segment.member_ids];
    const rules = segment.rules ?? {};
    return this.engine.inspectAdmin().members
      .filter(({ member, balance }) => {
        if (rules.statuses && !rules.statuses.includes(member.status)) return false;
        if (rules.tier_ids && (!member.tier_id || !rules.tier_ids.includes(member.tier_id))) {
          return false;
        }
        if (
          rules.minimum_available_balance !== undefined &&
          balance.available < rules.minimum_available_balance
        ) {
          return false;
        }
        if (rules.attributes && Object.entries(rules.attributes).some(
          ([key, value]) => JSON.stringify(member.attributes?.[key]) !== JSON.stringify(value)
        )) {
          return false;
        }
        if (rules.profile || rules.event) {
          const facts = this.customerFacts?.(member.member_id);
          if (!facts) return false;
          if (rules.profile?.has_email !== undefined &&
            Boolean(facts.profile?.email) !== rules.profile.has_email) return false;
          if (rules.profile?.has_phone !== undefined &&
            Boolean(facts.profile?.phone) !== rules.profile.has_phone) return false;
          if (rules.profile?.marketing_consent !== undefined &&
            Boolean(facts.profile?.consent.marketing) !== rules.profile.marketing_consent) return false;
          if (rules.profile?.attributes && Object.entries(rules.profile.attributes).some(
            ([key, value]) => JSON.stringify(facts.profile?.attributes[key]) !== JSON.stringify(value)
          )) return false;
          if (rules.event) {
            const since = rules.event.within_days === undefined
              ? undefined
              : Date.now() - rules.event.within_days * 86_400_000;
            const matching = facts.events.filter((event) =>
              event.type === rules.event!.type &&
              (since === undefined || Date.parse(event.occurred_at) >= since) &&
              (rules.event!.minimum_value_minor_units === undefined ||
                (event.value_minor_units ?? 0) >= rules.event!.minimum_value_minor_units)
            );
            if (matching.length < (rules.event.minimum_count ?? 1)) return false;
          }
        }
        return true;
      })
      .map(({ member }) => member.member_id);
  }

  private inHoldout(campaign: RewardCampaign, memberId: string): boolean {
    const percent = campaign.holdout_percent ?? 0;
    if (percent === 0) return false;
    const bucket = createHash("sha256")
      .update(`${campaign.campaign_id}:${memberId}`)
      .digest()
      .readUInt32BE(0) % 100;
    return bucket < percent;
  }
}
