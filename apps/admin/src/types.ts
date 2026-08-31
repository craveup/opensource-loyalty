export type MemberStatus = "active" | "suspended" | "closed";
export type LedgerOperation = "accrual" | "redemption" | "reversal" | "adjustment" | "expiration" | "manual";
export type ProgramModelId = "points" | "visits" | "wallet_credit" | "paid_membership" | "hybrid";
export type ProgramModelStatus = "active" | "available" | "planned";
export type ProgramModelSupport = "implemented" | "planned";

export interface Balance {
  account_id: string;
  unit: string;
  amount: number;
  reserved: number;
  available: number;
  as_of: string;
}

export interface AccountMetric {
  metric_id: string;
  amount: number;
}

export interface ExpiringBalance {
  account_id: string;
  unit: string;
  amount: number;
  expires_at: string;
}

export interface TierProgress {
  current_tier_id: string;
  qualification_metric_id: string;
  current_amount: number;
  next_tier_id?: string;
  remaining_to_next?: number;
  progress_bps: number;
  is_top_tier: boolean;
}

export interface Member {
  member_id: string;
  status: MemberStatus;
  joined_at: string;
  tier_id?: string;
  attributes?: Record<string, unknown>;
}

export interface AdminMember {
  member: Member;
  balance: Balance;
  balances?: Balance[];
  metrics: AccountMetric[];
  expiring_balances: ExpiringBalance[];
  tier_progress?: TierProgress;
  last_activity_at?: string;
}

export interface LedgerEntry {
  entry_id: string;
  member_id: string;
  operation: LedgerOperation;
  amount: number;
  unit?: string;
  occurred_at: string;
  expires_at?: string;
  related_entry_id?: string;
  order_id?: string;
  adjustment_id?: string;
  reservation_id?: string;
}

export interface TierDefinition {
  tier_id: string;
  name: string;
  minimum: number;
  earn_multiplier_bps?: number;
  benefits: Array<{ benefit_id: string; name: string }>;
}

export interface RewardDefinition {
  reward_id: string;
  name: string;
  description?: string;
  cost: { amount: number; unit: string };
  effect: { type: string; [key: string]: unknown };
  funding: Array<{ party_type: string; party_id: string; share_bps: number }>;
}

export interface ProgramCatalog {
  program_id: string;
  name: string;
  description?: string;
  currency: string;
  earning: {
    rate: { amount: number; unit: string; spend: { amount: number; currency: string } };
    minimum_eligible_spend: { amount: number; currency: string };
    eligible_channels: string[];
    rounding: string;
    exclusions: {
      product_ids: string[];
      category_ids: string[];
      tags: string[];
      line_kinds: string[];
    };
  };
  account_earning?: Array<{
    unit: string;
    mode: "spend" | "per_order";
    amount: number;
    spend?: { amount: number; currency: string };
    multiplier_eligible: boolean;
  }>;
  accounts: Array<{ unit: string; unit_label?: string; is_primary: boolean }>;
  tiers: TierDefinition[];
  rewards: RewardDefinition[];
  point_expiration?: { type: string; days: number; warning_days: number[] };
  tier_policy?: {
    metric_id: string;
    period: { type: string; starts_month: number; starts_day: number; time_zone: string };
  };
  metadata?: Record<string, unknown>;
}

export interface ProgramModelTemplate {
  model_id: ProgramModelId;
  name: string;
  summary: string;
  best_for: string;
  cadence: string;
  status: ProgramModelStatus;
  engine_support: ProgramModelSupport;
  admin_write_support: ProgramModelSupport;
  supported_features: string[];
  blockers: string[];
  next_steps: string[];
}

export interface ProgramConfiguration {
  current_model_id: ProgramModelId;
  editable: boolean;
  publish_supported: boolean;
  templates: ProgramModelTemplate[];
  next_actions: string[];
}

export interface AdminBootstrap {
  admin_api_version: string;
  generated_at: string;
  status: boolean;
  auth: {
    mode: "api_key";
    requires_login: boolean;
    session_cookie: string;
    default_local_key: boolean;
    credential_hint: string;
  };
  session: {
    authenticated: boolean;
  };
  platform: {
    protocol_version: string;
    profile: string;
    storage: { driver: string; location: string; persistent: boolean };
  };
  onboarding: {
    title: string;
    description: string;
    steps: Array<{
      id: string;
      title: string;
      description: string;
      status: "ready" | "next" | "optional";
    }>;
    commands: Array<{ label: string; value: string }>;
  };
  links: {
    admin: string;
    health: string;
    capabilities: string;
    api: string;
  };
}

export interface AdminWebhookDelivery {
  delivery_id: string;
  event_id: string;
  event_type: string;
  url: string;
  attempts: number;
  status?: "delivered" | "failed";
  completed_at?: string;
  last_error?: string;
}

