import {
  OrderAdjustmentSchema,
  validate,
  validateFoodserviceOrder,
  type FoodserviceOrder,
  type OrderAdjustment,
  type ValidationIssue
} from "@loyalty-interchange/protocol";

export type FoodserviceAdapterCapability =
  | "modifiers"
  | "combos"
  | "split_tenders"
  | "comps"
  | "discounts"
  | "taxes"
  | "tips"
  | "offline_accrual"
  | "duplicate_delivery"
  | "voids"
  | "partial_refunds";

export interface AdapterIdempotencyKeys {
  evaluate: string;
  accrue: string;
  adjustment?: string;
}

/**
 * Vendor-specific ordering adapters stop at the protocol boundary. They map a
 * source order and its adjustments into LIP values; payment execution,
 * customer authentication, and network retries remain in the caller's BFF.
 */
export interface FoodserviceOrderingAdapter<TOrder, TAdjustment = never> {
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly FoodserviceAdapterCapability[];
  mapOrder(source: TOrder): FoodserviceOrder;
  mapAdjustment?(source: TAdjustment, original: FoodserviceOrder): OrderAdjustment;
  idempotencyKeys(source: TOrder, adjustment?: TAdjustment): AdapterIdempotencyKeys;
}

export interface AdapterFixtureExpectation {
  order_id: string;
  status: FoodserviceOrder["status"];
  required_line_kinds?: Array<FoodserviceOrder["lines"][number]["kind"]>;
  required_tender_types?: Array<NonNullable<FoodserviceOrder["tenders"]>[number]["type"]>;
  adjustment_type?: OrderAdjustment["type"];
}

export interface AdapterCertificationFixture<TOrder, TAdjustment = never> {
  id: string;
  description: string;
  capabilities: readonly FoodserviceAdapterCapability[];
  source: TOrder;
  adjustment?: TAdjustment;
  expected: AdapterFixtureExpectation;
}

export interface AdapterCertificationCaseResult {
  fixture_id: string;
  passed: boolean;
  issues: string[];
}

export interface AdapterCertificationReport {
  schema_version: "lip.adapter-certification/1";
  adapter: { name: string; version: string };
  generated_at: string;
  passed: boolean;
  capabilities: FoodserviceAdapterCapability[];
  cases: AdapterCertificationCaseResult[];
}

export interface NormalizedAdapterLifecycle {
  order: FoodserviceOrder;
  idempotency_keys: AdapterIdempotencyKeys;
  adjustment?: OrderAdjustment;
}

/** Maps one source event into the normalized value consumed by a merchant BFF. */
export function mapAdapterLifecycle<TOrder, TAdjustment = never>(
  adapter: FoodserviceOrderingAdapter<TOrder, TAdjustment>,
  source: TOrder,
  adjustmentSource?: TAdjustment
): NormalizedAdapterLifecycle {
  const order = adapter.mapOrder(source);
  const idempotencyKeys = adapter.idempotencyKeys(source, adjustmentSource);
  const adjustment = adjustmentSource === undefined
    ? undefined
    : adapter.mapAdjustment?.(adjustmentSource, order);
  if (adjustmentSource !== undefined && !adjustment) {
    throw new Error(`${adapter.name} does not implement adjustment mapping`);
  }
  return {
    order,
    idempotency_keys: idempotencyKeys,
    ...(adjustment ? { adjustment } : {})
  };
}

/** Shared scenarios every foodservice adapter should represent with source fixtures. */
export const foodserviceCertificationScenarios: ReadonlyArray<{
  id: string;
  description: string;
  capabilities: readonly FoodserviceAdapterCapability[];
}> = [
  {
    id: "restaurant-order-shape",
    description: "Modifiers, combo attribution, comp, discount, tax, tip, and split tenders",
    capabilities: ["modifiers", "combos", "split_tenders", "comps", "discounts", "taxes", "tips"]
  },
  {
    id: "offline-duplicate",
    description: "An offline order delivered twice maps to the same order and operation keys",
    capabilities: ["offline_accrual", "duplicate_delivery"]
  },
  {
    id: "void",
    description: "A full void links exact negative deltas to the original order",
    capabilities: ["voids"]
  },
  {
    id: "partial-refund",
    description: "A partial refund links signed line and spend deltas to the original order",
    capabilities: ["partial_refunds"]
  }
] as const;

