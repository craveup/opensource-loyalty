import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  Award,
  BookOpenCheck,
  ChevronRight,
  CircleGauge,
  Coffee,
  CreditCard,
  Database,
  Gift,
  LayoutDashboard,
  LogIn,
  LogOut,
  Megaphone,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
  WalletCards,
  X
} from "lucide-react";
import {
  Badge,
  CommandButton,
  EmptyState,
  IconButton,
  SearchInput,
  Section,
  SelectField,
  Spinner
} from "./components/ui/index.js";
import { formatDate, formatNumber, memberName, percentage } from "./format.js";
import type {
  AdminBootstrap,
  AdminMember,
  AdminSnapshot,
  LedgerEntry,
  LedgerOperation,
  ProgramModelId,
  ProgramModelStatus,
  RewardDefinition,
  TenantRole
} from "./types.js";

type View = "overview" | "members" | "ledger" | "program" | "marketing" | "developer";

const navigation: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "members", label: "Members", icon: Users },
  { id: "ledger", label: "Ledger", icon: BookOpenCheck },
  { id: "program", label: "Configure", icon: Settings2 },
  { id: "marketing", label: "Marketing", icon: Megaphone },
  { id: "developer", label: "API", icon: Database }
];

const modelIcons: Record<ProgramModelId, typeof Gift> = {
  points: Award,
  visits: Coffee,
  wallet_credit: CreditCard,
  paid_membership: ShieldCheck,
  hybrid: Sparkles
};

function displayProgramName(program: AdminSnapshot["program"]): string {
  if (program.program_id === "demo-foodservice") return "Main Loyalty Program";
  return program.name;
}

function metric(member: AdminMember, id: string): number {
  return member.metrics.find((candidate) => candidate.metric_id === id)?.amount ?? 0;
}

function operationLabel(operation: LedgerOperation): string {
  return operation.replace("_", " ");
}

function OperationBadge({ operation }: { operation: LedgerOperation }) {
  return <Badge className={`operation operation-${operation}`}>{operationLabel(operation)}</Badge>;
}

function TierBadge({ tier }: { tier: string | undefined }) {
  return <Badge className={`tier tier-${tier ?? "none"}`}>{tier ?? "None"}</Badge>;
}

function statusTone(status: ProgramModelStatus): "success" | "info" | "muted" {
  if (status === "active") return "success";
  if (status === "available") return "info";
  return "muted";
}

function adminCsrfToken(): string {
  const cookie = document.cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("lip_admin_csrf="));
  return cookie ? decodeURIComponent(cookie.slice("lip_admin_csrf=".length)) : "";
}

async function adminWrite(path: string, method: "PUT" | "POST" | "DELETE", body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-lip-csrf": adminCsrfToken()
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => undefined) as { detail?: string; title?: string } | undefined;
    throw new Error(problem?.detail ?? problem?.title ?? `Admin API returned HTTP ${response.status}`);
  }
  return response.json();
}

function memberSubtitle(member: AdminMember["member"]): string {
  if (typeof member.attributes?.email === "string") return member.attributes.email;
  return member.member_id.replace(/^demo-member-/, "customer-");
}

function Login({ bootstrap, onAuthenticated }: {
  bootstrap: AdminBootstrap | undefined;
  onAuthenticated: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (bootstrap?.auth.default_local_key && apiKey.length === 0) setApiKey("lip-dev-key");
  }, [apiKey.length, bootstrap?.auth.default_local_key]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/admin/api/v1/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey })
      });
      if (!response.ok) throw new Error("The API key was not accepted.");
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const storage = bootstrap?.platform.storage;
  const keySource = bootstrap?.auth.default_local_key
    ? "Default local key: lip-dev-key"
    : "Copy the key from the server startup logs.";

  return (
    <main className="login-page">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-logo"><CircleGauge size={26} aria-hidden="true" /></div>
        <h1 id="login-title">
          {bootstrap?.auth.default_local_key ? "Get started with Loyalty Admin" : "Sign in to Loyalty Admin"}
        </h1>
        <p className="auth-note">
          Local reference server. Sign in with the same key used for Bearer API requests.
        </p>

        <form onSubmit={submit}>
          <label className="visually-hidden" htmlFor="admin-username">Username</label>
          <input
            className="visually-hidden"
            id="admin-username"
            name="username"
            type="text"
            autoComplete="username"
            value="local-admin"
            readOnly
            tabIndex={-1}
          />
          <label htmlFor="api-key">Admin/API key</label>
          <input
            id="api-key"
            name="api-key"
            type="password"
            autoComplete="current-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <p className="input-hint">
            {bootstrap?.auth.credential_hint ?? "Use the key configured for this local reference server."}
          </p>
          <p className="key-source"><code>{keySource}</code></p>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <CommandButton
            disabled={submitting}
            icon={<LogIn size={17} aria-hidden="true" />}
            type="submit"
          >
            {submitting ? "Signing in" : "Sign in"}
          </CommandButton>
        </form>

        <p className="login-meta">
          {bootstrap ? "Server online" : "Checking server"} · Admin API {bootstrap?.admin_api_version ?? "0.2"} · {storage?.driver ?? "local"}
        </p>
      </section>
    </main>
  );
}