export interface AdminPendingWebhookDelivery extends AdminWebhookDelivery {
  delivery_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProgramValidationResult {
  ok: boolean;
  issues: Array<{ path: string; message: string }>;
}

export interface ProgramManagement {
  active_revision: number;
  active_published_at: string;
  active_published_by: string;
  active_program: Record<string, unknown>;
  draft?: {
    version: number;
    updated_at: string;
    updated_by: string;
    program: unknown;
    validation: ProgramValidationResult;
  };
  history: Array<{
    revision: number;
    published_at: string;
    published_by: string;
    program: Record<string, unknown>;
  }>;
  audit: Array<{
    audit_id: string;
    action: "draft.saved" | "draft.discarded" | "program.published" | "program.rolled_back";
    actor: string;
    occurred_at: string;
    revision?: number;
    draft_version?: number;
  }>;
}

export interface CampaignPlatform {
  segments: Array<{
    segment_id: string;
    name: string;
    mode: "static" | "dynamic";
    member_ids: string[];
    rules?: {
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
      event?: {
        type: string;
        minimum_count?: number;
        within_days?: number;
        minimum_value_minor_units?: number;
      };
    };
    updated_at: string;
  }>;
  campaigns: Array<{
    campaign_id: string;
    name: string;
    reward_id: string;
    segment_id: string;
    status: "draft" | "active" | "paused" | "scheduled" | "completed" | "expired";
    holdout_percent?: number;
    attribution_window_days?: number;
    starts_at?: string;
    ends_at?: string;
    updated_at: string;
    last_run_at?: string;
  }>;
  runs: Array<{
    run_id: string;
    campaign_id: string;
    completed_at: string;
    issued: number;
    skipped: number;
    failed: number;
    holdout: number;
    outcomes: Array<{
      member_id: string;
      status: "issued" | "skipped" | "failed";
      cohort?: "targeted" | "holdout";
    }>;
  }>;
}

export interface CustomerDataPlatform {
  profiles: Array<{
    member_id: string;
    display_name?: string;
    email?: string;
    phone?: string;
    consent: { marketing: boolean; source: string; updated_at: string };
    updated_at: string;
  }>;
  events: Array<{
    event_id: string;
    member_id: string;
    type: string;
    occurred_at: string;
    campaign_id?: string;
    value_minor_units?: number;
    currency?: string;
  }>;
  imports: Array<{
    import_id: string;
    status: "completed" | "partial" | "failed";
    submitted: number;
    created: number;
    updated: number;
    failed: number;
    completed_at: string;
  }>;
}

export type TenantRole =
  "owner" | "admin" | "operator" | "developer" | "viewer" | "integration";

export interface AccessControl {
  tenant: { tenant_id: string; name: string; created_at: string };
  users: Array<{
    user_id: string;
    email: string;
    name?: string;
    role: TenantRole;
    active: boolean;
  }>;
  api_keys: Array<{
    key_id: string;
    name: string;
    prefix: string;
    role: TenantRole;
    active: boolean;
    created_at: string;
    expires_at?: string;
    last_used_at?: string;
    revoked_at?: string;
  }>;
  audit: Array<{
    audit_id: string;
    actor_id: string;
    action: string;
    resource_type: string;
    resource_id?: string;
    request_id?: string;
    occurred_at: string;
  }>;
  role_permissions: Record<TenantRole, string[]>;
}

export interface EngagementPlatform {
  connectors: Array<{
    connector_id: string;
    name: string;
    type: string;
    active: boolean;
    configuration: Record<string, unknown>;
    secret_configured: boolean;
    created_at: string;
    updated_at: string;
  }>;
  jobs: Array<{
    job_id: string;
    connector_id: string;
    segment_id: string;
    template_id: string;
    purpose: "marketing" | "transactional";
    status: "queued" | "running" | "completed" | "partial" | "failed";
    created_at: string;
    completed_at?: string;
    deliveries: Array<{
      delivery_id: string;
      member_id: string;
      status: "pending" | "delivered" | "failed" | "skipped";
      attempts: number;
      error?: string;
    }>;
  }>;
}

export interface EngagementAnalytics {
  generated_at: string;
  members: { total: number; active: number; marketing_consented: number };
  balances: Array<{ unit: string; outstanding: number; reserved: number }>;
  ledger_by_day: Array<{
    date: string;
    unit: string;
    earned: number;
    redeemed: number;
    expired: number;
  }>;
  rewards: Array<{
    reward_id: string;
    reserved: number;
    captured: number;
    reversed: number;
  }>;
  campaigns: {
    configured: number;
    runs: number;
    members_targeted: number;
    rewards_issued: number;
  };
}

export interface AdminSnapshot {
  admin_api_version: string;
  generated_at: string;
  platform: {
    protocol_version: string;
    profile: string;
    storage: { driver: string; location: string; persistent: boolean };
  };
  program: ProgramCatalog;
  program_configuration: ProgramConfiguration;
  program_management?: ProgramManagement;
  campaigns: CampaignPlatform;
  customer_data: CustomerDataPlatform;
  access_control?: AccessControl;
  engagement: EngagementPlatform;
  analytics?: EngagementAnalytics;
  memberships: {
    memberships: Array<{
      member_id: string;
      membership: {
        plan_id: string;
        status: "active" | "lapsed" | "cancelled";
        valid_from: string;
        valid_until: string;
      };
    }>;
    audit: Array<{
      audit_id: string;
      member_id: string;
      action: string;
      occurred_at: string;
      plan_id: string;
    }>;
  };
  webhooks: {
    enabled: boolean;
    subscriptions: Array<{
      subscription_id: string;
      url: string;
      active: boolean;
      events?: string[];
      retry_policy?: { max_attempts: number; backoff_ms: number; timeout_ms: number };
    }>;
    pending: AdminPendingWebhookDelivery[];
    recent: AdminWebhookDelivery[];
  };
  summary: {
    active_members: number;
    points_outstanding: number;
    points_issued: number;
    points_redeemed: number;
    expiring_points: number;
    primary_unit: string;
    primary_balance_outstanding: number;
    primary_balance_issued: number;
    primary_balance_redeemed: number;
    expiring_primary_balance: number;
    ledger_entries: number;
  };
  members: AdminMember[];
  ledger: LedgerEntry[];
  issued_rewards: Array<{
    issued_reward_id: string;
    member_id: string;
    reward_id: string;
    status: "issued" | "redeemed" | "cancelled" | "expired";
    issued_at: string;
    expires_at?: string;
  }>;
}
