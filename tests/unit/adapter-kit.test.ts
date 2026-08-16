import { describe, expect, it } from "vitest";
import {
  certifyAdapter,
  certifyFoodserviceAdapter,
  foodserviceCertificationScenarios,
  mapAdapterLifecycle
} from "@loyalty-interchange/adapter-kit";
import {
  adapterFoodserviceFixtures,
  referenceOrderingAdapter
} from "../fixtures/adapter-foodservice.js";

describe("foodservice adapter certification", () => {
  it("certifies the shared restaurant edge-case corpus", () => {
    const report = certifyFoodserviceAdapter(
      referenceOrderingAdapter,
      adapterFoodserviceFixtures,
      () => new Date("2026-08-15T20:00:00.000Z")
    );

    expect(report).toMatchObject({
      schema_version: "lip.adapter-certification/1",
      adapter: { name: "reference-ordering-bff", version: "0.2.0" },
      generated_at: "2026-08-15T20:00:00.000Z",
      passed: true
    });
    expect(report.cases).toHaveLength(4);
    expect(report.cases.every((entry) => entry.passed)).toBe(true);
    expect(adapterFoodserviceFixtures.map((fixture) => fixture.id).sort()).toEqual(
      foodserviceCertificationScenarios.map((scenario) => scenario.id).sort()
    );
    const mapped = mapAdapterLifecycle(
      referenceOrderingAdapter,
      adapterFoodserviceFixtures[2]!.source,
      adapterFoodserviceFixtures[2]!.adjustment
    );
    expect(mapped).toMatchObject({
      order: { order_id: "order-edge-001" },
      adjustment: { original_order_id: "order-edge-001", type: "partial_refund" },
      idempotency_keys: { evaluate: "evaluate:order-edge-001" }
    });
  });

  it("fails a fixture when a required capability is not declared", () => {
    const report = certifyAdapter(
      { ...referenceOrderingAdapter, capabilities: ["modifiers"] },
      [adapterFoodserviceFixtures[2]!]
    );

    expect(report.passed).toBe(false);
    expect(report.cases[0]?.issues).toContain("adapter does not declare partial_refunds");
  });

  it("does not call a partial fixture run full foodservice certification", () => {
    const report = certifyFoodserviceAdapter(
      referenceOrderingAdapter,
      [adapterFoodserviceFixtures[0]!]
    );

    expect(report.passed).toBe(false);
    expect(report.cases[0]?.issues.join(" ")).toContain("offline-duplicate");
  });
});