function Stat({ label, value, detail, icon: Icon }: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <article className="stat-card">
      <div className="stat-heading"><Icon size={17} aria-hidden="true" /><span>{label}</span></div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function LedgerTable({ entries, members, limit }: {
  entries: LedgerEntry[];
  members: AdminMember[];
  limit?: number;
}) {
  const visible = limit ? entries.slice(0, limit) : entries;
  if (visible.length === 0) return <EmptyState>No ledger entries match this view.</EmptyState>;
  const profiles = new Map(members.map((member) => [member.member.member_id, member.member]));
  return (
    <div className="table-scroll">
      <table className="ledger-table">
        <thead><tr><th>Operation</th><th>Member</th><th className="reference-column">Reference</th><th className="date-column">Date</th><th className="numeric">Amount</th></tr></thead>
        <tbody>
          {visible.map((entry) => (
            <tr key={entry.entry_id}>
              <td><OperationBadge operation={entry.operation} /></td>
              <td>
                <span className="primary-cell">{profiles.get(entry.member_id) ? memberName(profiles.get(entry.member_id)?.attributes, entry.member_id) : entry.member_id}</span>
                <code>{profiles.get(entry.member_id) ? memberSubtitle(profiles.get(entry.member_id)!) : entry.member_id}</code>
              </td>
              <td className="reference-column"><code>{entry.order_id ?? entry.adjustment_id ?? entry.reservation_id ?? entry.related_entry_id ?? entry.entry_id}</code></td>
              <td className="date-column">{formatDate(entry.occurred_at, true)}</td>
              <td className={`numeric amount ${entry.amount >= 0 ? "positive" : "negative"}`}>{entry.amount >= 0 ? "+" : ""}{formatNumber(entry.amount)} {entry.unit ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ snapshot, onViewMembers }: { snapshot: AdminSnapshot; onViewMembers: () => void }) {
  const unit = snapshot.program.earning.rate.unit;
  const tiers = snapshot.program.tiers.map((tier) => ({
    ...tier,
    count: snapshot.members.filter((member) => member.member.tier_id === tier.tier_id).length
  }));
  const maximum = Math.max(...tiers.map((tier) => tier.count), 1);
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Dashboard</p><h2>Loyalty overview</h2></div></div>
      <section className="stats-grid" aria-label="Program totals">
        <Stat label="Active members" value={formatNumber(snapshot.summary.active_members)} detail="Enrolled accounts" icon={Users} />
        <Stat label="Outstanding" value={formatNumber(snapshot.summary.primary_balance_outstanding)} detail={`Posted ${unit}`} icon={WalletCards} />
        <Stat label="Issued" value={formatNumber(snapshot.summary.primary_balance_issued)} detail={`Positive ${unit} ledger value`} icon={Activity} />
        <Stat label="Redeemed" value={formatNumber(snapshot.summary.primary_balance_redeemed)} detail={`${formatNumber(snapshot.summary.expiring_primary_balance)} ${unit} still expiring`} icon={Gift} />
      </section>
      <div className="overview-grid">
        <Section className="tier-distribution" heading="Tier distribution" description="Current annual qualification">
          <div className="tier-bars">
            {tiers.map((tier) => (
              <div className="tier-bar-row" key={tier.tier_id}>
                <div><TierBadge tier={tier.tier_id} /><span>{tier.count}</span></div>
                <div className="bar-track"><span style={{ width: `${Math.max((tier.count / maximum) * 100, tier.count ? 8 : 0)}%` }} /></div>
              </div>
            ))}
          </div>
        </Section>
        <Section className="expiration-panel" heading={unit === "points" ? "Point expiration" : `${unit} policy`} description={unit === "points" ? "Earned-date policy" : "No earned-date expiration"}>
          <div className="expiration-value"><strong>{snapshot.program.point_expiration?.days ?? "—"}</strong><span>days</span></div>
          <dl className="compact-definition">
            <div><dt>Warnings</dt><dd>{snapshot.program.point_expiration?.warning_days.join(", ") ?? "None"} days</dd></div>
            <div><dt>Scheduled</dt><dd>{formatNumber(snapshot.summary.expiring_primary_balance)} {unit}</dd></div>
          </dl>
        </Section>
      </div>
      <Section
        action={<CommandButton icon={<ChevronRight size={15} aria-hidden="true" />} onClick={onViewMembers} variant="text">View members</CommandButton>}
        description={`${formatNumber(snapshot.summary.ledger_entries)} total entries`}
        heading="Recent activity"
      >
        <LedgerTable entries={snapshot.ledger} members={snapshot.members} limit={6} />
      </Section>
    </>
  );
}

function MemberDetail({ member, onClose, unit }: {
  member: AdminMember;
  onClose: () => void;
  unit: string;
}) {
  const qualifying = metric(member, "tier-qualifying");
  return (
    <aside className="member-detail" aria-label="Member details">
      <div className="detail-heading">
        <div><p className="eyebrow">Member</p><h3>{memberName(member.member.attributes, member.member.member_id)}</h3><code>{memberSubtitle(member.member)}</code></div>
        <IconButton label="Close member details" onClick={onClose}><X size={18} /></IconButton>
      </div>
      <div className="detail-balance"><span>Available {unit}</span><strong>{formatNumber(member.balance.available)}</strong><TierBadge tier={member.member.tier_id} /></div>
      {(member.balances?.length ?? 0) > 1 ? (
        <div className="account-balances">
          {member.balances!.map((balance) => (
            <div key={balance.account_id}>
              <span>{balance.unit}</span>
              <strong>{formatNumber(balance.available)}</strong>
              {balance.reserved ? <small>{formatNumber(balance.reserved)} reserved</small> : null}
            </div>
          ))}
        </div>
      ) : null}
      <dl className="detail-list">
        <div><dt>Status</dt><dd>{member.member.status}</dd></div>
        <div><dt>Joined</dt><dd>{formatDate(member.member.joined_at)}</dd></div>
        {member.tier_progress ? <div><dt>Qualifying</dt><dd>{formatNumber(qualifying)} {unit}</dd></div> : null}
        <div><dt>Last activity</dt><dd>{member.last_activity_at ? formatDate(member.last_activity_at, true) : "No activity"}</dd></div>
        <div><dt>Email</dt><dd>{typeof member.member.attributes?.email === "string" ? member.member.attributes.email : "—"}</dd></div>
      </dl>
      {member.tier_progress ? <div className="progress-block">
        <div><span>Tier progress</span><strong>{member.tier_progress ? percentage(member.tier_progress.progress_bps) : "—"}</strong></div>
        <div className="progress-track"><span style={{ width: `${(member.tier_progress?.progress_bps ?? 0) / 100}%` }} /></div>
        <small>{member.tier_progress?.is_top_tier ? "Top tier" : `${formatNumber(member.tier_progress?.remaining_to_next ?? 0)} to ${member.tier_progress?.next_tier_id ?? "next tier"}`}</small>
      </div> : null}
      <div className="expiring-list">
        <h4>Expiring balances</h4>
        {member.expiring_balances.length ? member.expiring_balances.map((balance) => (
          <div key={`${balance.unit}:${balance.expires_at}`}><span>{balance.unit} · {formatDate(balance.expires_at)}</span><strong>{formatNumber(balance.amount)}</strong></div>
        )) : <p>None scheduled</p>}
      </div>
    </aside>
  );
}

function Members({ members, unit }: { members: AdminMember[]; unit: string }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return members;
    return members.filter(({ member }) =>
      member.member_id.toLowerCase().includes(normalized) ||
      memberName(member.attributes, member.member_id).toLowerCase().includes(normalized) ||
      (typeof member.attributes?.email === "string" && member.attributes.email.toLowerCase().includes(normalized))
    );
  }, [members, query]);
  const selected = members.find(({ member }) => member.member_id === selectedId);

  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Accounts</p><h2>Members</h2></div><span className="record-count">{formatNumber(filtered.length)} records</span></div>
      <div className={`members-layout ${selected ? "has-detail" : ""}`}>
        <Section className="member-list-section">
          <div className="toolbar">
            <SearchInput
              aria-label="Search members"
              icon={<Search size={16} aria-hidden="true" />}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search members"
              value={query}
            />
          </div>
          <div className="table-scroll">
            <table className="member-table">
              <thead><tr><th>Member</th><th>Tier</th><th className="status-column">Status</th><th className="date-column">Last activity</th><th className="numeric">Balance</th></tr></thead>
              <tbody>
                {filtered.map((member) => (
                  <tr className={selectedId === member.member.member_id ? "selected-row" : "clickable-row"} key={member.member.member_id} onClick={() => setSelectedId(member.member.member_id)}>
                    <td><span className="primary-cell">{memberName(member.member.attributes, member.member.member_id)}</span><code>{memberSubtitle(member.member)}</code></td>
                    <td><TierBadge tier={member.member.tier_id} /></td>
                    <td className="status-column"><span className={`status status-${member.member.status}`}>{member.member.status}</span></td>
                    <td className="date-column">{member.last_activity_at ? formatDate(member.last_activity_at, true) : "—"}</td>
                    <td className="numeric amount">{formatNumber(member.balance.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 ? <EmptyState>No members match “{query}”.</EmptyState> : null}
        </Section>
        {selected ? <MemberDetail member={selected} onClose={() => setSelectedId(undefined)} unit={unit} /> : null}
      </div>
    </>
  );
}

function Ledger({ snapshot }: { snapshot: AdminSnapshot }) {
  const [operation, setOperation] = useState<LedgerOperation | "all">("all");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => snapshot.ledger.filter((entry) => {
    if (operation !== "all" && entry.operation !== operation) return false;
    const normalized = query.trim().toLowerCase();
    return !normalized || [entry.member_id, entry.entry_id, entry.order_id, entry.adjustment_id]
      .some((value) => value?.toLowerCase().includes(normalized));
  }), [operation, query, snapshot.ledger]);
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Immutable history</p><h2>Ledger</h2></div><span className="record-count">{formatNumber(filtered.length)} entries</span></div>
      <Section>
        <div className="toolbar ledger-toolbar">
          <SearchInput
            aria-label="Search ledger"
            icon={<Search size={16} aria-hidden="true" />}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search references"
            value={query}
          />
          <SelectField value={operation} onChange={(event) => setOperation(event.target.value as LedgerOperation | "all")} aria-label="Filter by operation">
            <option value="all">All operations</option>
            <option value="accrual">Accrual</option><option value="redemption">Redemption</option><option value="reversal">Reversal</option><option value="adjustment">Adjustment</option><option value="expiration">Expiration</option><option value="manual">Manual</option>
          </SelectField>
        </div>
        <LedgerTable entries={filtered} members={snapshot.members} />
      </Section>
    </>
  );
}

function Program({ snapshot, onChanged }: {
  snapshot: AdminSnapshot;
  onChanged: () => Promise<void>;
}) {
  const { program } = snapshot;
  const { program_configuration: configuration } = snapshot;
  const management = snapshot.program_management;
  const [selectedModel, setSelectedModel] = useState<ProgramModelId>(configuration.current_model_id);
  const [programJson, setProgramJson] = useState(() =>
    JSON.stringify(management?.draft?.program ?? management?.active_program ?? {}, null, 2)
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [writeNotice, setWriteNotice] = useState("");
  const [membershipMember, setMembershipMember] = useState("");
  const [membershipPlan, setMembershipPlan] = useState("");
  useEffect(() => {
    setSelectedModel(configuration.current_model_id);
  }, [configuration.current_model_id]);
  useEffect(() => {
    setProgramJson(JSON.stringify(
      management?.draft?.program ?? management?.active_program ?? {},
      null,
      2
    ));
    setDirty(false);
  }, [management?.active_revision, management?.draft?.version]);
  useEffect(() => {
    const value = program.metadata?.membership;
    const plans = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { plans?: Array<{ plan_id: string }> }).plans
      : undefined;
    if (!membershipPlan && plans?.[0]) setMembershipPlan(plans[0].plan_id);
  }, [membershipPlan, program.metadata]);

  async function runWrite(action: () => Promise<void>, success: string) {
    setBusy(true);
    setWriteError("");
    setWriteNotice("");
    try {
      await action();
      setWriteNotice(success);
      await onChanged();
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : "Program update failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(programJson) as unknown;
    } catch {
      setWriteError("Draft must be valid JSON before it can be saved.");
      return;
    }
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/program/draft", "PUT", { program: parsed });
    }, "Draft saved and validated.");
  }

  async function validateDraft() {
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/program/draft/validate", "POST", {});
    }, "Draft validation refreshed.");
  }

  async function discardDraft() {
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/program/draft", "DELETE", {});
    }, "Draft discarded.");
  }

  async function publishDraft() {
    if (!management?.draft) return;
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/program/publish", "POST", {
        expected_draft_version: management.draft!.version
      });
    }, "Program published live.");
  }

  async function rollback(revision: number) {
    if (!window.confirm(`Rollback the live program to revision ${revision}?`)) return;
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/program/rollback", "POST", { revision });
    }, `Program rolled back from revision ${revision}.`);
  }

  async function editReward(reward?: RewardDefinition) {
    const initial = reward
      ? {
          reward_id: reward.reward_id,
          name: reward.name,
          ...(reward.description ? { description: reward.description } : {}),
          points_cost: reward.cost.amount,
          cost: reward.cost,
          effect: reward.effect,
          funding: reward.funding
        }
      : {
          reward_id: "new-reward",
          name: "New reward",
          points_cost: 100,
          cost: {
            unit: program.accounts.find((account) => account.is_primary)?.unit ?? "points",
            amount: 100
          },
          effect: {
            type: "discount",
            amount: { currency: program.currency, amount: 100 },
            allocations: [{ target: "order", amount: { currency: program.currency, amount: 100 } }]
          },
          funding: [{ party_type: "brand", party_id: "brand", share_bps: 10_000 }]
        };
    const value = window.prompt("Edit reward JSON", JSON.stringify(initial, null, 2));
    if (!value) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setWriteError("Reward must be valid JSON.");
      return;
    }
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/program/rewards", "PUT", { reward: parsed });
    }, "Reward saved to the program draft.");
  }

  async function deleteReward(rewardId: string) {
    if (!window.confirm(`Remove ${rewardId} from the program draft?`)) return;
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/program/rewards/delete", "POST", { reward_id: rewardId });
    }, "Reward removed from the program draft.");
  }

  async function grantMembership() {
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/memberships/grant", "POST", {
        member_id: membershipMember,
        plan_id: membershipPlan,
        valid_until: new Date(Date.now() + 365 * 86_400_000).toISOString()
      });
    }, "Membership granted for one year.");
  }

  async function changeMembershipStatus(
    memberId: string,
    status: "lapsed" | "cancelled"
  ) {
    await runWrite(async () => {
      await adminWrite("/admin/api/v1/memberships/status", "POST", {
        member_id: memberId,
        status
      });
    }, `Membership ${status}.`);
  }
  const model = configuration.templates.find((candidate) => candidate.model_id === selectedModel) ??
    configuration.templates.find((candidate) => candidate.model_id === configuration.current_model_id) ??
    configuration.templates[0]!;
  const ModelIcon = modelIcons[model.model_id];
  const exclusions = [
    ...program.earning.exclusions.product_ids,
    ...program.earning.exclusions.category_ids,
    ...program.earning.exclusions.tags,
    ...program.earning.exclusions.line_kinds
  ];
  const membershipValue = program.metadata?.membership;
  const membershipPlans = membershipValue &&
    typeof membershipValue === "object" &&
    !Array.isArray(membershipValue) &&
    Array.isArray((membershipValue as { plans?: unknown }).plans)
    ? (membershipValue as { plans: Array<{ plan_id: string; name: string }> }).plans
    : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Configuration</p>
          <h2>Program builder</h2>
        </div>
        <span className="record-count">Current program · {displayProgramName(program)}</span>
      </div>
      {management ? (
        <Section
          heading={`Published revision ${management.active_revision}`}
          description="Edit a versioned JSON draft. Publishing updates earning, tier, expiration, and reward policy live without changing member balances or ledger history."
        >
          <div className="program-editor">
            <textarea
              aria-label="Program definition JSON"
              onChange={(event) => {
                setProgramJson(event.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              value={programJson}
            />
            <div className="program-editor-actions">
              <CommandButton disabled={busy || !dirty} onClick={() => void saveDraft()}>
                Save draft
              </CommandButton>
              <CommandButton
                disabled={busy || !management.draft || dirty}
                onClick={() => void validateDraft()}
                variant="text"
              >
                Validate
              </CommandButton>
              <CommandButton
                disabled={busy || !management.draft}
                onClick={() => void discardDraft()}
                variant="text"
              >
                Discard
              </CommandButton>
              <CommandButton
                disabled={busy || !management.draft?.validation.ok || dirty}
                onClick={() => void publishDraft()}
              >
                Publish live
              </CommandButton>
              <span className="record-count">
                {management.draft
                  ? `Draft v${management.draft.version} · ${management.draft.validation.ok ? "valid" : "invalid"}`
                  : "No unpublished draft"}
              </span>
            </div>
            {management.draft && !management.draft.validation.ok ? (
              <div className="program-validation" role="alert">
                {management.draft.validation.issues.map((issue) => (
                  <div key={`${issue.path}-${issue.message}`}><code>{issue.path}</code> {issue.message}</div>
                ))}
              </div>
            ) : null}
            {writeError ? <div className="error-banner" role="alert">{writeError}</div> : null}
            {writeNotice ? <div className="program-notice" role="status">{writeNotice}</div> : null}
          </div>
          {management.history.length > 0 ? (
            <div className="program-history">
              <h4>Published history</h4>
              {management.history.map((revision) => (
                <div key={revision.revision}>
                  <span>
                    Revision {revision.revision} · {String(revision.program.name ?? revision.program.program_id)} · {formatDate(revision.published_at, true)}
                  </span>
                  <CommandButton
                    disabled={busy}
                    onClick={() => void rollback(revision.revision)}
                    variant="text"
                  >
                    Roll back
                  </CommandButton>
                </div>
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}
      <section className="config-layout">
        <div className="model-picker">
          <div className="model-picker-heading">
            <div>
              <h3>Choose a program model</h3>
              <p>Server-provided templates show what the reference engine supports now and what is still planned.</p>
            </div>
          </div>
          <div className="program-model-grid">
            {configuration.templates.map((candidate) => {
              const Icon = modelIcons[candidate.model_id];
              const active = candidate.model_id === selectedModel;
              return (
                <button
                  className={`program-model ${active ? "active" : ""} model-${candidate.status}`}
                  key={candidate.model_id}
                  onClick={() => setSelectedModel(candidate.model_id)}
                  type="button"
                >
                  <span className="model-icon"><Icon size={17} aria-hidden="true" /></span>
                  <div className="model-title-row">
                    <strong>{candidate.name}</strong>
                    <Badge tone={statusTone(candidate.status)}>{candidate.status}</Badge>
                  </div>
                  <small>{candidate.summary}</small>
                </button>
              );
            })}
          </div>
        </div>
        <aside className="model-summary">
          <span className="reward-icon"><ModelIcon size={18} aria-hidden="true" /></span>
          <p className="eyebrow">Selected model</p>
          <h3>{model.name}</h3>
          <p>{model.summary}</p>
          <dl>
            <div><dt>Status</dt><dd><Badge tone={statusTone(model.status)}>{model.status}</Badge></dd></div>
            <div><dt>Best for</dt><dd>{model.best_for}</dd></div>
            <div><dt>Cadence</dt><dd>{model.cadence}</dd></div>
            <div><dt>Engine support</dt><dd>{model.engine_support}</dd></div>
            <div><dt>Admin writes</dt><dd>{model.admin_write_support}</dd></div>
          </dl>
          <div className="model-notes">
            <h4>{model.blockers.length ? "Implementation blockers" : "Supported now"}</h4>
            <ul>
              {(model.blockers.length ? model.blockers : model.supported_features).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </aside>
      </section>
      <Section heading="Operator next actions" description="Configuration work owned by the reference Admin API">
        <div className="next-action-list">
          {configuration.next_actions.map((action) => <div key={action}><Settings2 size={15} aria-hidden="true" /><span>{action}</span></div>)}
        </div>
      </Section>
      <section className="policy-band">
        <div className="policy-band-heading">
          <h3>Current policy</h3>
          <p>These values are served by the local loyalty engine.</p>
        </div>
        <dl>
          <div><dt>Earn rate</dt><dd>{program.earning.rate.amount} {program.earning.rate.unit} / ${(program.earning.rate.spend.amount / 100).toFixed(2)}</dd></div>
          <div><dt>Minimum check</dt><dd>${(program.earning.minimum_eligible_spend.amount / 100).toFixed(2)}</dd></div>
          <div><dt>Channels</dt><dd>{program.earning.eligible_channels.join(", ")}</dd></div>
          <div><dt>Rounding</dt><dd>{program.earning.rounding.replace("_", " ")}</dd></div>
          <div><dt>Exclusions</dt><dd>{exclusions.length}</dd></div>
          <div><dt>Tier reset</dt><dd>{program.tier_policy?.period.time_zone ?? "Not configured"}</dd></div>
        </dl>
      </section>
      {(program.account_earning?.length ?? 0) > 1 ? (
        <Section heading="Account earning" description="Each account accrues and expires independently. Reward cards below show which account pays their cost.">
          <div className="account-policy-grid">
            {program.account_earning!.map((earning) => (
              <div key={earning.unit}>
                <strong>{earning.unit}</strong>
                <span>
                  {formatNumber(earning.amount)} per {earning.mode === "per_order"
                    ? "eligible order"
                    : `${formatNumber(earning.spend?.amount ?? 0)} minor spend units`}
                </span>
                <small>{earning.multiplier_eligible ? "Tier and membership multipliers apply" : "No earn multiplier"}</small>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      <Section heading="Tiers" description="Annual qualification thresholds">
        <div className="table-scroll"><table><thead><tr><th>Tier</th><th>Threshold</th><th>Earn multiplier</th><th>Benefits</th></tr></thead><tbody>
          {program.tiers.map((tier) => <tr key={tier.tier_id}><td><TierBadge tier={tier.tier_id} /></td><td>{formatNumber(tier.minimum)} points</td><td>{percentage(tier.earn_multiplier_bps ?? 10_000)}</td><td>{tier.benefits.map((benefit) => benefit.name).join(", ") || "—"}</td></tr>)}
        </tbody></table></div>
      </Section>
      <Section heading="Rewards" description={`${program.rewards.length} configured rewards`}>
        <div className="program-editor-actions">
          <CommandButton disabled={busy} onClick={() => void editReward()}>Add reward</CommandButton>
          <span className="record-count">Changes are saved to the current draft and require publish.</span>
        </div>
        <div className="reward-grid">
          {program.rewards.map((reward) => (
            <article className="reward-card" key={reward.reward_id}>
              <div><span className="reward-icon"><Gift size={17} /></span><div><h4>{reward.name}</h4><p>{reward.description ?? reward.effect.type.replace("_", " ")}</p></div></div>
              <strong>{formatNumber(reward.cost.amount)} {reward.cost.unit}</strong>
              <small>{reward.funding.map((share) => `${share.party_type} ${percentage(share.share_bps)}`).join(" · ")}</small>
              <div className="reward-actions">
                <CommandButton disabled={busy} onClick={() => void editReward(reward)} variant="text">Edit</CommandButton>
                <CommandButton disabled={busy} onClick={() => void deleteReward(reward.reward_id)} variant="text">Delete</CommandButton>
              </div>
            </article>
          ))}
        </div>
      </Section>
      {membershipPlans.length > 0 ? (
        <Section
          heading="Paid memberships"
          description="Grant plan entitlements after a billing provider confirms payment, or end them when billing lapses."
        >
          <div className="membership-form">
            <input
              onChange={(event) => setMembershipMember(event.target.value)}
              placeholder="Member id"
              value={membershipMember}
            />
            <select onChange={(event) => setMembershipPlan(event.target.value)} value={membershipPlan}>
              {membershipPlans.map((plan) => (
                <option key={plan.plan_id} value={plan.plan_id}>{plan.name}</option>
              ))}
            </select>
            <CommandButton
              disabled={busy || !membershipMember || !membershipPlan}
              onClick={() => void grantMembership()}
            >
              Grant one year
            </CommandButton>
          </div>
          <div className="campaign-list">
            {snapshot.memberships.memberships.map(({ member_id: memberId, membership }) => (
              <div key={memberId}>
                <span>
                  <strong>{memberId}</strong>
                  {membership.plan_id} · {membership.status} · through {formatDate(membership.valid_until)}
                </span>
                {membership.status === "active" ? (
                  <div className="reward-actions">
                    <CommandButton disabled={busy} onClick={() => void changeMembershipStatus(memberId, "lapsed")} variant="text">Lapse</CommandButton>
                    <CommandButton disabled={busy} onClick={() => void changeMembershipStatus(memberId, "cancelled")} variant="text">Cancel</CommandButton>
                  </div>
                ) : null}
              </div>
            ))}
            {snapshot.memberships.memberships.length === 0 ? <EmptyState>No memberships granted.</EmptyState> : null}
          </div>
        </Section>
      ) : null}
    </>
  );
}

function Marketing({ snapshot, onChanged }: {
  snapshot: AdminSnapshot;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [segmentMode, setSegmentMode] = useState<"static" | "dynamic">("dynamic");
  const [segmentName, setSegmentName] = useState("");
  const [segmentMembers, setSegmentMembers] = useState("");
  const [segmentConsent, setSegmentConsent] = useState<"any" | "yes" | "no">("yes");
  const [segmentEvent, setSegmentEvent] = useState("visit.completed");
  const [segmentEventCount, setSegmentEventCount] = useState(1);
  const [segmentEventDays, setSegmentEventDays] = useState(30);
  const [previews, setPreviews] = useState<Record<string, {
    estimated_size: number;
    sample_member_ids: string[];
  }>>({});
  const [campaignName, setCampaignName] = useState("");
  const [campaignSegment, setCampaignSegment] = useState(
    snapshot.campaigns.segments[0]?.segment_id ?? ""
  );
  const [campaignReward, setCampaignReward] = useState(
    snapshot.program.rewards[0]?.reward_id ?? ""
  );
  const [campaignHoldout, setCampaignHoldout] = useState(0);
  const [campaignWindow, setCampaignWindow] = useState(7);
  const [campaignStartsAt, setCampaignStartsAt] = useState("");

  useEffect(() => {
    if (!campaignSegment && snapshot.campaigns.segments[0]) {
      setCampaignSegment(snapshot.campaigns.segments[0].segment_id);
    }
  }, [campaignSegment, snapshot.campaigns.segments]);

  async function runWrite(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Marketing update failed");
    } finally {
      setBusy(false);
    }
  }

  async function createSegment() {
    const staticIds = segmentMembers.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    const profile = segmentConsent === "any"
      ? undefined
      : { marketing_consent: segmentConsent === "yes" };
    const event = segmentEvent.trim()
      ? {
          type: segmentEvent.trim(),
          minimum_count: Math.max(1, segmentEventCount),
          within_days: Math.max(1, segmentEventDays)
        }
      : undefined;
    await runWrite(() => adminWrite("/admin/api/v1/segments", "PUT", {
      name: segmentName,
      ...(segmentMode === "static"
        ? { member_ids: staticIds }
        : { rules: { ...(profile ? { profile } : {}), ...(event ? { event } : {}) } })
    }), "Segment saved. Preview it before launching a campaign.");
    setSegmentName("");
    setSegmentMembers("");
  }

  async function previewSegment(segmentId: string) {
    setBusy(true);
    setError("");
    try {
      const preview = await adminWrite(
        "/admin/api/v1/segments/preview",
        "POST",
        { segment_id: segmentId, sample_size: 8 }
      ) as { estimated_size: number; sample_member_ids: string[] };
      setPreviews((current) => ({ ...current, [segmentId]: preview }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Segment preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function createCampaign() {
    await runWrite(() => adminWrite("/admin/api/v1/campaigns", "PUT", {
      name: campaignName,
      segment_id: campaignSegment,
      reward_id: campaignReward,
      holdout_percent: campaignHoldout,
      attribution_window_days: campaignWindow,
      ...(campaignStartsAt
        ? { starts_at: new Date(campaignStartsAt).toISOString() }
        : {})
    }), "Campaign draft saved. Activate it when the audience and reward are ready.");
    setCampaignName("");
  }

  async function setCampaignStatus(campaignId: string, status: "active" | "paused") {
    await runWrite(
      () => adminWrite("/admin/api/v1/campaigns/status", "POST", {
        campaign_id: campaignId,
        status
      }),
      status === "active" ? "Campaign activated." : "Campaign paused."
    );
  }

  async function runCampaign(campaignId: string, audience: number | undefined) {
    const size = audience === undefined ? "the resolved audience" : `${audience} resolved members`;
    if (!window.confirm(`Issue this campaign reward to ${size}? Holdout members will be skipped.`)) return;
    await runWrite(
      () => adminWrite("/admin/api/v1/campaigns/run", "POST", { campaign_id: campaignId }),
      "Campaign run completed."
    );
  }

  const campaignEvents = snapshot.customer_data.events.filter(({ campaign_id }) => Boolean(campaign_id));
  const attributedValue = campaignEvents.reduce(
    (total, event) => total + (event.value_minor_units ?? 0),
    0
  );

  return (
    <>
      <div className="page-heading">
        <div><p className="eyebrow">Audience and activation</p><h2>Marketing</h2></div>
        <span className="record-count">{formatNumber(snapshot.campaigns.campaigns.length)} campaigns</span>
      </div>
      <Section description="Customer profiles and events live in /platform/v1; checkout transactions remain in /lip/v1.">
        <div className="analytics-grid marketing-summary">
          <div><span>Profiles</span><strong>{formatNumber(snapshot.customer_data.profiles.length)}</strong></div>
          <div><span>Consented</span><strong>{formatNumber(snapshot.customer_data.profiles.filter(({ consent }) => consent.marketing).length)}</strong></div>
          <div><span>Events</span><strong>{formatNumber(snapshot.customer_data.events.length)}</strong></div>
          <div><span>Attributed value</span><strong>{formatNumber(attributedValue)}</strong><small>minor currency units</small></div>
        </div>
      </Section>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {notice ? <div className="notice-banner" role="status">{notice}</div> : null}
      <Section
        heading="1. Build an audience"
        description="Use a fixed member list or rules based on consent and first-party events."
      >
        <div className="campaign-forms marketing-builder">
          <div>
            <label>Segment name<input value={segmentName} onChange={(event) => setSegmentName(event.target.value)} placeholder="Recent opted-in guests" /></label>
            <label>Audience type<select value={segmentMode} onChange={(event) => setSegmentMode(event.target.value as "static" | "dynamic")}><option value="dynamic">Rules</option><option value="static">Member list</option></select></label>
            {segmentMode === "static" ? (
              <label>Member ids<textarea rows={4} value={segmentMembers} onChange={(event) => setSegmentMembers(event.target.value)} placeholder={"member-001\nmember-002"} /></label>
            ) : (
              <>
                <label>Marketing consent<select value={segmentConsent} onChange={(event) => setSegmentConsent(event.target.value as "any" | "yes" | "no")}><option value="yes">Opted in</option><option value="no">Opted out</option><option value="any">Any status</option></select></label>
                <label>Event type<input value={segmentEvent} onChange={(event) => setSegmentEvent(event.target.value)} placeholder="purchase.completed" /></label>
                <div className="compact-fields">
                  <label>At least<input min={1} type="number" value={segmentEventCount} onChange={(event) => setSegmentEventCount(Number(event.target.value))} /></label>
                  <label>Within days<input min={1} type="number" value={segmentEventDays} onChange={(event) => setSegmentEventDays(Number(event.target.value))} /></label>
                </div>
              </>
            )}
            <CommandButton
              disabled={busy || !segmentName || (segmentMode === "static" ? !segmentMembers.trim() : !segmentEvent.trim() && segmentConsent === "any")}
              onClick={() => void createSegment()}
            >Save audience</CommandButton>
          </div>
          <div className="audience-list">
            <h4>Saved audiences</h4>
            {snapshot.campaigns.segments.map((segment) => (
              <article key={segment.segment_id}>
                <div><strong>{segment.name}</strong><small>{segment.mode === "dynamic" ? "Rule-based" : `${segment.member_ids.length} fixed members`}</small></div>
                <CommandButton disabled={busy} variant="text" onClick={() => void previewSegment(segment.segment_id)}>Preview</CommandButton>
                {previews[segment.segment_id] ? <p><strong>{previews[segment.segment_id]!.estimated_size}</strong> matches · {previews[segment.segment_id]!.sample_member_ids.join(", ") || "No sample"}</p> : null}
              </article>
            ))}
            {snapshot.campaigns.segments.length === 0 ? <EmptyState>No audiences yet.</EmptyState> : null}
          </div>
        </div>
      </Section>
      <Section
        heading="2. Configure a campaign"
        description="Choose an audience and reward, set an optional holdout, then schedule or activate."
      >
        <div className="campaign-forms campaign-builder">
          <div>
            <label>Campaign name<input value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="Return visit reward" /></label>
            <label>Audience<select value={campaignSegment} onChange={(event) => setCampaignSegment(event.target.value)}><option value="">Choose audience</option>{snapshot.campaigns.segments.map((segment) => <option key={segment.segment_id} value={segment.segment_id}>{segment.name}</option>)}</select></label>
            <label>Reward<select value={campaignReward} onChange={(event) => setCampaignReward(event.target.value)}>{snapshot.program.rewards.map((reward) => <option key={reward.reward_id} value={reward.reward_id}>{reward.name}</option>)}</select></label>
          </div>
          <div>
            <div className="compact-fields">
              <label>Holdout %<input max={90} min={0} type="number" value={campaignHoldout} onChange={(event) => setCampaignHoldout(Number(event.target.value))} /></label>
              <label>Attribution days<input max={90} min={1} type="number" value={campaignWindow} onChange={(event) => setCampaignWindow(Number(event.target.value))} /></label>
            </div>
            <label>Schedule start<input type="datetime-local" value={campaignStartsAt} onChange={(event) => setCampaignStartsAt(event.target.value)} /></label>
            <CommandButton disabled={busy || !campaignName || !campaignSegment || !campaignReward} onClick={() => void createCampaign()}>Save campaign draft</CommandButton>
          </div>
        </div>
      </Section>
      <Section heading="3. Launch and measure" description="Run history and first-party conversion events stay attached to each campaign.">
        <div className="campaign-list campaign-operations">
          {snapshot.campaigns.campaigns.map((campaign) => {
            const segment = snapshot.campaigns.segments.find(({ segment_id }) => segment_id === campaign.segment_id);
            const preview = previews[campaign.segment_id];
            const runs = snapshot.campaigns.runs.filter(({ campaign_id }) => campaign_id === campaign.campaign_id);
            const issued = runs.reduce((total, run) => total + run.issued, 0);
            const holdout = runs.reduce((total, run) => total + (run.holdout ?? 0), 0);
            const conversions = campaignEvents.filter(({ campaign_id }) => campaign_id === campaign.campaign_id);
            return (
              <article key={campaign.campaign_id}>
                <div className="campaign-title"><strong>{campaign.name}</strong><Badge>{campaign.status}</Badge></div>
                <p>{segment?.name ?? campaign.segment_id} · {campaign.reward_id} · {campaign.holdout_percent ?? 0}% holdout · {campaign.attribution_window_days ?? 7}-day attribution</p>
                <div className="campaign-metrics"><span><strong>{issued}</strong> issued</span><span><strong>{holdout}</strong> holdout</span><span><strong>{conversions.length}</strong> conversions</span></div>
                <div className="reward-actions">
                  {campaign.status === "active" || campaign.status === "scheduled" ? <CommandButton disabled={busy} variant="text" onClick={() => void setCampaignStatus(campaign.campaign_id, "paused")}>Pause</CommandButton> : null}
                  {campaign.status === "draft" || campaign.status === "paused" ? <CommandButton disabled={busy} variant="text" onClick={() => void setCampaignStatus(campaign.campaign_id, "active")}>Activate</CommandButton> : null}
                  {["active", "scheduled"].includes(campaign.status) ? <CommandButton disabled={busy} onClick={() => void runCampaign(campaign.campaign_id, preview?.estimated_size)}>Run now</CommandButton> : null}
                </div>
              </article>
            );
          })}
          {snapshot.campaigns.campaigns.length === 0 ? <EmptyState>No campaigns yet.</EmptyState> : null}
        </div>
      </Section>
    </>
  );
}

function Developer({ snapshot, onChanged }: {
  snapshot: AdminSnapshot;
  onChanged: () => Promise<void>;
}) {
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookError, setWebhookError] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userRole, setUserRole] = useState<TenantRole>("operator");
  const [keyName, setKeyName] = useState("");
  const [keyRole, setKeyRole] = useState<TenantRole>("integration");
  const [generatedKey, setGeneratedKey] = useState("");
  const [engagementBusy, setEngagementBusy] = useState(false);
  const [engagementError, setEngagementError] = useState("");
  const [connectorName, setConnectorName] = useState("");
  const [connectorUrl, setConnectorUrl] = useState("");
  const [connectorSecret, setConnectorSecret] = useState("");
  const [messageConnector, setMessageConnector] = useState(
    snapshot.engagement.connectors[0]?.connector_id ?? ""
  );
  const [messageSegment, setMessageSegment] = useState(
    snapshot.campaigns.segments[0]?.segment_id ?? ""
  );
  const [messageTemplate, setMessageTemplate] = useState("loyalty-update");
  const [messageText, setMessageText] = useState("");
  const subscriptions = snapshot.webhooks.subscriptions ?? [];
  const access = snapshot.access_control;
  const analytics = snapshot.analytics;
  const tenantRoles: TenantRole[] = [
    "owner", "admin", "operator", "developer", "viewer", "integration"
  ];
  async function webhookWrite(path: string, body: unknown, method: "PUT" | "POST" = "POST") {
    setWebhookBusy(true);
    setWebhookError("");
    try {
      await adminWrite(path, method, body);
      await onChanged();
    } catch (cause) {
      setWebhookError(cause instanceof Error ? cause.message : "Webhook update failed");
    } finally {
      setWebhookBusy(false);
    }
  }
  async function accessWrite<T>(
    path: string,
    body: unknown,
    method: "PUT" | "POST" = "POST"
  ): Promise<T | undefined> {
    setAccessBusy(true);
    setAccessError("");
    try {
      const result = await adminWrite(path, method, body) as T;
      await onChanged();
      return result;
    } catch (cause) {
      setAccessError(cause instanceof Error ? cause.message : "Access update failed");
      return undefined;
    } finally {
      setAccessBusy(false);
    }
  }
  async function engagementWrite<T>(
    path: string,
    body: unknown,
    method: "PUT" | "POST" = "POST"
  ): Promise<T | undefined> {
    setEngagementBusy(true);
    setEngagementError("");
    try {
      const result = await adminWrite(path, method, body) as T;
      await onChanged();
      return result;
    } catch (cause) {
      setEngagementError(cause instanceof Error ? cause.message : "Engagement update failed");
      return undefined;
    } finally {
      setEngagementBusy(false);
    }
  }
  useEffect(() => {
    if (!messageConnector && snapshot.engagement.connectors[0]) {
      setMessageConnector(snapshot.engagement.connectors[0].connector_id);
    }
    if (!messageSegment && snapshot.campaigns.segments[0]) {
      setMessageSegment(snapshot.campaigns.segments[0].segment_id);
    }
  }, [
    messageConnector,
    messageSegment,
    snapshot.campaigns.segments,
    snapshot.engagement.connectors
  ]);
  const webhookRows = [
    ...snapshot.webhooks.pending.map((delivery) => ({
      key: delivery.delivery_id,
      eventType: delivery.event_type,
      url: delivery.url,
      attempts: delivery.attempts,
      status: "Pending",
      timestamp: delivery.updated_at,
      error: delivery.last_error
    })),
    ...snapshot.webhooks.recent.map((delivery, index) => ({
      key: delivery.delivery_id || `${delivery.event_id}-${delivery.url}-${index}`,
      eventType: delivery.event_type,
      url: delivery.url,
      attempts: delivery.attempts,
      status: delivery.status === "delivered" ? "Delivered" : "Failed",
      timestamp: delivery.completed_at ?? snapshot.generated_at,
      error: delivery.last_error
    }))
  ];
  const rows = [
    ["Protocol", snapshot.platform.protocol_version],
    ["Profile", snapshot.platform.profile],
    ["Admin API", snapshot.admin_api_version],
    ["Public API", `${window.location.origin}/lip/v1`],
    ["Discovery", `${window.location.origin}/.well-known/lip`],
    ["Storage driver", snapshot.platform.storage.driver],
    ["Storage location", snapshot.platform.storage.location],
    ["Webhook delivery", snapshot.webhooks.enabled ? "Enabled" : "Disabled"],
    ["Webhook outbox", `${snapshot.webhooks.pending.length} pending`],
    ["Snapshot generated", formatDate(snapshot.generated_at, true)]
  ];
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Developer</p><h2>API status</h2></div></div>
      <Section className="developer-status">
        <div className="status-banner"><span className="status-icon"><ShieldCheck size={19} /></span><div><h3>Local API online</h3><p>{snapshot.platform.storage.persistent ? "Durable state enabled" : "Ephemeral state"}</p></div><span className="live-indicator">Healthy</span></div>
        <dl className="developer-list">
          {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
        </dl>
      </Section>
      <Section className="capability-grid">
        <div><Database size={18} /><span>Persistence</span><strong>{snapshot.platform.storage.persistent ? "SQLite WAL" : "Memory"}</strong></div>
        <div><ShieldCheck size={18} /><span>Admin session</span><strong>HttpOnly cookie</strong></div>
        <div><CircleGauge size={18} /><span>Loyalty API</span><strong>15 operations</strong></div>
      </Section>
      {analytics ? (
        <Section
          heading="Analytics and CRM export"
          description="Operational aggregates are calculated from the ledger, reservations, campaigns, and consent flags."
        >
          <div className="analytics-grid">
            <div><span>Active members</span><strong>{formatNumber(analytics.members.active)}</strong></div>
            <div><span>Marketing consent</span><strong>{formatNumber(analytics.members.marketing_consented)}</strong></div>
            <div><span>Campaign runs</span><strong>{formatNumber(analytics.campaigns.runs)}</strong></div>
            <div><span>Rewards issued</span><strong>{formatNumber(analytics.campaigns.rewards_issued)}</strong></div>
          </div>
          <div className="analytics-balances">
            {analytics.balances.map((balance) => (
              <div key={balance.unit}>
                <strong>{formatNumber(balance.outstanding)} {balance.unit}</strong>
                <span>{formatNumber(balance.reserved)} reserved</span>
              </div>
            ))}
          </div>
          <div className="program-editor-actions">
            <CommandButton
              onClick={() => window.open("/admin/api/v1/exports/members?format=csv", "_blank")}
              variant="text"
            >
              Export consented CSV
            </CommandButton>
            <CommandButton
              onClick={() => window.open(
                "/admin/api/v1/exports/members?format=json&include_unconsented=true",
                "_blank"
              )}
              variant="text"
            >
              Export operational JSON
            </CommandButton>
          </div>
        </Section>
      ) : null}
      <Section
        heading="Messaging connectors"
        description="Queue consent-aware segment messages through signed connector adapters with idempotency and retry."
      >
        <div className="engagement-forms">
          <div>
            <h4>Webhook connector</h4>
            <input onChange={(event) => setConnectorName(event.target.value)} placeholder="CRM webhook" value={connectorName} />
            <input onChange={(event) => setConnectorUrl(event.target.value)} placeholder="https://crm.example/messages" type="url" value={connectorUrl} />
            <input onChange={(event) => setConnectorSecret(event.target.value)} placeholder="Signing secret (16+ characters)" type="password" value={connectorSecret} />
            <CommandButton
              disabled={engagementBusy || !connectorName || !connectorUrl || connectorSecret.length < 16}
              onClick={() => void (async () => {
                const created = await engagementWrite<{ connector_id: string }>(
                  "/admin/api/v1/engagement/connectors",
                  {
                    name: connectorName,
                    type: "webhook",
                    configuration: { url: connectorUrl },
                    secret: connectorSecret
                  },
                  "PUT"
                );
                if (created) {
                  setConnectorSecret("");
                  setMessageConnector(created.connector_id);
                }
              })()}
            >
              Save connector
            </CommandButton>
          </div>
          <div>
            <h4>Segment message</h4>
            <select onChange={(event) => setMessageConnector(event.target.value)} value={messageConnector}>
              <option value="">Choose connector</option>
              {snapshot.engagement.connectors.filter(({ active }) => active).map((connector) => (
                <option key={connector.connector_id} value={connector.connector_id}>{connector.name}</option>
              ))}
            </select>
            <select onChange={(event) => setMessageSegment(event.target.value)} value={messageSegment}>
              <option value="">Choose segment</option>
              {snapshot.campaigns.segments.map((segment) => (
                <option key={segment.segment_id} value={segment.segment_id}>{segment.name}</option>
              ))}
            </select>
            <input onChange={(event) => setMessageTemplate(event.target.value)} placeholder="Template id" value={messageTemplate} />
            <textarea onChange={(event) => setMessageText(event.target.value)} placeholder="Message text" value={messageText} />
            <CommandButton
              disabled={engagementBusy || !messageConnector || !messageSegment || !messageTemplate || !messageText}
              onClick={() => void engagementWrite(
                "/admin/api/v1/engagement/messages",
                {
                  idempotency_key: `admin-${Date.now()}`,
                  connector_id: messageConnector,
                  segment_id: messageSegment,
                  template_id: messageTemplate,
                  content: { text: messageText },
                  purpose: "marketing"
                }
              )}
            >
              Queue message
            </CommandButton>
          </div>
        </div>
        {engagementError ? <div className="error-banner" role="alert">{engagementError}</div> : null}
        <div className="engagement-list">
          {snapshot.engagement.connectors.map((connector) => (
            <div key={connector.connector_id}>
              <span>
                <strong>{connector.name}</strong>
                {connector.type} · {connector.active ? "active" : "inactive"} · secret {connector.secret_configured ? "set" : "missing"}
              </span>
              <CommandButton
                disabled={engagementBusy}
                onClick={() => void engagementWrite(
                  "/admin/api/v1/engagement/connectors/delete",
                  { connector_id: connector.connector_id }
                )}
                variant="text"
              >
                Remove
              </CommandButton>
            </div>
          ))}
          {snapshot.engagement.jobs.slice(0, 8).map((job) => (
            <div key={job.job_id}>
              <span>
                <strong>{job.template_id}</strong>
                {job.status} · {job.deliveries.filter(({ status }) => status === "delivered").length}/{job.deliveries.length} delivered
              </span>
              {["queued", "partial"].includes(job.status) ? (
                <CommandButton
                  disabled={engagementBusy}
                  onClick={() => void engagementWrite(
                    "/admin/api/v1/engagement/messages/run",
                    { job_id: job.job_id }
                  )}
                  variant="text"
                >
                  Run now
                </CommandButton>
              ) : null}
            </div>
          ))}
        </div>
      </Section>
      {access ? (
        <Section
          heading={`Tenant access · ${access.tenant.name}`}
          description="Scoped users and machine keys are isolated to this program tenant. API key secrets are shown once."
        >
          <div className="access-forms">
            <div>
              <h4>Add or update user</h4>
              <input
                onChange={(event) => setUserEmail(event.target.value)}
                placeholder="operator@example.com"
                type="email"
                value={userEmail}
              />
              <select
                onChange={(event) => setUserRole(event.target.value as TenantRole)}
                value={userRole}
              >
                {tenantRoles.filter((role) => role !== "integration").map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
              <CommandButton
                disabled={accessBusy || !userEmail}
                onClick={() => void accessWrite(
                  "/admin/api/v1/access/users",
                  { email: userEmail, role: userRole },
                  "PUT"
                )}
              >
                Save user
              </CommandButton>
            </div>
            <div>
              <h4>Create machine key</h4>
              <input
                onChange={(event) => setKeyName(event.target.value)}
                placeholder="Mobile BFF"
                value={keyName}
              />
              <select
                onChange={(event) => setKeyRole(event.target.value as TenantRole)}
                value={keyRole}
              >
                {tenantRoles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <CommandButton
                disabled={accessBusy || !keyName}
                onClick={() => void (async () => {
                  const created = await accessWrite<{ secret: string }>(
                    "/admin/api/v1/access/api-keys",
                    { name: keyName, role: keyRole }
                  );
                  if (created) setGeneratedKey(created.secret);
                })()}
              >
                Create key
              </CommandButton>
            </div>
          </div>
          {generatedKey ? (
            <div className="generated-key" role="status">
              <strong>Copy this key now</strong>
              <code>{generatedKey}</code>
              <CommandButton onClick={() => setGeneratedKey("")} variant="text">Dismiss</CommandButton>
            </div>
          ) : null}
          {accessError ? <div className="error-banner" role="alert">{accessError}</div> : null}
          <div className="access-lists">
            <div>
              <h4>Users</h4>
              {access.users.map((user) => (
                <div key={user.user_id}>
                  <span><strong>{user.email}</strong>{user.role} · {user.active ? "active" : "disabled"}</span>
                </div>
              ))}
              {access.users.length === 0 ? <p className="record-count">No tenant users.</p> : null}
            </div>
            <div>
              <h4>Machine keys</h4>
              {access.api_keys.map((key) => (
                <div key={key.key_id}>
                  <span>
                    <strong>{key.name}</strong>
                    {key.prefix}… · {key.role} · {key.active ? "active" : "revoked"}
                  </span>
                  {key.active ? (
                    <CommandButton
                      disabled={accessBusy}
                      onClick={() => void accessWrite(
                        "/admin/api/v1/access/api-keys/revoke",
                        { key_id: key.key_id }
                      )}
                      variant="text"
                    >
                      Revoke
                    </CommandButton>
                  ) : null}
                </div>
              ))}
              {access.api_keys.length === 0 ? <p className="record-count">No machine keys.</p> : null}
            </div>
          </div>
          <div className="access-audit">
            <h4>Recent tenant audit</h4>
            {access.audit.slice(0, 8).map((entry) => (
              <div key={entry.audit_id}>
                <code>{entry.action}</code>
                <span>{entry.actor_id} · {entry.resource_type} · {formatDate(entry.occurred_at, true)}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      <Section heading="Webhook subscriptions" description="Persisted runtime receivers. Signing secrets are write-only.">
        <div className="webhook-subscription-form">
          <input aria-label="Webhook URL" onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://receiver.example/hooks" type="url" value={webhookUrl} />
          <input aria-label="Webhook signing secret" onChange={(event) => setWebhookSecret(event.target.value)} placeholder="Signing secret (16+ characters)" type="password" value={webhookSecret} />
          <CommandButton
            disabled={webhookBusy || !webhookUrl || webhookSecret.length < 16}
            onClick={() => void webhookWrite("/admin/api/v1/webhooks/subscription", {
              url: webhookUrl,
              secret: webhookSecret,
              active: true
            }, "PUT")}
          >
            Add receiver
          </CommandButton>
        </div>
        {webhookError ? <div className="error-banner" role="alert">{webhookError}</div> : null}
        <div className="webhook-subscription-list">
          {subscriptions.map((subscription) => (
            <div key={subscription.subscription_id}>
              <span><strong>{subscription.active ? "Active" : "Paused"}</strong>{subscription.url}</span>
              <div>
                <CommandButton
                  disabled={webhookBusy}
                  onClick={() => {
                    const secret = window.prompt("New signing secret (16+ characters)");
                    if (secret) void webhookWrite(
                      "/admin/api/v1/webhooks/subscription/rotate-secret",
                      { subscription_id: subscription.subscription_id, secret }
                    );
                  }}
                  variant="text"
                >
                  Rotate secret
                </CommandButton>
                <CommandButton
                  disabled={webhookBusy}
                  onClick={() => void webhookWrite(
                    "/admin/api/v1/webhooks/subscription/delete",
                    { subscription_id: subscription.subscription_id }
                  )}
                  variant="text"
                >
                  Delete
                </CommandButton>
              </div>
            </div>
          ))}
          {subscriptions.length === 0 ? <EmptyState>No webhook receivers configured.</EmptyState> : null}
        </div>
      </Section>
      <Section>
        <div className="section-heading">
          <div><p className="eyebrow">Webhooks</p><h3>Delivery activity</h3></div>
          <span className="record-count">{formatNumber(snapshot.webhooks.pending.length)} pending</span>
        </div>
        {!snapshot.webhooks.enabled ? (
          <EmptyState>Webhook delivery is disabled. Set LIP_WEBHOOK_URL and LIP_WEBHOOK_SECRET.</EmptyState>
        ) : webhookRows.length === 0 ? (
          <EmptyState>No webhook deliveries have been recorded in this process.</EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="ledger-table">
              <thead><tr><th>Status</th><th>Event</th><th>Receiver</th><th>Attempts</th><th>Updated</th></tr></thead>
              <tbody>
                {webhookRows.map((delivery) => (
                  <tr key={delivery.key}>
                    <td><span className="primary-cell">{delivery.status}</span>{delivery.error ? <small>{delivery.error}</small> : null}</td>
                    <td><code>{delivery.eventType}</code></td>
                    <td><code>{delivery.url}</code></td>
                    <td className="numeric">
                      {formatNumber(delivery.attempts)}
                      {delivery.status === "Pending" ? (
                        <CommandButton
                          disabled={webhookBusy}
                          onClick={() => void webhookWrite(
                            "/admin/api/v1/webhooks/deliveries/retry",
                            { delivery_id: delivery.key }
                          )}
                          variant="text"
                        >
                          Retry
                        </CommandButton>
                      ) : (
                        <CommandButton
                          disabled={webhookBusy}
                          onClick={() => void webhookWrite(
                            "/admin/api/v1/webhooks/deliveries/replay",
                            { delivery_id: delivery.key }
                          )}
                          variant="text"
                        >
                          Replay
                        </CommandButton>
                      )}
                    </td>
                    <td>{formatDate(delivery.timestamp, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<AdminSnapshot>();
  const [bootstrap, setBootstrap] = useState<AdminBootstrap>();
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [view, setView] = useState<View>("overview");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/admin/api/v1/snapshot", { credentials: "same-origin" });
      if (response.status === 401) {
        setAuthenticated(false);
        setSnapshot(undefined);
        return;
      }
      if (!response.ok) throw new Error(`Admin API returned HTTP ${response.status}`);
      setSnapshot(await response.json() as AdminSnapshot);
      setAuthenticated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Admin API unavailable");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadBootstrap() {
      try {
        const response = await fetch("/admin/api/v1/bootstrap", { credentials: "same-origin" });
        if (!response.ok) throw new Error(`Admin bootstrap returned HTTP ${response.status}`);
        const data = await response.json() as AdminBootstrap;
        if (cancelled) return;
        setBootstrap(data);
        if (data.session.authenticated) {
          await refresh();
          return;
        }
        setAuthenticated(false);
      } catch {
        if (!cancelled) await refresh();
      }
    }
    void loadBootstrap();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function logout() {
    await fetch("/admin/api/v1/logout", { method: "POST", credentials: "same-origin" });
    setSnapshot(undefined);
    setAuthenticated(false);
  }

  if (authenticated === undefined && !error) return <main className="loading-page"><Spinner className="loading-mark" /><span>Loading Admin</span></main>;
  if (authenticated === false) return <Login bootstrap={bootstrap} onAuthenticated={refresh} />;
  if (!snapshot) return <main className="loading-page"><p>{error || "Admin data unavailable"}</p><CommandButton icon={<RefreshCw size={16} />} onClick={() => void refresh()}>Retry</CommandButton></main>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><div className="brand-mark"><Store size={21} /></div><div><strong>Loyalty</strong><span>Operations dashboard</span></div></div>
        <nav aria-label="Admin navigation">
          {navigation.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)} title={item.label}><Icon size={17} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-footer"><span className="environment-dot" />Local workspace · {snapshot.platform.storage.driver}</div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div><strong>{displayProgramName(snapshot.program)}</strong><span>{formatNumber(snapshot.summary.active_members)} active members · {snapshot.platform.storage.driver}</span></div>
          <div className="topbar-actions">
            <span className="updated-at">Updated {formatDate(snapshot.generated_at, true)}</span>
            <IconButton disabled={refreshing} label="Refresh data" onClick={() => void refresh()}><RefreshCw className={refreshing ? "spin" : ""} size={17} /></IconButton>
            <IconButton label="Sign out" onClick={() => void logout()}><LogOut size={17} /></IconButton>
          </div>
        </header>
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        <main className="main-content">
          {view === "overview" ? <Overview snapshot={snapshot} onViewMembers={() => setView("members")} /> : null}
          {view === "members" ? <Members members={snapshot.members} unit={snapshot.program.earning.rate.unit} /> : null}
          {view === "ledger" ? <Ledger snapshot={snapshot} /> : null}
          {view === "program" ? <Program snapshot={snapshot} onChanged={refresh} /> : null}
          {view === "marketing" ? <Marketing snapshot={snapshot} onChanged={refresh} /> : null}
          {view === "developer" ? <Developer snapshot={snapshot} onChanged={refresh} /> : null}
        </main>
      </div>
    </div>
  );
}
