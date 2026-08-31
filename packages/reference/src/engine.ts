import { createHash, randomUUID } from "node:crypto";
import type {
  AccountMetric,
  AccrualAmount,
  AccrualPostRequest,
  Balance,
  EvaluationRequest,
  EvaluationResponse,
  ExpiringBalance,
  IdentityReference,
  IssuedReward,
  IssuedRewardCancelRequest,
  IssuedRewardIssueRequest,
  IssuedRewardListRequest,
  IssuedRewardListResponse,
  IssuedRewardResponse,
  LedgerEntry,
  LedgerListRequest,
  LedgerListResponse,
  LedgerResponse,
  LoyaltyUnit,
  ManualAdjustmentRequest,
  Member,
  MemberAccountRequest,
  MemberAccountResponse,
  MemberEnrollRequest,
  MemberEnrollResponse,
  MemberLookupRequest,
  MemberLookupResponse,
  OrderChannel,
  OrderAdjustmentRequest,
  ProgramCatalog,
  ProgramGetRequest,
  ProgramGetResponse,
  RedemptionCaptureRequest,
  RedemptionReservation,
  RedemptionReservationResponse,
  RedemptionReserveRequest,
  RedemptionReverseRequest,
  RequestContext,
  ResponseContext,
  RewardCandidate,
  TierProgress
} from "@loyalty-interchange/protocol";
import {
  ProgramCatalogSchema,
  validate,
  validateFoodserviceOrder,
  validateFundingShares
} from "@loyalty-interchange/protocol";
import type { Clock, IdGenerator, ProgramDefinition, RewardDefinition } from "./config.js";
import { EngineError } from "./errors.js";
import { programConfigurationFor, type ReferenceProgramConfiguration } from "./program-configuration.js";

export interface ReferenceIdempotencyRecord {
  fingerprint: string;
  response: unknown;
}

interface LedgerCursor {
  version: 1;
  query: string;
  entry_id: string;
}

export interface ReferencePointLot {
  entryId: string;
  memberId: string;
  remaining: number;
  expiresAt: string;
  unit?: LoyaltyUnit;
}

export interface ReferencePointLotConsumption {
  entryId: string;
  amount: number;
}

export interface MemberErasureResult {
  erased: boolean;
  member: Member;
}

interface AccrualRecord {
  entryId: string;
  entryIds?: string[];
  fingerprint: string;
  multiplierBps: number;
}

interface MutationRecord {
  entryId: string;
  entryIds?: string[];
  fingerprint: string;
}

interface ReservationRecord {
  reservationId: string;
  fingerprint: string;
}

export interface LoyaltyEngineState {
  version: 1;
  program_id: string;
  program_fingerprint: string;
  saved_at: string;
  members: Array<[string, Member]>;
  identity_index: Array<[string, string]>;
  points: Array<[string, number]>;
  reservations: Array<[string, RedemptionReservation]>;
  ledger: Array<[string, LedgerEntry]>;
  point_lots: Array<[string, ReferencePointLot]>;
  point_lot_consumptions: Array<[string, ReferencePointLotConsumption[]]>;
  idempotency: Array<[string, ReferenceIdempotencyRecord]>;
  accruals_by_order: Array<[string, AccrualRecord]>;
  adjustments: Array<[string, MutationRecord]>;
  reservations_by_redemption: Array<[string, ReservationRecord]>;
  issued_rewards?: Array<[string, IssuedReward]>;
}

export interface ReferenceAdminMember {
  member: Member;
  balance: Balance;
  balances: Balance[];
  metrics: AccountMetric[];
  expiring_balances: ExpiringBalance[];
  tier_progress?: TierProgress;
  last_activity_at?: string;
}

export interface ReferenceMembership {
  plan_id: string;
  status: "active" | "lapsed" | "cancelled";
  valid_from: string;
  valid_until: string;
  billing_reference?: string;
}

export interface ReferenceAdminSnapshot {
  generated_at: string;
  program: ProgramCatalog;
  program_configuration: ReferenceProgramConfiguration;
  summary: {
    active_members: number;
    points_outstanding: number;
    points_issued: number;
    points_redeemed: number;
    expiring_points: number;
    primary_unit: "points" | "visits" | "stamps" | "credits";
    primary_balance_outstanding: number;
    primary_balance_issued: number;
    primary_balance_redeemed: number;
    expiring_primary_balance: number;
    ledger_entries: number;
  };
  members: ReferenceAdminMember[];
  ledger: LedgerEntry[];
  reservations: RedemptionReservation[];
  issued_rewards: IssuedReward[];
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;
type ReferenceAccountUnit = "points" | "visits" | "stamps" | "credits";
const allOrderChannels: OrderChannel[] = [
  "counter",
  "drive_thru",
  "kiosk",
  "web",
  "mobile",
  "pickup",
  "delivery",
  "catering",
  "third_party",
  "other"
];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

/**
 * v1 idempotency fingerprint: strips only context.request_id.
 * Retained so entries stored before v2 still match a pinned replay.
 */
export function idempotencyFingerprintV1(value: unknown): string {
  if (!value || typeof value !== "object") {
    return fingerprint(value);
  }
  const request = value as Record<string, unknown>;
  if (!request.context || typeof request.context !== "object") {
    return fingerprint(value);
  }
  const { request_id: _requestId, ...context } = request.context as Record<string, unknown>;
  return fingerprint({ ...request, context });
}

/**
 * v2 idempotency fingerprint: strips the entire context envelope. The identity
 * of "the same logical request" is the business payload; envelope fields
 * (request_id, occurred_at, source, versions) do not affect it.
 */
export function idempotencyFingerprintV2(value: unknown): string {
  if (!value || typeof value !== "object") {
    return fingerprint(value);
  }
  const { context: _context, ...payload } = value as Record<string, unknown>;
  return fingerprint(payload);
}

/** Returns a clone of a response with its response-context request_id replaced. */
function withReplayedRequestId<T>(response: T, requestId: string): T {
  if (response && typeof response === "object" && "context" in response) {
    const ctx = (response as { context?: unknown }).context;
    if (ctx && typeof ctx === "object") {
      return {
        ...(response as object),
        context: { ...(ctx as object), request_id: requestId }
      } as T;
    }
  }
  return response;
}

function identityKey(programId: string, identity: IdentityReference): string {
  return [programId, identity.type, identity.issuer ?? "", identity.value].join("|");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function scrubCachedMemberSnapshot(value: unknown, member: Member): unknown {
  if (Array.isArray(value)) {
    return value.map((nested) => scrubCachedMemberSnapshot(nested, member));
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (
    object["member_id"] === member.member_id &&
    object["program_id"] === member.program_id &&
    typeof object["joined_at"] === "string" &&
    Array.isArray(object["identities"])
  ) {
    return clone(member);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, nested]) => [
      key,
      scrubCachedMemberSnapshot(nested, member)
    ])
  );
}

export function programDefinitionFingerprint(program: ProgramDefinition): string {
  return fingerprint(program);
}

export function assertCompatibleProgramUpdate(
  current: ProgramDefinition,
  next: ProgramDefinition
): void {
  if (next.program_id !== current.program_id) {
    throw new EngineError("invalid_program", "A published program id cannot be changed", 409);
  }
  if (next.currency !== current.currency) {
    throw new EngineError("invalid_program", "A published program currency cannot be changed", 409);
  }
  const currentUnit = current.accounts?.find((account) => account.is_primary)?.unit ?? "points";
  const nextUnit = next.accounts?.find((account) => account.is_primary)?.unit ?? "points";
  if (nextUnit !== currentUnit) {
    throw new EngineError(
      "invalid_program",
      "A published program primary account unit cannot be changed",
      409
    );
  }
}

export function retargetProgramState(
  state: LoyaltyEngineState,
  current: ProgramDefinition,
  next: ProgramDefinition
): LoyaltyEngineState {
  assertCompatibleProgramUpdate(current, next);
  if (
    state.program_id !== current.program_id ||
    state.program_fingerprint !== programDefinitionFingerprint(current)
  ) {
    throw new EngineError(
      "invalid_state",
      "Stored engine state does not match the previous published program",
      500
    );
  }
  return {
    ...clone(state),
    program_fingerprint: programDefinitionFingerprint(next)
  };
}

export class LoyaltyEngine {
  private program: ProgramDefinition;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly members = new Map<string, Member>();
  private readonly identityIndex = new Map<string, string>();
  private readonly points = new Map<string, number>();
  private readonly reservations = new Map<string, RedemptionReservation>();
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly pointLots = new Map<string, ReferencePointLot>();
  private readonly pointLotConsumptions = new Map<string, ReferencePointLotConsumption[]>();
  private readonly idempotency = new Map<string, ReferenceIdempotencyRecord>();
  private readonly accrualsByOrder = new Map<string, AccrualRecord>();
  private readonly adjustments = new Map<string, MutationRecord>();
  private readonly reservationsByRedemption = new Map<string, ReservationRecord>();
  private readonly issuedRewards = new Map<string, IssuedReward>();

  public constructor(
    program: ProgramDefinition,
    options: { clock?: Clock; ids?: IdGenerator; state?: LoyaltyEngineState } = {}
  ) {
    this.assertProgram(program);
    this.program = clone(program);
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? systemIds;
    const catalogValidation = validate(ProgramCatalogSchema, this.programCatalog());
    if (!catalogValidation.ok) {
      throw new EngineError(
        "invalid_program",
        catalogValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
        400
      );
    }
    if (options.state) this.hydrate(options.state);
  }

  public getProgramDefinition(): ProgramDefinition {
    return clone(this.program);
  }

  public reconfigureProgram(program: ProgramDefinition): void {
    // Constructing a temporary engine runs the complete program validator.
    new LoyaltyEngine(program, { clock: this.clock, ids: this.ids });
    assertCompatibleProgramUpdate(this.program, program);
    const nextRewardIds = new Set(program.rewards.map((reward) => reward.reward_id));
    const removedActiveReward = [...this.issuedRewards.values()].find((issuedReward) =>
      issuedReward.status === "issued" && !nextRewardIds.has(issuedReward.reward_id)
    );
    if (removedActiveReward) {
      throw new EngineError(
        "conflict",
        `Reward ${removedActiveReward.reward_id} has active issued rewards and cannot be removed`,
        409
      );
    }
    const nextUnits = new Set((program.accounts ?? [{ unit: "points" }]).map(({ unit }) => unit));
    const removedAccount = this.accountUnits().find((unit) =>
      !nextUnits.has(unit) &&
      [...this.members.keys()].some((memberId) => this.balance(memberId, unit).amount !== 0)
    );
    if (removedAccount) {
      throw new EngineError(
        "conflict",
        `Account ${removedAccount} has non-zero balances and cannot be removed`,
        409
      );
    }
    this.program = clone(program);
    for (const memberId of this.members.keys()) {
      for (const unit of this.accountUnits()) {
        const key = this.balanceKey(memberId, unit);
        if (!this.points.has(key)) this.points.set(key, 0);
      }
    }
  }