function issueText(issue: ValidationIssue): string {
  return `${issue.path} ${issue.message} (${issue.keyword})`;
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

function validateKeys(keys: AdapterIdempotencyKeys, orderId: string): string[] {
  const issues: string[] = [];
  for (const [operation, value] of Object.entries(keys)) {
    if (!value.trim()) issues.push(`${operation} idempotency key is empty`);
    if (value.length > 255) issues.push(`${operation} idempotency key exceeds 255 characters`);
  }
  if (keys.evaluate === keys.accrue) {
    issues.push("evaluate and accrue must use operation-scoped idempotency keys");
  }
  if (!keys.evaluate.includes(orderId) || !keys.accrue.includes(orderId)) {
    issues.push("evaluate and accrue idempotency keys must derive from the source order id");
  }
  return issues;
}

export function certifyAdapter<TOrder, TAdjustment = never>(
  adapter: FoodserviceOrderingAdapter<TOrder, TAdjustment>,
  fixtures: readonly AdapterCertificationFixture<TOrder, TAdjustment>[],
  now: () => Date = () => new Date()
): AdapterCertificationReport {
  const declared = [...adapter.capabilities];
  const declaredSet = new Set(declared);
  const duplicateCapabilities = duplicates(declared);
  const duplicateFixtureIds = duplicates(fixtures.map((fixture) => fixture.id));
  const cases = fixtures.map((fixture): AdapterCertificationCaseResult => {
    const issues: string[] = [];
    for (const capability of fixture.capabilities) {
      if (!declaredSet.has(capability)) issues.push(`adapter does not declare ${capability}`);
    }

    let first: FoodserviceOrder;
    let second: FoodserviceOrder;
    try {
      first = adapter.mapOrder(fixture.source);
      second = adapter.mapOrder(fixture.source);
    } catch (error) {
      return {
        fixture_id: fixture.id,
        passed: false,
        issues: [`mapOrder threw: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
    const validated = validateFoodserviceOrder(first);
    if (!validated.ok) issues.push(...validated.issues.map(issueText));
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      issues.push("mapOrder is not deterministic for a replayed source order");
    }
    if (first.order_id !== fixture.expected.order_id) {
      issues.push(`expected order_id ${fixture.expected.order_id}, received ${first.order_id}`);
    }
    if (first.status !== fixture.expected.status) {
      issues.push(`expected status ${fixture.expected.status}, received ${first.status}`);
    }
    for (const kind of fixture.expected.required_line_kinds ?? []) {
      if (!first.lines.some((line) => line.kind === kind)) issues.push(`missing ${kind} line`);
    }
    for (const type of fixture.expected.required_tender_types ?? []) {
      if (!first.tenders?.some((tender) => tender.type === type)) {
        issues.push(`missing ${type} tender`);
      }
    }

    let firstKeys: AdapterIdempotencyKeys;
    let secondKeys: AdapterIdempotencyKeys;
    try {
      firstKeys = adapter.idempotencyKeys(fixture.source, fixture.adjustment);
      secondKeys = adapter.idempotencyKeys(fixture.source, fixture.adjustment);
      issues.push(...validateKeys(firstKeys, first.order_id));
      if (JSON.stringify(firstKeys) !== JSON.stringify(secondKeys)) {
        issues.push("idempotencyKeys is not deterministic for a replayed source order");
      }
    } catch (error) {
      issues.push(`idempotencyKeys threw: ${error instanceof Error ? error.message : String(error)}`);
      return { fixture_id: fixture.id, passed: false, issues };
    }

    if (fixture.adjustment !== undefined) {
      if (!adapter.mapAdjustment) {
        issues.push("fixture supplies an adjustment but the adapter does not map adjustments");
      } else {
        try {
          const adjustment = adapter.mapAdjustment(fixture.adjustment, first);
          const adjustmentValidation = validate(OrderAdjustmentSchema, adjustment);
          if (!adjustmentValidation.ok) {
            issues.push(...adjustmentValidation.issues.map(issueText));
          }
          if (adjustment.original_order_id !== first.order_id) {
            issues.push("adjustment original_order_id does not match mapped order_id");
          }
          if (
            fixture.expected.adjustment_type &&
            adjustment.type !== fixture.expected.adjustment_type
          ) {
            issues.push(
              `expected adjustment type ${fixture.expected.adjustment_type}, received ${adjustment.type}`
            );
          }
          if (!firstKeys.adjustment) issues.push("adjustment idempotency key is missing");
        } catch (error) {
          issues.push(
            `mapAdjustment threw: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    return { fixture_id: fixture.id, passed: issues.length === 0, issues };
  });

  const metadataIssues = [
    ...(duplicateCapabilities.length > 0
      ? [`duplicate capabilities: ${[...new Set(duplicateCapabilities)].join(", ")}`]
      : []),
    ...(duplicateFixtureIds.length > 0
      ? [`duplicate fixture ids: ${[...new Set(duplicateFixtureIds)].join(", ")}`]
      : [])
  ];
  if (metadataIssues.length > 0) {
    cases.unshift({
      fixture_id: "adapter-metadata",
      passed: false,
      issues: metadataIssues
    });
  }

  return {
    schema_version: "lip.adapter-certification/1",
    adapter: { name: adapter.name, version: adapter.version },
    generated_at: now().toISOString(),
    passed: cases.every((entry) => entry.passed),
    capabilities: declared,
    cases
  };
}

/**
 * Full foodservice certification requires evidence for every shared scenario.
 * Use `certifyAdapter` directly only for an intentionally partial fixture run.
 */
export function certifyFoodserviceAdapter<TOrder, TAdjustment = never>(
  adapter: FoodserviceOrderingAdapter<TOrder, TAdjustment>,
  fixtures: readonly AdapterCertificationFixture<TOrder, TAdjustment>[],
  now: () => Date = () => new Date()
): AdapterCertificationReport {
  const report = certifyAdapter(adapter, fixtures, now);
  const provided = new Set(fixtures.map((fixture) => fixture.id));
  const missing = foodserviceCertificationScenarios
    .filter((scenario) => !provided.has(scenario.id))
    .map((scenario) => scenario.id);
  if (missing.length === 0) return report;
  const cases = [{
    fixture_id: "foodservice-scenario-coverage",
    passed: false,
    issues: [`missing shared scenarios: ${missing.join(", ")}`]
  }, ...report.cases];
  return { ...report, passed: false, cases };
}
