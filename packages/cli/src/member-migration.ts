import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  IdentityReference,
  LoyaltyUnit
} from "@loyalty-interchange/protocol";
import { readMigrationArchive } from "@loyalty-interchange/server";

export const MEMBER_IMPORT_FORMAT = "lip-member-import-plan";
export const MEMBER_IMPORT_FORMAT_VERSION = 1;

export interface MemberImportSource {
  external_member_id: string;
  identity_type?: IdentityReference["type"];
  identity_value: string;
  member_id?: string;
  available_balance: number;
  unit?: LoyaltyUnit;
}

export interface MemberImportPlanEntry {
  external_member_id: string;
  member_id: string;
  identity: IdentityReference;
  enroll: {
    program_id: string;
    identity: IdentityReference;
    member_id: string;
  };
  opening_balance?: {
    program_id: string;
    member_id: string;
    adjustment_id: string;
    unit?: LoyaltyUnit;
    amount: number;
    classification: "migration";
    reason: "Opening balance migration";
    qualifies_for_tier: false;
  };
  expected_balance: number;
}

export interface MemberImportPlan {
  format: typeof MEMBER_IMPORT_FORMAT;
  format_version: typeof MEMBER_IMPORT_FORMAT_VERSION;
  created_at: string;
  program_id: string;
  entries: MemberImportPlanEntry[];
  summary: {
    members: number;
    nonzero_balances: number;
    net_opening_balance: number;
  };
  checksum: { algorithm: "sha256"; value: string };
}