  public lookup(request: MemberLookupRequest): MemberLookupResponse {
    this.assertProgramId(request.program_id);
    return this.once("member.lookup", request.context, request, () => {
      const memberId = this.identityIndex.get(identityKey(request.program_id, request.identity));
      const member = memberId ? this.members.get(memberId) ?? null : null;
      return {
        context: this.responseContext(request.context),
        member: member ? this.memberSnapshot(member) : null,
        balances: member ? this.balances(member.member_id) : []
      };
    });
  }

  public enroll(request: MemberEnrollRequest): MemberEnrollResponse {
    this.assertProgramId(request.program_id);
    return this.once("member.enroll", request.context, request, () => {
      const key = identityKey(request.program_id, request.identity);
      const existingId = this.identityIndex.get(key);
      if (existingId) {
        const existing = this.members.get(existingId);
        if (!existing) {
          throw new EngineError("not_found", "Identity index references a missing member", 500);
        }
        if (existing.status !== "active") {
          throw new EngineError(
            "member_not_active",
            `Member ${existing.member_id} is ${existing.status} and cannot be re-enrolled`,
            409
          );
        } // closed/suspended identities keep their ledger; no silent re-open
        return {
          context: this.responseContext(request.context),
          member: this.memberSnapshot(existing),
          balances: this.balances(existing.member_id)
        };
      }

      const memberId = request.member_id ?? this.ids("member");
      if (this.members.has(memberId)) {
        throw new EngineError("conflict", `Member ${memberId} already exists`);
      }
      const baseTierId = this.baseTierId();
      const member: Member = {
        member_id: memberId,
        program_id: request.program_id,
        status: "active",
        joined_at: this.isoNow(),
        ...(baseTierId ? { tier_id: baseTierId } : {}),
        identities: [clone(request.identity)],
        ...(request.attributes ? { attributes: clone(request.attributes) } : {})
      };
      this.members.set(memberId, member);
      this.identityIndex.set(key, memberId);
      for (const unit of this.accountUnits()) {
        this.points.set(this.balanceKey(memberId, unit), 0);
      }
      return {
        context: this.responseContext(request.context),
        member: this.memberSnapshot(member),
        balances: this.balances(memberId)
      };
    });
  }

  public getProgram(request: ProgramGetRequest): ProgramGetResponse {
    this.assertProgramId(request.program_id);
    return this.once("program.get", request.context, request, () => ({
      context: this.responseContext(request.context),
      program: this.programCatalog()
    }));
  }

  /**
   * Marks a member closed so protocol writes fail while ledger history is
   * retained. Idempotent when the member is already closed.
   */
  public cancelMember(memberId: string): Member {
    const member = this.members.get(memberId);
    if (!member) {
      throw new EngineError("member_not_found", `Member ${memberId} was not found`, 404);
    }
    if (member.status !== "closed") {
      member.status = "closed";
    }
    return this.memberSnapshot(member);
  }

  public inspectMemberErasure(memberId: string): MemberErasureResult {
    const member = this.members.get(memberId);
    if (!member) {
      throw new EngineError("member_not_found", `Member ${memberId} was not found`, 404);
    }
    const snapshot = this.memberSnapshot(member);
    return {
      erased:
        snapshot.status === "closed" &&
        snapshot.attributes === undefined &&
        snapshot.identities.length === 1 &&
        snapshot.identities[0]?.type === "loyalty_id" &&
        snapshot.identities[0].value === memberId &&
        snapshot.identities[0].issuer === "lip-erasure",
      member: snapshot
    };
  }

  /**
   * Removes external identity and member attributes while retaining the
   * pseudonymous member id, balances, and immutable ledger history.
   */
  public eraseMember(memberId: string): MemberErasureResult {
    const member = this.members.get(memberId);
    if (!member) {
      throw new EngineError("member_not_found", `Member ${memberId} was not found`, 404);
    }
    for (const identity of member.identities) {
      this.identityIndex.delete(identityKey(member.program_id, identity));
    }
    member.status = "closed";
    member.identities = [{
      issuer: "lip-erasure",
      type: "loyalty_id",
      value: member.member_id
    }];
    delete member.attributes;
    for (const record of this.idempotency.values()) {
      record.response = scrubCachedMemberSnapshot(record.response, member);
    }
    return this.inspectMemberErasure(memberId);
  }

  public setMemberMembership(memberId: string, membership?: ReferenceMembership): Member {
    const member = this.members.get(memberId);
    if (!member) throw new EngineError("member_not_found", `Member ${memberId} was not found`, 404);
    const attributes = clone(member.attributes ?? {});
    if (membership) attributes["membership"] = clone(membership);
    else delete attributes["membership"];
    member.attributes = attributes;
    return this.memberSnapshot(member);
  }

  public getAccount(request: MemberAccountRequest): MemberAccountResponse {
    this.assertProgramId(request.program_id);
    return this.once("account.get", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.expirePointLots(request.member_id);
      const metrics = this.accountMetrics(request.member_id);
      const tierProgress = this.tierProgress(metrics);
      return {
        context: this.responseContext(request.context),
        member: this.memberSnapshot(member),
        balances: this.balances(request.member_id),
        metrics,
        expiring_balances: this.expiringBalances(request.member_id),
        ...(tierProgress ? { tier_progress: tierProgress } : {})
      };
    });
  }

  public listLedger(request: LedgerListRequest): LedgerListResponse {
    this.assertProgramId(request.program_id);
    return this.once("ledger.list", request.context, request, () => {
      this.activeMember(request.member_id);
      this.expirePointLots(request.member_id);
      const query = this.ledgerQueryFingerprint(request);
      const entries = [...this.ledger.values()]
        .filter((entry) => this.matchesLedgerQuery(entry, request))
        .sort((left, right) => {
          const occurred = Date.parse(right.occurred_at) - Date.parse(left.occurred_at);
          return occurred !== 0 ? occurred : right.entry_id.localeCompare(left.entry_id);
        });
      const start = request.cursor ? this.cursorStart(request.cursor, query, entries) : 0;
      const limit = request.limit ?? 50;
      const page = entries.slice(start, start + limit);
      const hasMore = start + page.length < entries.length;
      const last = page.at(-1);
      return {
        context: this.responseContext(request.context),
        entries: page.map(clone),
        ...(hasMore && last ? { next_cursor: this.encodeCursor({
          version: 1,
          query,
          entry_id: last.entry_id
        }) } : {})
      };
    });
  }

  public evaluate(request: EvaluationRequest): EvaluationResponse {
    return this.once("order.evaluate", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.assertOrder(request.order, member);
      const rewards = this.program.rewards.map((reward) => this.rewardCandidate(reward, request.member_id));
      const multiplierBps = this.earningMultiplierBps(request.member_id);
      const estimatedAccruals = this.accrualAmounts(request.order, multiplierBps);
      const estimatedAccrual = estimatedAccruals.find(({ unit }) => unit === this.primaryUnit()) ??
        { unit: this.primaryUnit(), amount: 0 };
      return {
        context: this.responseContext(request.context),
        evaluation_id: this.ids("eval"),
        member_id: request.member_id,
        order_id: request.order.order_id,
        estimated_accrual: estimatedAccrual,
        ...(estimatedAccruals.length > 1 ? { estimated_accruals: estimatedAccruals } : {}),
        rewards,
        balances: this.balances(request.member_id),
        expires_at: this.futureIso(this.program.evaluation_ttl_seconds)
      };
    });
  }

  public postAccrual(request: AccrualPostRequest): LedgerResponse {
    return this.once("accrual.post", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.assertOrder(request.order, member);
      if (request.order.status !== "paid") {
        throw new EngineError("invalid_state", "Accrual requires a paid order");
      }

      const businessFingerprint = fingerprint({ member_id: request.member_id, order: request.order });
      const existingAccrual = this.accrualsByOrder.get(request.order.order_id);
      if (existingAccrual) {
        if (existingAccrual.fingerprint !== businessFingerprint) {
          throw new EngineError("conflict", "Order id was already accrued with different facts");
        }
        const existingEntry = this.ledger.get(existingAccrual.entryId);
        if (!existingEntry || existingEntry.member_id !== request.member_id) {
          throw new EngineError("conflict", "Order was accrued to a different member");
        }
        const existingEntries = (existingAccrual.entryIds ?? [existingAccrual.entryId])
          .map((entryId) => this.ledger.get(entryId))
          .filter((entry): entry is LedgerEntry => Boolean(entry));
        return this.ledgerResponse(request.context, existingEntry, existingEntries);
      }

      const multiplierBps = this.earningMultiplierBps(request.member_id);
      const entries = this.accrualAmounts(request.order, multiplierBps).map(({ unit, amount }) => {
        const expiration = this.expirationPolicy(unit);
        return this.addLedger({
          member_id: request.member_id,
          operation: "accrual",
          unit,
          amount,
          order_id: request.order.order_id,
          location_id: request.order.scope.location_id,
          ...(amount > 0 && expiration ? {
            expires_at: this.pointExpirationIso(unit),
            create_point_lot: true
          } : {})
        });
      });
      const entry = entries.find(({ unit }) => unit === this.primaryUnit()) ?? entries[0]!;
      this.accrualsByOrder.set(request.order.order_id, {
        entryId: entry.entry_id,
        entryIds: entries.map(({ entry_id }) => entry_id),
        fingerprint: businessFingerprint,
        multiplierBps
      });
      this.issueThresholdRewards(request.member_id, request.context);
      return this.ledgerResponse(request.context, entry, entries);
    });
  }

  public issueReward(request: IssuedRewardIssueRequest): IssuedRewardResponse {
    this.assertProgramId(request.program_id);
    return this.once("issued_reward.issue", request.context, request, () => {
      this.activeMember(request.member_id);
      if (!this.program.rewards.some((reward) => reward.reward_id === request.reward_id)) {
        throw new EngineError("not_found", `Reward ${request.reward_id} was not found`, 404);
      }
      if (request.expires_at && Date.parse(request.expires_at) <= this.clock.now().getTime()) {
        throw new EngineError("expired", "Issued reward expiration must be in the future");
      }
      const existing = this.issuedRewards.get(request.issued_reward_id);
      if (existing) {
        const sameFacts = existing.member_id === request.member_id &&
          existing.program_id === request.program_id &&
          existing.reward_id === request.reward_id &&
          existing.expires_at === request.expires_at &&
          fingerprint(existing.artifact) === fingerprint(request.artifact);
        if (!sameFacts) {
          throw new EngineError("conflict", "Issued reward id was already used with different facts");
        }
        return { context: this.responseContext(request.context), issued_reward: clone(existing) };
      }
      if (request.artifact && [...this.issuedRewards.values()].some((reward) =>
        reward.artifact?.type === request.artifact!.type &&
        reward.artifact.value === request.artifact!.value
      )) {
        throw new EngineError("conflict", "Issued reward artifact value must be unique");
      }
      const issuedReward: IssuedReward = {
        issued_reward_id: request.issued_reward_id,
        member_id: request.member_id,
        program_id: request.program_id,
        reward_id: request.reward_id,
        status: "issued",
        issued_at: this.isoNow(),
        ...(request.expires_at ? { expires_at: request.expires_at } : {}),
        ...(request.artifact ? { artifact: clone(request.artifact) } : {})
      };
      this.issuedRewards.set(issuedReward.issued_reward_id, issuedReward);
      return { context: this.responseContext(request.context), issued_reward: clone(issuedReward) };
    });
  }

  public listIssuedRewards(request: IssuedRewardListRequest): IssuedRewardListResponse {
    this.assertProgramId(request.program_id);
    return this.once("issued_reward.list", request.context, request, () => {
      this.activeMember(request.member_id);
      this.expireIssuedRewards(request.member_id);
      const issuedRewards = [...this.issuedRewards.values()]
        .filter((reward) =>
          reward.member_id === request.member_id &&
          (!request.statuses || request.statuses.includes(reward.status))
        )
        .sort((left, right) => right.issued_at.localeCompare(left.issued_at))
        .map(clone);
      return { context: this.responseContext(request.context), issued_rewards: issuedRewards };
    });
  }

  public cancelIssuedReward(request: IssuedRewardCancelRequest): IssuedRewardResponse {
    return this.once("issued_reward.cancel", request.context, request, () => {
      const reward = this.issuedRewards.get(request.issued_reward_id);
      if (!reward) throw new EngineError("not_found", "Issued reward was not found", 404);
      this.expireIssuedReward(reward);
      if (reward.status === "cancelled") {
        return { context: this.responseContext(request.context), issued_reward: clone(reward) };
      }
      if (reward.status !== "issued") {
        throw new EngineError("invalid_state", `Cannot cancel an issued reward in ${reward.status} state`);
      }
      const held = [...this.reservations.values()].some((reservation) =>
        reservation.issued_reward_id === reward.issued_reward_id &&
        reservation.status === "reserved"
      );
      if (held) throw new EngineError("invalid_state", "Cannot cancel an issued reward with an active reservation");
      reward.status = "cancelled";
      reward.cancelled_at = this.isoNow();
      reward.cancellation_reason = request.reason;
      return { context: this.responseContext(request.context), issued_reward: clone(reward) };
    });
  }

  public reserve(request: RedemptionReserveRequest): RedemptionReservationResponse {
    return this.once("redemption.reserve", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.assertOrder(request.order, member);
      const businessFingerprint = fingerprint({
        member_id: request.member_id,
        reward_id: request.reward_id,
        issued_reward_id: request.issued_reward_id,
        order: request.order
      });
      const existingReservation = this.reservationsByRedemption.get(request.redemption_id);
      if (existingReservation) {
        if (existingReservation.fingerprint !== businessFingerprint) {
          throw new EngineError("conflict", "Redemption id was already used with different facts");
        }
        return this.reservationResponse(
          request.context,
          this.getReservation(existingReservation.reservationId)
        );
      }
      const reward = this.program.rewards.find((candidate) => candidate.reward_id === request.reward_id);
      if (!reward) {
        throw new EngineError("reward_not_found", `Reward ${request.reward_id} was not found`, 404);
      }
      const windowReason = this.rewardWindowReason(reward);
      if (windowReason) {
        throw new EngineError(
          "reward_not_available",
          windowReason === "not_yet_available"
            ? `Reward ${reward.reward_id} is not available yet`
            : `Reward ${reward.reward_id} is no longer available`
        );
      }
      const issuedReward = request.issued_reward_id
        ? this.issuedRewards.get(request.issued_reward_id)
        : undefined;
      if (request.issued_reward_id && !issuedReward) {
        throw new EngineError("not_found", "Issued reward was not found", 404);
      }
      if (issuedReward) {
        this.expireIssuedReward(issuedReward);
        if (
          issuedReward.member_id !== request.member_id ||
          issuedReward.reward_id !== request.reward_id
        ) {
          throw new EngineError("conflict", "Issued reward does not match this member and reward");
        }
        if (issuedReward.status !== "issued") {
          throw new EngineError("invalid_state", `Issued reward is ${issuedReward.status}`);
        }
        if ([...this.reservations.values()].some((reservation) =>
          reservation.issued_reward_id === issuedReward.issued_reward_id &&
          reservation.status === "reserved"
        )) {
          throw new EngineError("conflict", "Issued reward already has an active reservation");
        }
      }
      if (!issuedReward && this.membershipUnavailable(reward, request.member_id)) {
        throw new EngineError(
          "reward_not_available",
          `Reward ${reward.reward_id} requires an active membership`
        );
      }
      const rewardCost = this.rewardCost(reward);
      if (
        !issuedReward &&
        this.balance(request.member_id, rewardCost.unit).available < rewardCost.amount
      ) {
        throw new EngineError("insufficient_balance", "Member does not have enough available balance");
      }

      const now = this.isoNow();
      const reservation: RedemptionReservation = {
        reservation_id: this.ids("reservation"),
        redemption_id: request.redemption_id,
        member_id: request.member_id,
        reward_id: reward.reward_id,
        ...(issuedReward ? { issued_reward_id: issuedReward.issued_reward_id } : {}),
        order_id: request.order.order_id,
        location_id: request.order.scope.location_id,
        status: "reserved",
        cost: { unit: rewardCost.unit, amount: issuedReward ? 0 : rewardCost.amount },
        effect: clone(reward.effect),
        funding: this.fundingAllocations(reward),
        created_at: now,
        expires_at: this.futureIso(this.program.reservation_ttl_seconds)
      };
      this.reservations.set(reservation.reservation_id, reservation);
      this.reservationsByRedemption.set(request.redemption_id, {
        reservationId: reservation.reservation_id,
        fingerprint: businessFingerprint
      });
      return this.reservationResponse(request.context, reservation);
    });
  }

  public capture(request: RedemptionCaptureRequest): RedemptionReservationResponse {
    return this.once("redemption.capture", request.context, request, () => {
      const reservation = this.getReservation(request.reservation_id);
      this.expireReservation(reservation);
      if (reservation.order_id !== request.order_id) {
        throw new EngineError("conflict", "Reservation belongs to a different order");
      }
      if (reservation.status === "captured") {
        return this.reservationResponse(request.context, reservation);
      }
      if (reservation.status === "expired") {
        throw new EngineError("expired", "Reservation has expired");
      }
      if (reservation.status !== "reserved") {
        throw new EngineError("invalid_state", `Cannot capture a ${reservation.status} reservation`);
      }

      const unit = reservation.cost.unit;
      this.assertAccountUnit(unit);
      const balance = this.balance(reservation.member_id, unit);
      if (balance.amount < reservation.cost.amount) {
        throw new EngineError("insufficient_balance", "Member no longer has enough balance");
      }
      if (reservation.cost.amount > 0) {
        this.consumePointLots(
          reservation.member_id,
          unit,
          reservation.cost.amount,
          reservation.reservation_id
        );
        this.addLedger({
          member_id: reservation.member_id,
          operation: "redemption",
          unit,
          amount: -reservation.cost.amount,
          order_id: reservation.order_id,
          // The redemption belongs to the reserving order's location, not the
          // location that originally earned the balance.
          ...(reservation.location_id ? { location_id: reservation.location_id } : {}),
          reservation_id: reservation.reservation_id
        });
      }
      reservation.status = "captured";
      reservation.captured_at = this.isoNow();
      if (reservation.issued_reward_id) {
        const issuedReward = this.issuedRewards.get(reservation.issued_reward_id);
        if (!issuedReward || issuedReward.status !== "issued") {
          throw new EngineError("invalid_state", "Issued reward is no longer claimable");
        }
        issuedReward.status = "redeemed";
        issuedReward.redeemed_at = reservation.captured_at;
      }
      return this.reservationResponse(request.context, reservation);
    });
  }

  public reverse(request: RedemptionReverseRequest): RedemptionReservationResponse {
    return this.once("redemption.reverse", request.context, request, () => {
      const reservation = this.getReservation(request.reservation_id);
      this.expireReservation(reservation);
      if (reservation.status === "reversed") {
        return this.reservationResponse(request.context, reservation);
      }
      if (reservation.status === "expired") {
        throw new EngineError("expired", "Reservation has expired");
      }
      if (reservation.status === "captured") {
        const unit = reservation.cost.unit;
        this.assertAccountUnit(unit);
        if (reservation.cost.amount > 0) {
          this.restorePointLots(reservation.reservation_id);
          this.addLedger({
            member_id: reservation.member_id,
            operation: "reversal",
            unit,
            amount: reservation.cost.amount,
            order_id: reservation.order_id,
            ...(reservation.location_id ? { location_id: reservation.location_id } : {}),
            reservation_id: reservation.reservation_id
          });
          this.expirePointLots(reservation.member_id, unit);
        }
        if (reservation.issued_reward_id) {
          const issuedReward = this.issuedRewards.get(reservation.issued_reward_id);
          if (issuedReward?.status === "redeemed") {
            issuedReward.status = "issued";
            delete issuedReward.redeemed_at;
          }
        }
      }
      reservation.status = "reversed";
      reservation.reversed_at = this.isoNow();
      return this.reservationResponse(request.context, reservation);
    });
  }

  public adjustOrder(request: OrderAdjustmentRequest): LedgerResponse {
    this.assertProgramId(request.program_id);
    return this.once("order.adjust", request.context, request, () => {
      const member = this.activeMember(request.member_id);
      this.expirePointLots(request.member_id);
      const adjustment = request.adjustment;
      if (adjustment.eligible_spend_delta.currency !== this.program.currency) {
        throw new EngineError("currency_mismatch", "Adjustment currency does not match the program");
      }
      const adjustmentMoney = [
        adjustment.order_total_delta,
        adjustment.eligible_spend_delta,
        ...(adjustment.lines?.map((line) => line.subtotal_delta) ?? [])
      ];
      if (adjustmentMoney.some((money) => money.currency !== this.program.currency)) {
        throw new EngineError("currency_mismatch", "All adjustment amounts must use the program currency");
      }
      if (
        adjustment.type !== "correction" &&
        (adjustment.order_total_delta.amount > 0 || adjustment.eligible_spend_delta.amount > 0)
      ) {
        throw new EngineError("invalid_state", "Refund and void adjustments must not increase spend");
      }
      const businessFingerprint = fingerprint({
        member_id: request.member_id,
        program_id: request.program_id,
        adjustment
      });
      const existingAdjustment = this.adjustments.get(adjustment.adjustment_id);
      if (existingAdjustment) {
        if (existingAdjustment.fingerprint !== businessFingerprint) {
          throw new EngineError("conflict", "Adjustment id was already used with different facts");
        }
        const existing = this.ledger.get(existingAdjustment.entryId);
        if (!existing) {
          throw new EngineError("not_found", "Adjustment references a missing ledger entry", 500);
        }
        return this.ledgerResponse(request.context, existing);
      }

      const originalAccrual = this.accrualsByOrder.get(adjustment.original_order_id);
      const multiplierBps = originalAccrual?.multiplierBps ?? this.earningMultiplierBps(member.member_id);
      const originalEntries = (originalAccrual?.entryIds ?? (originalAccrual ? [originalAccrual.entryId] : []))
        .map((entryId) => this.ledger.get(entryId))
        .filter((entry): entry is LedgerEntry => Boolean(entry));
      const entries = this.accountUnits().map((unit) => {
        const originalEntry = originalEntries.find((candidate) => candidate.unit === unit);
        let amount = unit === "points" || unit === "credits"
          ? originalAccrual && !originalEntry
            ? 0
            : this.pointsForSignedSpend(unit, adjustment.eligible_spend_delta.amount, multiplierBps)
          : ["full_refund", "void"].includes(adjustment.type)
            ? -(originalEntry?.amount ?? 0)
            : 0;
        if (amount < 0 && originalAccrual) {
          const priorAdjustments = [...this.ledger.values()]
            .filter((candidate) =>
              candidate.order_id === adjustment.original_order_id &&
              candidate.operation === "adjustment" &&
              candidate.unit === unit
            )
            .reduce((sum, candidate) => sum + candidate.amount, 0);
          amount = Math.max(amount, -Math.max(0, (originalEntry?.amount ?? 0) + priorAdjustments));
        }
        if (amount < 0) this.consumePointLots(request.member_id, unit, -amount);
        const expiration = this.expirationPolicy(unit);
        return this.addLedger({
          member_id: request.member_id,
          operation: "adjustment",
          unit,
          amount,
          order_id: adjustment.original_order_id,
          adjustment_id: adjustment.adjustment_id,
          ...(amount > 0 && expiration ? {
            expires_at: this.pointExpirationIso(unit),
            create_point_lot: true
          } : {})
        });
      });
      const entry = entries.find(({ unit }) => unit === this.primaryUnit()) ?? entries[0]!;
      this.adjustments.set(adjustment.adjustment_id, {
        entryId: entry.entry_id,
        entryIds: entries.map(({ entry_id }) => entry_id),
        fingerprint: businessFingerprint
      });
      return this.ledgerResponse(request.context, entry, entries);
    });
  }

  public postManualAdjustment(request: ManualAdjustmentRequest): LedgerResponse {
    this.assertProgramId(request.program_id);
    return this.once("ledger.manual", request.context, request, () => {
      this.activeMember(request.member_id);
      const unit = request.unit ?? this.primaryUnit();
      this.assertAccountUnit(unit);
      this.expirePointLots(request.member_id, unit);
      if (request.amount === 0) {
        throw new EngineError("invalid_state", "Manual adjustment amount must not be zero");
      }
      if (request.amount < 0 && request.expires_at) {
        throw new EngineError("invalid_state", "Manual debits cannot specify expires_at");
      }
      if (request.expires_at && Date.parse(request.expires_at) <= this.clock.now().getTime()) {
        throw new EngineError("expired", "Manual adjustment expiration must be in the future");
      }

      const businessFingerprint = fingerprint({
        member_id: request.member_id,
        program_id: request.program_id,
        adjustment_id: request.adjustment_id,
        unit,
        amount: request.amount,
        classification: request.classification,
        reason: request.reason,
        qualifies_for_tier: request.qualifies_for_tier,
        expires_at: request.expires_at
      });
      const existingAdjustment = this.adjustments.get(request.adjustment_id);
      if (existingAdjustment) {
        if (existingAdjustment.fingerprint !== businessFingerprint) {
          throw new EngineError("conflict", "Adjustment id was already used with different facts");
        }
        const existing = this.ledger.get(existingAdjustment.entryId);
        if (!existing) {
          throw new EngineError("not_found", "Adjustment references a missing ledger entry", 500);
        }
        return this.ledgerResponse(request.context, existing);
      }

      if (request.amount < 0) this.consumePointLots(request.member_id, unit, -request.amount);
      const expiresAt = request.amount > 0
        ? request.expires_at ?? (this.expirationPolicy(unit) ? this.pointExpirationIso(unit) : undefined)
        : undefined;
      const entry = this.addLedger({
        member_id: request.member_id,
        operation: "manual",
        unit,
        amount: request.amount,
        adjustment_id: request.adjustment_id,
        classification: request.classification,
        reason: request.reason,
        qualifies_for_tier: request.qualifies_for_tier,
        ...(expiresAt ? { expires_at: expiresAt, create_point_lot: true } : {})
      });
      this.adjustments.set(request.adjustment_id, {
        entryId: entry.entry_id,
        fingerprint: businessFingerprint
      });
      return this.ledgerResponse(request.context, entry);
    });
  }

  public getLedger(): LedgerEntry[] {
    this.expirePointLots();
    return [...this.ledger.values()].map(clone);
  }

  public exportState(): LoyaltyEngineState {
    return clone({
      version: 1,
      program_id: this.program.program_id,
      program_fingerprint: fingerprint(this.program),
      saved_at: this.isoNow(),
      members: [...this.members.entries()],
      identity_index: [...this.identityIndex.entries()],
      points: [...this.points.entries()],
      reservations: [...this.reservations.entries()],
      ledger: [...this.ledger.entries()],
      point_lots: [...this.pointLots.entries()],
      point_lot_consumptions: [...this.pointLotConsumptions.entries()],
      idempotency: [...this.idempotency.entries()],
      accruals_by_order: [...this.accrualsByOrder.entries()],
      adjustments: [...this.adjustments.entries()],
      reservations_by_redemption: [...this.reservationsByRedemption.entries()],
      issued_rewards: [...this.issuedRewards.entries()]
    });
  }

  public replaceState(state: LoyaltyEngineState): void {
    // Validate the complete snapshot before changing the live engine.
    new LoyaltyEngine(this.program, { clock: this.clock, ids: this.ids, state });
    for (const map of [
      this.members,
      this.identityIndex,
      this.points,
      this.reservations,
      this.ledger,
      this.pointLots,
      this.pointLotConsumptions,
      this.idempotency,
      this.accrualsByOrder,
      this.adjustments,
      this.reservationsByRedemption,
      this.issuedRewards
    ]) {
      map.clear();
    }
    this.hydrate(state);
  }

  /**
   * Ledger-only admin inspection: the cloned ledger (newest first) and
   * reservations without the per-member balance/metric aggregation that
   * `inspectAdmin()` performs. Reporting over raw entries should prefer this.
   */
  public inspectLedger(): { ledger: LedgerEntry[]; reservations: RedemptionReservation[] } {
    this.expireAllReservations();
    this.expirePointLots();
    return {
      ledger: this.sortedLedgerClone(),
      reservations: [...this.reservations.values()].map(clone)
    };
  }

  public inspectAdmin(): ReferenceAdminSnapshot {
    this.expireAllReservations();
    this.expirePointLots();
    const ledger = this.sortedLedgerClone();
    const members = [...this.members.values()]
      .map((member): ReferenceAdminMember => {
        const metrics = this.accountMetrics(member.member_id);
        const tierProgress = this.tierProgress(metrics);
        const lastActivity = ledger.find((entry) => entry.member_id === member.member_id)?.occurred_at;
        return {
          member: this.memberSnapshot(member),
          balance: this.balance(member.member_id),
          balances: this.balances(member.member_id),
          metrics,
          expiring_balances: this.expiringBalances(member.member_id),
          ...(tierProgress ? { tier_progress: tierProgress } : {}),
          ...(lastActivity ? { last_activity_at: lastActivity } : {})
        };
      })
      .sort((left, right) =>
        (right.last_activity_at ?? right.member.joined_at)
          .localeCompare(left.last_activity_at ?? left.member.joined_at)
      );
    const pointsIssued = ledger
      .filter((entry) => entry.unit === this.primaryUnit() && entry.amount > 0)
      .reduce((sum, entry) => sum + entry.amount, 0);
    const pointsRedeemed = ledger
      .filter((entry) =>
        entry.unit === this.primaryUnit() && entry.operation === "redemption"
      )
      .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

    const outstanding = members.reduce((sum, { balance }) => sum + balance.amount, 0);
    const expiring = members.reduce(
      (sum, member) => sum + member.expiring_balances.reduce(
        (memberSum, balance) =>
          memberSum + (balance.unit === this.primaryUnit() ? balance.amount : 0),
        0
      ),
      0
    );
    return {
      generated_at: this.isoNow(),
      program: this.programCatalog(),
      program_configuration: programConfigurationFor(this.program),
      summary: {
        active_members: members.filter(({ member }) => member.status === "active").length,
        points_outstanding: outstanding,
        points_issued: pointsIssued,
        points_redeemed: pointsRedeemed,
        expiring_points: expiring,
        primary_unit: this.primaryUnit(),
        primary_balance_outstanding: outstanding,
        primary_balance_issued: pointsIssued,
        primary_balance_redeemed: pointsRedeemed,
        expiring_primary_balance: expiring,
        ledger_entries: ledger.length
      },
      members,
      ledger,
      reservations: [...this.reservations.values()].map(clone),
      issued_rewards: [...this.issuedRewards.values()].map(clone)
    };
  }

  /** Cloned ledger entries, newest first with a stable entry-id tiebreak. */
  private sortedLedgerClone(): LedgerEntry[] {
    return [...this.ledger.values()]
      .sort((left, right) => {
        const occurred = Date.parse(right.occurred_at) - Date.parse(left.occurred_at);
        return occurred !== 0 ? occurred : right.entry_id.localeCompare(left.entry_id);
      })
      .map(clone);
  }

  private hydrate(state: LoyaltyEngineState): void {
    if (
      !state ||
      state.version !== 1 ||
      state.program_id !== this.program.program_id ||
      state.program_fingerprint !== fingerprint(this.program)
    ) {
      throw new EngineError(
        "invalid_state",
        "Stored engine state is incompatible with the configured program",
        500
      );
    }

    this.restoreMap(this.members, state.members, "members");
    this.restoreMap(this.identityIndex, state.identity_index, "identity index");
    this.restoreMap(this.points, state.points, "points");
    this.restoreMap(this.reservations, state.reservations, "reservations");
    this.restoreMap(this.ledger, state.ledger, "ledger");
    this.restoreMap(this.pointLots, state.point_lots, "point lots");
    this.restoreMap(
      this.pointLotConsumptions,
      state.point_lot_consumptions,
      "point-lot consumptions"
    );
    this.restoreMap(this.idempotency, state.idempotency, "idempotency records");
    this.restoreMap(this.accrualsByOrder, state.accruals_by_order, "order accruals");
    this.restoreMap(this.adjustments, state.adjustments, "order adjustments");
    this.restoreMap(
      this.reservationsByRedemption,
      state.reservations_by_redemption,
      "redemption reservations"
    );
    this.restoreMap(this.issuedRewards, state.issued_rewards ?? [], "issued rewards");

    for (const [memberId, member] of this.members) {
      if (member.member_id !== memberId || !this.points.has(memberId)) {
        throw new EngineError("invalid_state", "Stored member state is internally inconsistent", 500);
      }
      for (const unit of this.accountUnits()) {
        const key = this.balanceKey(memberId, unit);
        if (!this.points.has(key)) this.points.set(key, 0);
      }
    }
  }

  private restoreMap<K, V>(target: Map<K, V>, entries: Array<[K, V]>, name: string): void {
    if (!Array.isArray(entries)) {
      throw new EngineError("invalid_state", `Stored ${name} are invalid`, 500);
    }
    const restored = new Map(entries);
    if (restored.size !== entries.length) {
      throw new EngineError("invalid_state", `Stored ${name} contain duplicate keys`, 500);
    }
    for (const [key, value] of restored) target.set(clone(key), clone(value));
  }

  private assertProgram(program: ProgramDefinition): void {
    if (!program.program_id || !/^[A-Z]{3}$/.test(program.currency)) {
      throw new EngineError("invalid_program", "Program id and ISO currency are required", 400);
    }
    if (
      !Number.isInteger(program.earn_rate.points) ||
      program.earn_rate.points < 0 ||
      !Number.isInteger(program.earn_rate.spend_minor_units) ||
      program.earn_rate.spend_minor_units <= 0
    ) {
      throw new EngineError("invalid_program", "Earn rate must use non-negative integer points and positive spend", 400);
    }
    if (program.evaluation_ttl_seconds <= 0 || program.reservation_ttl_seconds <= 0) {
      throw new EngineError("invalid_program", "TTL values must be positive", 400);
    }
    const earning = program.earning_policy;
    if (
      earning?.minimum_eligible_spend_minor_units !== undefined &&
      (!Number.isInteger(earning.minimum_eligible_spend_minor_units) ||
        earning.minimum_eligible_spend_minor_units < 0)
    ) {
      throw new EngineError("invalid_program", "Minimum eligible spend must be a non-negative integer", 400);
    }
    if (earning?.eligible_channels && (
      earning.eligible_channels.length === 0 ||
      new Set(earning.eligible_channels).size !== earning.eligible_channels.length
    )) {
      throw new EngineError("invalid_program", "Eligible channels must be non-empty and unique", 400);
    }
    for (const expiration of [program.point_expiration, program.balance_expiration]) {
      if (expiration && (
        !Number.isInteger(expiration.days) ||
        expiration.days <= 0 ||
        !Array.isArray(expiration.warning_days) ||
        expiration.warning_days.some((days) =>
          !Number.isInteger(days) || days <= 0 || days >= expiration.days
        )
      )) {
        throw new EngineError("invalid_program", "Balance expiration and warnings are invalid", 400);
      }
    }
    const accounts = program.accounts ?? [{ unit: "points", unit_label: "points", is_primary: true }];
    const units = new Set(accounts.map(({ unit }) => unit));
    const primaryUnit = accounts.find(({ is_primary }) => is_primary)?.unit;
    if (
      accounts.length === 0 ||
      units.size !== accounts.length ||
      accounts.some(({ unit }) => !["points", "visits", "stamps", "credits"].includes(unit)) ||
      !primaryUnit ||
      accounts.filter((account) => account.is_primary).length !== 1
    ) {
      throw new EngineError(
        "invalid_program",
        "Accounts must use unique units and define exactly one primary account",
        400
      );
    }
    if (units.has("visits") && units.has("stamps")) {
      throw new EngineError("invalid_program", "Programs cannot combine visit and stamp accounts", 400);
    }
    if (program.point_expiration && !units.has("points")) {
      throw new EngineError("invalid_program", "Point expiration requires a points account", 400);
    }
    if (program.balance_expiration && !units.has("credits")) {
      throw new EngineError("invalid_program", "Balance expiration requires a credits account", 400);
    }
    if (
      !units.has("points") &&
      (program.tiers?.length ?? 0) > 0
    ) {
      throw new EngineError(
        "invalid_program",
        "Tier ladders require a points account",
        400
      );
    }
    const metricIds = new Set<string>();
    for (const metric of program.metrics ?? []) {
      if (
        metricIds.has(metric.metric_id) ||
        !units.has(metric.unit) ||
        !["current_balance", "lifetime_earned", "qualification_earned"].includes(metric.source)
      ) {
        throw new EngineError("invalid_program", "Metrics need unique ids in a configured account unit", 400);
      }
      metricIds.add(metric.metric_id);
    }
    const tiers = [...(program.tiers ?? [])].sort((left, right) => left.minimum - right.minimum);
    if (tiers.length > 0) {
      const tierIds = new Set<string>();
      const qualificationMetric = tiers[0]!.qualification_metric_id;
      const qualificationMetricDefinition = program.metrics?.find(
        ({ metric_id }) => metric_id === qualificationMetric
      );
      if (
        tiers[0]!.minimum !== 0 ||
        !metricIds.has(qualificationMetric) ||
        qualificationMetricDefinition?.unit !== "points"
      ) {
        throw new EngineError(
          "invalid_program",
          "Tier ladders must start at zero and reference a configured metric",
          400
        );
      }
      for (const [index, tier] of tiers.entries()) {
        const previous = tiers[index - 1];
        if (
          tierIds.has(tier.tier_id) ||
          tier.qualification_metric_id !== qualificationMetric ||
          (previous && previous.minimum === tier.minimum)
        ) {
          throw new EngineError(
            "invalid_program",
            "Tiers need unique ids, thresholds, and one qualification metric",
            400
          );
        }
        tierIds.add(tier.tier_id);
      }
    }
    const tierPolicy = program.tier_policy;
    if (tierPolicy) {
      const qualificationMetric = tiers[0]?.qualification_metric_id;
      if (
        tierPolicy.metric_id !== qualificationMetric ||
        !metricIds.has(tierPolicy.metric_id)
      ) {
        throw new EngineError("invalid_program", "Tier policy must reference the tier qualification metric", 400);
      }
      const testDate = new Date(Date.UTC(
        2024,
        tierPolicy.period.starts_month - 1,
        tierPolicy.period.starts_day
      ));
      if (
        testDate.getUTCMonth() !== tierPolicy.period.starts_month - 1 ||
        testDate.getUTCDate() !== tierPolicy.period.starts_day
      ) {
        throw new EngineError("invalid_program", "Tier policy start date is invalid", 400);
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tierPolicy.period.time_zone }).format();
      } catch {
        throw new EngineError("invalid_program", "Tier policy time zone is invalid", 400);
      }
    }
    if (
      (program.metrics ?? []).some((metric) => metric.source === "qualification_earned") &&
      !tierPolicy
    ) {
      throw new EngineError("invalid_program", "Qualification metrics require a tier policy", 400);
    }
    const rewardIds = new Set<string>();
    for (const reward of program.rewards) {
      const rewardCost = reward.cost ?? { unit: primaryUnit, amount: reward.points_cost };
      if (
        rewardIds.has(reward.reward_id) ||
        rewardCost.amount < 0 ||
        !Number.isInteger(rewardCost.amount) ||
        !units.has(rewardCost.unit)
      ) {
        throw new EngineError("invalid_program", "Rewards need unique ids and non-negative integer costs", 400);
      }
      rewardIds.add(reward.reward_id);
      if (!validateFundingShares(reward.funding).ok) {
        throw new EngineError("invalid_program", `Funding for ${reward.reward_id} must total 10000 basis points`, 400);
      }
      const effectMoney = reward.effect.type === "discount"
        ? [reward.effect.amount, ...reward.effect.allocations.map((allocation) => allocation.amount)]
        : reward.effect.type === "free_item"
          ? [reward.effect.max_value]
          : [];
      if (effectMoney.some((money) => money.currency !== program.currency || money.amount < 0)) {
        throw new EngineError("invalid_program", `Reward ${reward.reward_id} has invalid money`, 400);
      }
      if (
        reward.effect.type === "discount" &&
        reward.effect.allocations.reduce((sum, allocation) => sum + allocation.amount.amount, 0) !== reward.effect.amount.amount
      ) {
        throw new EngineError("invalid_program", `Reward ${reward.reward_id} allocations do not reconcile`, 400);
      }
      if (
        reward.available_from &&
        reward.available_until &&
        Date.parse(reward.available_from) > Date.parse(reward.available_until)
      ) {
        throw new EngineError("invalid_program", `Reward ${reward.reward_id} availability is inverted`, 400);
      }
    }
    const visitPolicy = program.visit_stamp_policy;
    const walletPolicy = program.wallet_credit_policy;
    if (units.has("credits") && (
      !walletPolicy ||
      !Number.isInteger(walletPolicy.earn_bps) ||
      walletPolicy.earn_bps <= 0 ||
      walletPolicy.earn_bps > 10_000
    )) {
      throw new EngineError("invalid_program", "Wallet credit policy is invalid", 400);
    }
    if (!units.has("credits") && (walletPolicy || program.balance_expiration)) {
      throw new EngineError("invalid_program", "Wallet credit policy requires a credits account", 400);
    }
    if (program.membership_policy) {
      const planIds = new Set<string>();
      for (const plan of program.membership_policy.plans) {
        if (
          !plan.plan_id ||
          !plan.name ||
          planIds.has(plan.plan_id) ||
          (plan.earn_multiplier_bps !== undefined &&
            (!Number.isInteger(plan.earn_multiplier_bps) || plan.earn_multiplier_bps <= 0))
        ) {
          throw new EngineError("invalid_program", "Membership plans are invalid", 400);
        }
        planIds.add(plan.plan_id);
      }
      if (planIds.size === 0) {
        throw new EngineError("invalid_program", "Membership policy requires a plan", 400);
      }
    }
    const visitUnit = units.has("stamps") ? "stamps" : units.has("visits") ? "visits" : undefined;
    if (visitUnit && (
      !visitPolicy ||
      visitPolicy.unit !== visitUnit ||
      !Number.isInteger(visitPolicy.amount_per_order) ||
      visitPolicy.amount_per_order <= 0 ||
      !Number.isInteger(visitPolicy.threshold) ||
      visitPolicy.threshold <= 0 ||
      !rewardIds.has(visitPolicy.issue_reward_id) ||
      (visitPolicy.issued_reward_ttl_seconds !== undefined &&
        (!Number.isInteger(visitPolicy.issued_reward_ttl_seconds) ||
          visitPolicy.issued_reward_ttl_seconds < 60))
    )) {
      throw new EngineError("invalid_program", "Visit/stamp policy is invalid", 400);
    }
    if (!visitUnit && visitPolicy) {
      throw new EngineError("invalid_program", "Visit/stamp policy requires a visit or stamp account", 400);
    }
  }

  private assertProgramId(programId: string): void {
    if (programId !== this.program.program_id) {
      throw new EngineError("invalid_program", `Program ${programId} is not served here`, 404);
    }
  }

  private activeMember(memberId: string): Member {
    const member = this.members.get(memberId);
    if (!member) {
      throw new EngineError("member_not_found", `Member ${memberId} was not found`, 404);
    }
    if (member.status !== "active") {
      throw new EngineError("member_not_active", `Member ${memberId} is ${member.status}`);
    }
    return member;
  }

  private memberSnapshot(member: Member): Member {
    const snapshot = clone(member);
    const progress = this.tierProgress(this.accountMetrics(member.member_id));
    if (progress) snapshot.tier_id = progress.current_tier_id;
    return snapshot;
  }

  private baseTierId(): string | undefined {
    return [...(this.program.tiers ?? [])]
      .sort((left, right) => left.minimum - right.minimum)[0]?.tier_id;
  }

  private programCatalog(): ProgramCatalog {
    return {
      program_id: this.program.program_id,
      name: this.program.name ?? this.program.program_id,
      ...(this.program.description ? { description: this.program.description } : {}),
      currency: this.program.currency,
      earning: {
        rate: {
          unit: this.primaryUnit(),
          amount: ["visits", "stamps"].includes(this.primaryUnit())
            ? this.program.visit_stamp_policy!.amount_per_order
            : this.primaryUnit() === "credits"
              ? this.program.wallet_credit_policy!.earn_bps
              : this.program.earn_rate.points,
          spend: {
            amount: this.primaryUnit() === "credits"
              ? 10_000
              : this.program.earn_rate.spend_minor_units,
            currency: this.program.currency
          }
        },
        minimum_eligible_spend: {
          amount: this.program.earning_policy?.minimum_eligible_spend_minor_units ?? 0,
          currency: this.program.currency
        },
        eligible_channels: clone(this.program.earning_policy?.eligible_channels ?? allOrderChannels),
        rounding: "after_transaction",
        exclusions: {
          product_ids: clone(this.program.earning_policy?.excluded_product_ids ?? []),
          category_ids: clone(this.program.earning_policy?.excluded_category_ids ?? []),
          tags: clone(this.program.earning_policy?.excluded_tags ?? []),
          line_kinds: clone(this.program.earning_policy?.excluded_line_kinds ?? [])
        }
      },
      account_earning: this.accountUnits().map((unit) => ({
        unit,
        mode: unit === "visits" || unit === "stamps" ? "per_order" as const : "spend" as const,
        amount: unit === "points"
          ? this.program.earn_rate.points
          : unit === "credits"
            ? this.program.wallet_credit_policy!.earn_bps
            : this.program.visit_stamp_policy!.amount_per_order,
        ...(unit === "points"
          ? {
              spend: {
                amount: this.program.earn_rate.spend_minor_units,
                currency: this.program.currency
              }
            }
          : unit === "credits"
            ? { spend: { amount: 10_000, currency: this.program.currency } }
            : {}),
        multiplier_eligible: unit === "points"
      })),
      accounts: clone(this.program.accounts ?? [
        { unit: "points", unit_label: "points", is_primary: true }
      ]),
      metrics: (this.program.metrics ?? []).map(({ source: _source, ...metric }) => clone(metric)),
      tiers: clone(this.program.tiers ?? []),
      ...(this.program.tier_policy ? { tier_policy: clone(this.program.tier_policy) } : {}),
      ...(this.program.point_expiration ? {
        point_expiration: clone(this.program.point_expiration)
      } : {}),
      rewards: this.program.rewards.map((reward) => ({
        reward_id: reward.reward_id,
        name: reward.name ?? reward.reward_id,
        ...(reward.description ? { description: reward.description } : {}),
        ...(reward.image_url ? { image_url: reward.image_url } : {}),
        cost: this.rewardCost(reward),
        effect: clone(reward.effect),
        funding: clone(reward.funding),
        ...(reward.available_from ? { available_from: reward.available_from } : {}),
        ...(reward.available_until ? { available_until: reward.available_until } : {}),
        ...(reward.metadata ? { metadata: clone(reward.metadata) } : {})
      })),
      ...(this.program.metadata || this.program.wallet_credit_policy || this.program.membership_policy
        ? {
            metadata: {
              ...clone(this.program.metadata ?? {}),
              ...(this.program.wallet_credit_policy
                ? {
                    wallet_credit: {
                      liability_classification:
                        this.program.wallet_credit_policy.liability_classification,
                      ...(this.program.balance_expiration
                        ? { expiration: clone(this.program.balance_expiration) }
                        : {})
                    }
                  }
                : {}),
              ...(this.program.membership_policy
                ? { membership: { plans: clone(this.program.membership_policy.plans) } }
                : {})
            }
          }
        : {})
    };
  }

  private accountMetrics(memberId: string): AccountMetric[] {
    const asOf = this.isoNow();
    return (this.program.metrics ?? []).map((metric) => {
      const unit = metric.unit;
      this.assertAccountUnit(unit);
      return {
      metric_id: metric.metric_id,
      unit,
      amount: metric.source === "current_balance"
        ? this.balance(memberId, unit).amount
        : [...this.ledger.values()]
            .filter((entry) =>
              entry.member_id === memberId &&
              entry.unit === metric.unit &&
              ["accrual", "adjustment", "manual"].includes(entry.operation) &&
              (metric.source !== "qualification_earned" ||
                (this.isInCurrentQualificationPeriod(entry.occurred_at) &&
                  (entry.operation !== "manual" || entry.qualifies_for_tier === true)))
            )
            .reduce((sum, entry) => sum + entry.amount, 0),
      as_of: asOf
    };
    });
  }

  private isInCurrentQualificationPeriod(occurredAt: string): boolean {
    const policy = this.program.tier_policy;
    if (!policy) return false;
    const occurred = new Date(occurredAt);
    const now = this.clock.now();
    if (this.qualificationPeriodKey(occurred) !== this.qualificationPeriodKey(now)) return false;
    return !policy.effective_from ||
      this.businessDateInZone(occurred, policy.period.time_zone) >= policy.effective_from;
  }

  private qualificationPeriodKey(date: Date): number {
    const policy = this.program.tier_policy;
    if (!policy) return 0;
    const local = this.localDateParts(date, policy.period.time_zone);
    const afterStart = local.month > policy.period.starts_month ||
      (local.month === policy.period.starts_month && local.day >= policy.period.starts_day);
    return afterStart ? local.year : local.year - 1;
  }

  private businessDateInZone(date: Date, timeZone: string): string {
    const local = this.localDateParts(date, timeZone);
    return `${local.year.toString().padStart(4, "0")}-${local.month.toString().padStart(2, "0")}-${local.day.toString().padStart(2, "0")}`;
  }

  private localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date).map((part) => [part.type, part.value])
    );
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day)
    };
  }

  private tierProgress(metrics: AccountMetric[]): TierProgress | undefined {
    const tiers = [...(this.program.tiers ?? [])].sort((left, right) => left.minimum - right.minimum);
    if (tiers.length === 0) return undefined;
    const metricId = tiers[0]!.qualification_metric_id;
    const amount = Math.max(0, metrics.find((metric) => metric.metric_id === metricId)?.amount ?? 0);
    let currentIndex = 0;
    for (const [index, tier] of tiers.entries()) {
      if (tier.minimum <= amount) currentIndex = index;
    }
    const current = tiers[currentIndex]!;
    const next = tiers[currentIndex + 1];
    if (!next) {
      return {
        current_tier_id: current.tier_id,
        qualification_metric_id: metricId,
        current_amount: amount,
        progress_bps: 10_000,
        is_top_tier: true
      };
    }
    const span = next.minimum - current.minimum;
    return {
      current_tier_id: current.tier_id,
      qualification_metric_id: metricId,
      current_amount: amount,
      next_tier_id: next.tier_id,
      remaining_to_next: Math.max(0, next.minimum - amount),
      progress_bps: Math.min(10_000, Math.floor((amount - current.minimum) * 10_000 / span)),
      is_top_tier: false
    };
  }

  private tierMultiplierBps(memberId: string): number {
    const progress = this.tierProgress(this.accountMetrics(memberId));
    if (!progress) return 10_000;
    return this.program.tiers?.find((tier) => tier.tier_id === progress.current_tier_id)
      ?.earn_multiplier_bps ?? 10_000;
  }

  private earningMultiplierBps(memberId: string): number {
    const tier = this.tierMultiplierBps(memberId);
    const plan = this.activeMembershipPlan(memberId);
    const membership = plan?.earn_multiplier_bps ?? 10_000;
    return Math.floor(tier * membership / 10_000);
  }

  private activeMembershipPlan(memberId: string) {
    const value = this.members.get(memberId)?.attributes?.["membership"];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const membership = value as Record<string, unknown>;
    if (
      membership["status"] !== "active" ||
      typeof membership["plan_id"] !== "string" ||
      typeof membership["valid_until"] !== "string" ||
      Date.parse(membership["valid_until"]) <= this.clock.now().getTime()
    ) {
      return undefined;
    }
    return this.program.membership_policy?.plans.find((plan) =>
      plan.plan_id === membership["plan_id"]
    );
  }

  private membershipUnavailable(reward: RewardDefinition, memberId: string): boolean {
    const required = reward.metadata?.["membership_plan_ids"];
    if (!Array.isArray(required) || required.length === 0) return false;
    const plan = this.activeMembershipPlan(memberId);
    return !plan || !required.includes(plan.plan_id);
  }

  private matchesLedgerQuery(entry: LedgerEntry, request: LedgerListRequest): boolean {
    return entry.member_id === request.member_id &&
      entry.program_id === request.program_id &&
      (!request.account_id || entry.account_id === request.account_id) &&
      (!request.operations || request.operations.includes(entry.operation)) &&
      (!request.occurred_from || entry.occurred_at >= request.occurred_from) &&
      (!request.occurred_until || entry.occurred_at <= request.occurred_until);
  }

  private ledgerQueryFingerprint(request: LedgerListRequest): string {
    return fingerprint({
      member_id: request.member_id,
      program_id: request.program_id,
      account_id: request.account_id,
      operations: request.operations ? [...request.operations].sort() : undefined,
      occurred_from: request.occurred_from,
      occurred_until: request.occurred_until
    });
  }

  private encodeCursor(cursor: LedgerCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url");
  }

  private cursorStart(cursorValue: string, query: string, entries: LedgerEntry[]): number {
    let cursor: LedgerCursor;
    try {
      cursor = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8")) as LedgerCursor;
    } catch {
      throw new EngineError("invalid_cursor", "Ledger cursor is malformed", 400);
    }
    if (cursor.version !== 1 || cursor.query !== query || typeof cursor.entry_id !== "string") {
      throw new EngineError("invalid_cursor", "Ledger cursor does not match this query", 400);
    }
    const index = entries.findIndex((entry) => entry.entry_id === cursor.entry_id);
    if (index < 0) {
      throw new EngineError("invalid_cursor", "Ledger cursor no longer identifies an entry", 400);
    }
    return index + 1;
  }

  private assertOrder(order: EvaluationRequest["order"], member: Member): void {
    const result = validateFoodserviceOrder(order);
    if (!result.ok) {
      throw new EngineError(
        "invalid_order",
        result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
        422
      );
    }
    this.assertProgramId(order.scope.program_id);
    if (order.scope.program_id !== member.program_id) {
      throw new EngineError("conflict", "Order and member belong to different programs");
    }
    if (order.member_id && order.member_id !== member.member_id) {
      throw new EngineError("conflict", "Order is assigned to a different member");
    }
    if (order.totals.total.currency !== this.program.currency) {
      throw new EngineError("currency_mismatch", "Order currency does not match the program");
    }
  }

  private eligibleSpend(order: EvaluationRequest["order"]): number {
    return order.lines
      .filter((line) => this.isEligibleLine(line))
      .reduce((total, line) => total + line.subtotal.amount - line.discount.amount, 0);
  }

  private isEligibleLine(line: EvaluationRequest["order"]["lines"][number]): boolean {
    if (line.loyalty_eligible === false) return false;
    const policy = this.program.earning_policy;
    if (!policy) return true;
    if (policy.excluded_product_ids?.includes(line.product_id)) return false;
    if (policy.excluded_line_kinds?.includes(line.kind)) return false;
    if (line.category_ids?.some((id) => policy.excluded_category_ids?.includes(id))) return false;
    if (line.tags?.some((tag) => policy.excluded_tags?.includes(tag))) return false;
    return true;
  }

  private accountUnits(): ReferenceAccountUnit[] {
    return (this.program.accounts ?? [
      { unit: "points", unit_label: "points", is_primary: true }
    ]).map(({ unit }) => unit as "points" | "visits" | "stamps" | "credits");
  }

  private primaryUnit(): "points" | "visits" | "stamps" | "credits" {
    return (this.program.accounts?.find((account) => account.is_primary)?.unit ?? "points") as
      "points" | "visits" | "stamps" | "credits";
  }

  private assertAccountUnit(unit: LoyaltyUnit): asserts unit is "points" | "visits" | "stamps" | "credits" {
    if (!this.accountUnits().includes(unit as "points" | "visits" | "stamps" | "credits")) {
      throw new EngineError("invalid_program", `Account unit ${unit} is not configured`, 422);
    }
  }

  private accrualAmounts(
    order: EvaluationRequest["order"],
    multiplierBps: number
  ): Array<AccrualAmount & { unit: ReferenceAccountUnit }> {
    const channels = this.program.earning_policy?.eligible_channels ?? allOrderChannels;
    if (!channels.includes(order.channel)) {
      return this.accountUnits().map((unit) => ({ unit, amount: 0 }));
    }
    const spend = this.eligibleSpend(order);
    if (spend < (this.program.earning_policy?.minimum_eligible_spend_minor_units ?? 0)) {
      return this.accountUnits().map((unit) => ({ unit, amount: 0 }));
    }
    return this.accountUnits().map((unit) => ({
      unit,
      amount: this.amountForUnit(unit, spend, multiplierBps)
    }));
  }

  private issueThresholdRewards(memberId: string, context: RequestContext): void {
    const policy = this.program.visit_stamp_policy;
    if (!policy) return;
    const prefix = `stamp-${memberId}-`;
    let issuedCycles = [...this.issuedRewards.keys()].filter((id) => id.startsWith(prefix)).length;
    const eligibleCycles = policy.reset_on_issue
      ? Math.floor(this.balance(memberId, policy.unit).amount / policy.threshold) + issuedCycles
      : Math.floor(
          [...this.ledger.values()]
            .filter((entry) =>
              entry.member_id === memberId &&
              entry.operation === "accrual" &&
              entry.unit === policy.unit
            )
            .reduce((sum, entry) => sum + Math.max(0, entry.amount), 0) / policy.threshold
        );
    while (issuedCycles < eligibleCycles) {
      issuedCycles += 1;
      const issuedRewardId = `${prefix}${issuedCycles}`;
      this.issueReward({
        context: {
          ...context,
          request_id: `${context.request_id}:stamp:${issuedCycles}`,
          idempotency_key: issuedRewardId
        },
        issued_reward_id: issuedRewardId,
        member_id: memberId,
        program_id: this.program.program_id,
        reward_id: policy.issue_reward_id,
        ...(policy.issued_reward_ttl_seconds
          ? { expires_at: this.futureIso(policy.issued_reward_ttl_seconds) }
          : {})
      });
      if (policy.reset_on_issue) {
        this.addLedger({
          member_id: memberId,
          operation: "adjustment",
          unit: policy.unit,
          amount: -policy.threshold,
          adjustment_id: `${issuedRewardId}-reset`,
          reason: "Stamp-card threshold reset",
          qualifies_for_tier: false
        });
      }
    }
  }

  private amountForUnit(
    unit: "points" | "visits" | "stamps" | "credits",
    minorUnits: number,
    multiplierBps = 10_000
  ): number {
    if (unit === "credits") {
      const amount = Number(
        BigInt(Math.max(0, minorUnits)) *
        BigInt(this.program.wallet_credit_policy!.earn_bps) /
        10_000n
      );
      if (!Number.isSafeInteger(amount)) {
        throw new EngineError("invalid_state", "Calculated credit exceeds the safe integer range", 422);
      }
      return amount;
    }
    if (unit === "visits" || unit === "stamps") {
      return this.program.visit_stamp_policy!.amount_per_order;
    }
    const numerator = BigInt(Math.max(0, minorUnits)) *
      BigInt(this.program.earn_rate.points) *
      BigInt(multiplierBps);
    const denominator = BigInt(this.program.earn_rate.spend_minor_units) * 10_000n;
    const amount = Number(numerator / denominator);
    if (!Number.isSafeInteger(amount)) {
      throw new EngineError("invalid_state", "Calculated points exceed the safe integer range", 422);
    }
    return amount;
  }

  private pointsForSignedSpend(
    unit: "points" | "credits",
    minorUnits: number,
    multiplierBps = 10_000
  ): number {
    const magnitude = this.amountForUnit(unit, Math.abs(minorUnits), multiplierBps);
    return minorUnits < 0 ? -magnitude : magnitude;
  }

  private rewardCandidate(reward: RewardDefinition, memberId: string): RewardCandidate {
    const reasons: string[] = [];
    const cost = this.rewardCost(reward);
    if (this.balance(memberId, cost.unit).available < cost.amount) {
      reasons.push("insufficient_balance");
    }
    const windowReason = this.rewardWindowReason(reward);
    if (windowReason) reasons.push(windowReason);
    if (this.membershipUnavailable(reward, memberId)) reasons.push("membership_required");
    return {
      reward_id: reward.reward_id,
      ...(reward.name ? { name: reward.name } : {}),
      status: reasons.length === 0 ? "available" : "unavailable",
      ...(reasons.length > 0 ? { unavailable_reasons: reasons } : {}),
      cost,
      effect: clone(reward.effect),
      funding: this.fundingAllocations(reward)
    };
  }

  private rewardCost(reward: RewardDefinition): {
    unit: "points" | "visits" | "stamps" | "credits";
    amount: number;
  } {
    return clone(reward.cost ?? { unit: this.primaryUnit(), amount: reward.points_cost });
  }

  private rewardWindowReason(
    reward: RewardDefinition
  ): "not_yet_available" | "no_longer_available" | undefined {
    const now = this.clock.now().getTime();
    if (reward.available_from && now < Date.parse(reward.available_from)) {
      return "not_yet_available";
    }
    if (reward.available_until && now > Date.parse(reward.available_until)) {
      return "no_longer_available";
    }
    return undefined;
  }

  private fundingAllocations(reward: RewardDefinition): RewardCandidate["funding"] {
    const value = reward.effect.type === "discount"
      ? reward.effect.amount
      : reward.effect.type === "free_item"
        ? reward.effect.max_value
        : undefined;
    if (!value) {
      return clone(reward.funding);
    }

    const denominator = 10_000n;
    const allocations = reward.funding.map((share, index) => {
      const product = BigInt(value.amount) * BigInt(share.share_bps);
      return {
        index,
        amount: product / denominator,
        remainder: product % denominator,
        tieBreak: `${share.party_type}:${share.party_id}`
      };
    });
    let unallocated = BigInt(value.amount) - allocations.reduce((sum, item) => sum + item.amount, 0n);
    const ranked = [...allocations].sort((left, right) => {
      if (left.remainder !== right.remainder) {
        return left.remainder > right.remainder ? -1 : 1;
      }
      return left.tieBreak.localeCompare(right.tieBreak);
    });
    for (const allocation of ranked) {
      if (unallocated === 0n) break;
      allocation.amount += 1n;
      unallocated -= 1n;
    }

    return reward.funding.map((share, index) => ({
      party_id: share.party_id,
      party_type: share.party_type,
      share_bps: share.share_bps,
      amount: { amount: Number(allocations[index]!.amount), currency: value.currency }
    }));
  }

  private addLedger(input: {
    member_id: string;
    operation: LedgerEntry["operation"];
    unit?: "points" | "visits" | "stamps" | "credits";
    amount: number;
    expires_at?: string;
    related_entry_id?: string;
    order_id?: string;
    location_id?: string;
    adjustment_id?: string;
    reservation_id?: string;
    classification?: LedgerEntry["classification"];
    reason?: string;
    qualifies_for_tier?: boolean;
    create_point_lot?: boolean;
  }): LedgerEntry {
    const unit = input.unit ?? this.primaryUnit();
    const entry: LedgerEntry = {
      entry_id: this.ids("ledger"),
      member_id: input.member_id,
      program_id: this.program.program_id,
      account_id: `${unit}:${input.member_id}`,
      operation: input.operation,
      unit,
      amount: input.amount,
      occurred_at: this.isoNow(),
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.related_entry_id ? { related_entry_id: input.related_entry_id } : {}),
      ...(input.order_id ? { order_id: input.order_id } : {}),
      ...(input.location_id ? { location_id: input.location_id } : {}),
      ...(input.adjustment_id ? { adjustment_id: input.adjustment_id } : {}),
      ...(input.reservation_id ? { reservation_id: input.reservation_id } : {}),
      ...(input.classification ? { classification: input.classification } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.qualifies_for_tier !== undefined
        ? { qualifies_for_tier: input.qualifies_for_tier }
        : {})
    };
    this.ledger.set(entry.entry_id, entry);
    const balanceKey = this.balanceKey(input.member_id, unit);
    this.points.set(balanceKey, (this.points.get(balanceKey) ?? 0) + input.amount);
    if (input.create_point_lot && input.expires_at && input.amount > 0) {
      this.pointLots.set(entry.entry_id, {
        entryId: entry.entry_id,
        memberId: input.member_id,
        remaining: input.amount,
        expiresAt: input.expires_at,
        unit
      });
    }
    return entry;
  }

  private balanceKey(
    memberId: string,
    unit: "points" | "visits" | "stamps" | "credits"
  ): string {
    return unit === this.primaryUnit() ? memberId : `${unit}:${memberId}`;
  }

  private balances(memberId: string): Balance[] {
    return this.accountUnits().map((unit) => this.balance(memberId, unit));
  }

  private balance(
    memberId: string,
    unit: "points" | "visits" | "stamps" | "credits" = this.primaryUnit()
  ): Balance {
    this.expireAllReservations();
    this.expirePointLots(memberId, unit);
    const amount = this.points.get(this.balanceKey(memberId, unit)) ?? 0;
    const reserved = [...this.reservations.values()]
      .filter((reservation) =>
        reservation.member_id === memberId &&
        reservation.status === "reserved" &&
        reservation.cost.unit === unit
      )
      .reduce((sum, reservation) => sum + reservation.cost.amount, 0);
    return {
      account_id: `${unit}:${memberId}`,
      member_id: memberId,
      program_id: this.program.program_id,
      unit,
      amount,
      reserved,
      available: amount - reserved,
      as_of: this.isoNow()
    };
  }

  private expiringBalances(memberId: string): ExpiringBalance[] {
    this.expirePointLots(memberId);
    const grouped = new Map<string, number>();
    for (const lot of this.pointLots.values()) {
      if (lot.memberId === memberId && lot.remaining > 0) {
        const key = `${lot.unit ?? this.primaryUnit()}|${lot.expiresAt}`;
        grouped.set(key, (grouped.get(key) ?? 0) + lot.remaining);
      }
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, amount]) => {
        const [unit, expiresAt] = key.split("|") as [
          "points" | "visits" | "stamps" | "credits",
          string
        ];
        return {
        account_id: `${unit}:${memberId}`,
        unit,
        amount,
        expires_at: expiresAt
      };
      });
  }

  private consumePointLots(
    memberId: string,
    unit: LoyaltyUnit,
    amount: number,
    consumptionId?: string
  ): void {
    let remaining = amount;
    const consumed: ReferencePointLotConsumption[] = [];
    const lots = [...this.pointLots.values()]
      .filter((lot) =>
        lot.memberId === memberId &&
        (lot.unit ?? this.primaryUnit()) === unit &&
        lot.remaining > 0
      )
      .sort((left, right) =>
        left.expiresAt.localeCompare(right.expiresAt) || left.entryId.localeCompare(right.entryId)
      );
    for (const lot of lots) {
      if (remaining === 0) break;
      const consumedAmount = Math.min(lot.remaining, remaining);
      lot.remaining -= consumedAmount;
      remaining -= consumedAmount;
      consumed.push({ entryId: lot.entryId, amount: consumedAmount });
    }
    if (consumptionId && consumed.length > 0) {
      this.pointLotConsumptions.set(consumptionId, consumed);
    }
  }

  private restorePointLots(consumptionId: string): void {
    const consumed = this.pointLotConsumptions.get(consumptionId) ?? [];
    for (const item of consumed) {
      const lot = this.pointLots.get(item.entryId);
      if (!lot) {
        throw new EngineError("not_found", "Point-lot consumption references a missing lot", 500);
      }
      lot.remaining += item.amount;
    }
    this.pointLotConsumptions.delete(consumptionId);
  }

  private expirePointLots(memberId?: string, unit?: LoyaltyUnit): void {
    const now = this.clock.now().getTime();
    const lots = [...this.pointLots.values()]
      .filter((lot) =>
        lot.remaining > 0 &&
        (!memberId || lot.memberId === memberId) &&
        (!unit || (lot.unit ?? this.primaryUnit()) === unit) &&
        Date.parse(lot.expiresAt) <= now
      )
      .sort((left, right) =>
        left.expiresAt.localeCompare(right.expiresAt) || left.entryId.localeCompare(right.entryId)
      );
    for (const lot of lots) {
      const amount = lot.remaining;
      lot.remaining = 0;
      this.addLedger({
        member_id: lot.memberId,
        operation: "expiration",
        unit: (lot.unit ?? this.primaryUnit()) as "points" | "visits" | "stamps" | "credits",
        amount: -amount,
        related_entry_id: lot.entryId
      });
    }
  }

  private getReservation(reservationId: string): RedemptionReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new EngineError("not_found", `Reservation ${reservationId} was not found`, 404);
    }
    return reservation;
  }

  private expireAllReservations(): void {
    for (const reservation of this.reservations.values()) {
      this.expireReservation(reservation);
    }
  }

  private expireIssuedRewards(memberId?: string): void {
    for (const reward of this.issuedRewards.values()) {
      if (!memberId || reward.member_id === memberId) this.expireIssuedReward(reward);
    }
  }

  private expireIssuedReward(reward: IssuedReward): void {
    if (
      reward.status === "issued" &&
      reward.expires_at &&
      Date.parse(reward.expires_at) <= this.clock.now().getTime()
    ) {
      const held = [...this.reservations.values()].some((reservation) =>
        reservation.issued_reward_id === reward.issued_reward_id &&
        reservation.status === "reserved"
      );
      if (!held) reward.status = "expired";
    }
  }

  private expireReservation(reservation: RedemptionReservation): void {
    if (reservation.status === "reserved" && Date.parse(reservation.expires_at) <= this.clock.now().getTime()) {
      reservation.status = "expired";
    }
  }

  private ledgerResponse(
    context: RequestContext,
    entry: LedgerEntry,
    entries: LedgerEntry[] = [entry]
  ): LedgerResponse {
    return {
      context: this.responseContext(context),
      entry: clone(entry),
      ...(entries.length > 1 ? { entries: entries.map(clone) } : {}),
      balances: this.balances(entry.member_id)
    };
  }

  private reservationResponse(
    context: RequestContext,
    reservation: RedemptionReservation
  ): RedemptionReservationResponse {
    return {
      context: this.responseContext(context),
      reservation: clone(reservation),
      balances: this.balances(reservation.member_id)
    };
  }

  private responseContext(context: RequestContext): ResponseContext {
    return {
      protocol_version: "1.0",
      profile: "foodservice/1.0",
      request_id: context.request_id,
      processed_at: this.isoNow()
    };
  }

  private isoNow(): string {
    return this.clock.now().toISOString();
  }

  private futureIso(seconds: number): string {
    return new Date(this.clock.now().getTime() + seconds * 1000).toISOString();
  }

  private pointExpirationIso(unit: LoyaltyUnit = this.primaryUnit()): string {
    const days = this.expirationPolicy(unit)?.days;
    if (!days) throw new EngineError("invalid_program", "Balance expiration is not configured", 500);
    return new Date(this.clock.now().getTime() + days * 86_400_000).toISOString();
  }

  private expirationPolicy(unit: LoyaltyUnit = this.primaryUnit()) {
    if (unit === "points") return this.program.point_expiration;
    if (unit === "credits") return this.program.balance_expiration;
    return undefined;
  }

  private once<T>(
    operation: string,
    context: RequestContext,
    request: unknown,
    run: () => T
  ): T {
    const key = `${context.source.system}|${operation}|${context.idempotency_key}`;
    const prior = this.idempotency.get(key);
    if (prior) {
      const matches =
        prior.fingerprint === idempotencyFingerprintV2(request) ||
        prior.fingerprint === idempotencyFingerprintV1(request);
      if (!matches) {
        throw new EngineError(
          "idempotency_conflict",
          "Idempotency key was already used with a different request"
        );
      }
      return withReplayedRequestId(clone(prior.response as T), context.request_id);
    }

    const response = run();
    this.idempotency.set(key, {
      fingerprint: idempotencyFingerprintV2(request),
      response: clone(response)
    });
    return response;
  }
}