export interface MemberImportReconciliation {
  format: "lip-member-import-reconciliation";
  format_version: 1;
  generated_at: string;
  program_id: string;
  passed: boolean;
  summary: { expected_members: number; matched: number; missing: number; mismatched: number };
  entries: Array<{
    member_id: string;
    expected_balance: number;
    actual_balance?: number;
    status: "matched" | "missing" | "balance_mismatch";
  }>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPlanValue(plan: Omit<MemberImportPlan, "checksum">): string {
  return JSON.stringify(plan);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).slice(0, 24)}`;
}

function parseCsvRow(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted value");
  values.push(current);
  return values;
}

function parseCsv(contents: string): unknown[] {
  const lines = contents.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("CSV requires a header and at least one member row");
  const headers = parseCsvRow(lines[0]!).map((value) => value.trim());
  return lines.slice(1).map((line, rowIndex) => {
    const values = parseCsvRow(line);
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} values; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function sourceMember(value: unknown, index: number): MemberImportSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Member row ${index + 1} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const externalId = String(record["external_member_id"] ?? "").trim();
  const identityValue = String(record["identity_value"] ?? "").trim();
  const memberId = record["member_id"] === undefined
    ? undefined
    : String(record["member_id"]).trim();
  const identityType = String(record["identity_type"] ?? "external").trim();
  const balanceValue = typeof record["available_balance"] === "number"
    ? record["available_balance"]
    : Number(String(record["available_balance"] ?? ""));
  if (!externalId) throw new Error(`Member row ${index + 1} requires external_member_id`);
  if (!identityValue) throw new Error(`Member row ${index + 1} requires identity_value`);
  if (!memberId && record["member_id"] !== undefined) {
    throw new Error(`Member row ${index + 1} member_id cannot be empty`);
  }
  if (!["token", "email", "phone", "external"].includes(identityType)) {
    throw new Error(`Member row ${index + 1} has unsupported identity_type ${identityType}`);
  }
  if (!Number.isSafeInteger(balanceValue)) {
    throw new Error(`Member row ${index + 1} available_balance must be a safe integer`);
  }
  if (balanceValue < 0) {
    throw new Error(`Member row ${index + 1} available_balance cannot be negative`);
  }
  const unitValue = record["unit"] === undefined
    ? undefined
    : String(record["unit"]).trim();
  if (
    unitValue &&
    !["points", "visits", "stamps", "credits", "custom"].includes(unitValue)
  ) {
    throw new Error(`Member row ${index + 1} has unsupported unit ${unitValue}`);
  }
  const unit = unitValue as LoyaltyUnit | undefined;
  return {
    external_member_id: externalId,
    identity_type: identityType as IdentityReference["type"],
    identity_value: identityValue,
    ...(memberId ? { member_id: memberId } : {}),
    available_balance: balanceValue,
    ...(unit ? { unit } : {})
  };
}

export function createMemberImportPlan(
  programId: string,
  rows: unknown[],
  now: () => Date = () => new Date()
): MemberImportPlan {
  if (!programId.trim()) throw new Error("program_id is required");
  if (rows.length === 0) throw new Error("Member import source is empty");
  const sources = rows.map(sourceMember);
  const externalIds = new Set<string>();
  const identities = new Set<string>();
  const memberIds = new Set<string>();
  const entries = sources.map((source): MemberImportPlanEntry => {
    if (externalIds.has(source.external_member_id)) {
      throw new Error(`Duplicate external_member_id ${source.external_member_id}`);
    }
    externalIds.add(source.external_member_id);
    const identity: IdentityReference = {
      type: source.identity_type ?? "external",
      value: source.identity_value
    };
    const identityKey = `${identity.type}:${identity.value}`;
    if (identities.has(identityKey)) throw new Error(`Duplicate identity ${identityKey}`);
    identities.add(identityKey);
    const memberId = source.member_id ?? stableId("member", source.external_member_id);
    if (memberIds.has(memberId)) throw new Error(`Duplicate member_id ${memberId}`);
    memberIds.add(memberId);
    const openingBalance = source.available_balance === 0
      ? undefined
      : {
          program_id: programId,
          member_id: memberId,
          adjustment_id: stableId("migration", `${programId}:${source.external_member_id}`),
          ...(source.unit ? { unit: source.unit } : {}),
          amount: source.available_balance,
          classification: "migration" as const,
          reason: "Opening balance migration" as const,
          qualifies_for_tier: false as const
        };
    return {
      external_member_id: source.external_member_id,
      member_id: memberId,
      identity,
      enroll: { program_id: programId, identity, member_id: memberId },
      ...(openingBalance ? { opening_balance: openingBalance } : {}),
      expected_balance: source.available_balance
    };
  });
  const withoutChecksum = {
    format: MEMBER_IMPORT_FORMAT,
    format_version: MEMBER_IMPORT_FORMAT_VERSION,
    created_at: now().toISOString(),
    program_id: programId,
    entries,
    summary: {
      members: entries.length,
      nonzero_balances: entries.filter((entry) => entry.expected_balance !== 0).length,
      net_opening_balance: entries.reduce((sum, entry) => sum + entry.expected_balance, 0)
    }
  } satisfies Omit<MemberImportPlan, "checksum">;
  return {
    ...withoutChecksum,
    checksum: { algorithm: "sha256", value: sha256(canonicalPlanValue(withoutChecksum)) }
  };
}

export function parseMemberImportPlan(value: unknown): MemberImportPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Member import plan must be an object");
  }
  const plan = value as MemberImportPlan;
  if (
    plan.format !== MEMBER_IMPORT_FORMAT ||
    plan.format_version !== MEMBER_IMPORT_FORMAT_VERSION ||
    !Array.isArray(plan.entries) ||
    !plan.checksum ||
    plan.checksum.algorithm !== "sha256"
  ) {
    throw new Error("Member import plan format is invalid or unsupported");
  }
  const { checksum, ...withoutChecksum } = plan;
  if (sha256(canonicalPlanValue(withoutChecksum)) !== checksum.value) {
    throw new Error("Member import plan checksum does not match its contents");
  }
  return structuredClone(plan);
}

async function readRows(path: string): Promise<unknown[]> {
  const source = resolve(path);
  const contents = await readFile(source, "utf8");
  if (source.toLowerCase().endsWith(".csv")) return parseCsv(contents);
  const value: unknown = JSON.parse(contents);
  if (!Array.isArray(value)) throw new Error("JSON member import source must be an array");
  return value;
}

async function writePrivateJson(path: string, value: unknown, force = false): Promise<void> {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: force ? "w" : "wx",
    mode: 0o600
  });
  await chmod(resolve(path), 0o600);
}

export async function runMemberImportPlan(options: {
  programId: string;
  input: string;
  output: string;
  force?: boolean;
}): Promise<MemberImportPlan> {
  const plan = createMemberImportPlan(options.programId, await readRows(options.input));
  await writePrivateJson(options.output, plan, Boolean(options.force));
  return plan;
}

export async function runMemberImportReconciliation(options: {
  plan: string;
  archive: string;
  output?: string;
  force?: boolean;
}, now: () => Date = () => new Date()): Promise<MemberImportReconciliation> {
  const plan = parseMemberImportPlan(JSON.parse(await readFile(resolve(options.plan), "utf8")));
  const archive = await readMigrationArchive(resolve(options.archive));
  if (archive.program.program_id !== plan.program_id) {
    throw new Error(
      `Migration archive belongs to ${archive.program.program_id}, expected ${plan.program_id}`
    );
  }
  const members = new Set(archive.state.members.map(([memberId]) => memberId));
  const balances = new Map(archive.state.points);
  const primaryUnit =
    archive.program.accounts?.find((account) => account.is_primary)?.unit ??
    archive.program.accounts?.[0]?.unit ??
    "points";
  const entries = plan.entries.map((entry) => {
    if (!members.has(entry.member_id)) {
      return {
        member_id: entry.member_id,
        expected_balance: entry.expected_balance,
        status: "missing" as const
      };
    }
    const unit = entry.opening_balance?.unit ?? primaryUnit;
    const balanceKey = unit === primaryUnit
      ? entry.member_id
      : `${unit}:${entry.member_id}`;
    const actual = balances.get(balanceKey) ?? 0;
    return {
      member_id: entry.member_id,
      expected_balance: entry.expected_balance,
      actual_balance: actual,
      status: actual === entry.expected_balance ? "matched" as const : "balance_mismatch" as const
    };
  });
  const report: MemberImportReconciliation = {
    format: "lip-member-import-reconciliation",
    format_version: 1,
    generated_at: now().toISOString(),
    program_id: plan.program_id,
    passed: entries.every((entry) => entry.status === "matched"),
    summary: {
      expected_members: entries.length,
      matched: entries.filter((entry) => entry.status === "matched").length,
      missing: entries.filter((entry) => entry.status === "missing").length,
      mismatched: entries.filter((entry) => entry.status === "balance_mismatch").length
    },
    entries
  };
  if (options.output) await writePrivateJson(options.output, report, Boolean(options.force));
  return report;
}
