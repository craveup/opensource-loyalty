import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoPlatform, parseCustomerCsv } from "@loyalty-interchange/server";

describe("customer data platform", () => {
  it("persists profiles, consent, idempotent events, and imports", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-customer-data-"));
    const databasePath = join(directory, "reference.db");
    try {
      const first = await createDemoPlatform({ databasePath, reset: true, seed: false });
      const profile = await first.customerData.upsertProfile({
        member_id: "member-001",
        external_id: "guest-001",
        display_name: "Demo Guest",
        email: "guest@example.test",
        attributes: { favorite_location: "location-001" },
        consent: { marketing: true, source: "signup-form" }
      });
      expect(profile).toMatchObject({
        member_id: "member-001",
        email: "guest@example.test",
        consent: { marketing: true, source: "signup-form" }
      });
      expect(first.engine.inspectAdmin().members).toHaveLength(1);

      const eventInput = {
        idempotency_key: "purchase-001",
        member_id: "member-001",
        type: "purchase.completed",
        occurred_at: "2026-08-01T12:00:00.000Z",
        source: "test-checkout",
        value_minor_units: 2450,
        currency: "usd",
        properties: { channel: "web" }
      };
      const event = await first.customerData.ingestEvent(eventInput);
      const replay = await first.customerData.ingestEvent(eventInput);
      expect(replay.event_id).toBe(event.event_id);
      expect(event.currency).toBe("USD");

      const imported = await first.customerData.importMembers({
        idempotency_key: "member-import-001",
        rows: [
          { member_id: "member-001", phone: "+15555550101" },
          { member_id: "member-002", external_id: "guest-002" }
        ]
      });
      expect(imported).toMatchObject({
        status: "completed",
        submitted: 2,
        created: 1,
        updated: 1,
        failed: 0
      });
      expect(first.customerData.analytics()).toMatchObject({
        profiles: { total: 2, marketing_consented: 1 },
        events: { total: 1, unique_members: 1 },
        imports: { total: 1, completed: 1, failed_rows: 0 }
      });
      await first.close();

      const second = await createDemoPlatform({ databasePath, seed: false });
      expect(second.customerData.listProfiles()).toHaveLength(2);
      expect(second.customerData.listEvents()).toEqual([
        expect.objectContaining({ idempotency_key: "purchase-001" })
      ]);
      expect(second.customerData.snapshot().imports).toEqual([
        expect.objectContaining({ idempotency_key: "member-import-001" })
      ]);
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds dynamic segments from customer consent and events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-customer-segment-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false
    });
    try {
      for (const [memberId, consent] of [["member-001", true], ["member-002", false]] as const) {
        await platform.customerData.upsertProfile({
          member_id: memberId,
          external_id: `guest-${memberId}`,
          email: `${memberId}@example.test`,
          consent: { marketing: consent }
        });
      }
      await platform.customerData.ingestEvent({
        idempotency_key: "visit-001",
        member_id: "member-001",
        type: "visit.completed",
        occurred_at: new Date().toISOString()
      });
      const segment = await platform.campaigns.upsertSegment({
        name: "Recent consented guests",
        rules: {
          profile: { has_email: true, marketing_consent: true },
          event: { type: "visit.completed", minimum_count: 1, within_days: 30 }
        }
      });
      expect(platform.campaigns.previewSegment(segment.segment_id)).toEqual({
        segment_id: segment.segment_id,
        estimated_size: 1,
        sample_member_ids: ["member-001"]
      });
    } finally {
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown event members and conflicting idempotency facts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-customer-validation-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false
    });
    try {
      await expect(platform.customerData.ingestEvent({
        idempotency_key: "unknown-event",
        member_id: "missing-member",
        type: "visit.completed"
      })).rejects.toThrowError(/not found/);
      await platform.customerData.upsertProfile({ member_id: "member-001" });
      await platform.customerData.ingestEvent({
        idempotency_key: "same-key",
        member_id: "member-001",
        type: "visit.completed",
        occurred_at: "2026-08-01T12:00:00.000Z"
      });
      await expect(platform.customerData.ingestEvent({
        idempotency_key: "same-key",
        member_id: "member-001",
        type: "purchase.completed",
        occurred_at: "2026-08-01T12:00:00.000Z"
      })).rejects.toThrowError(/different facts/);
    } finally {
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses quoted CSV member imports with explicit consent", () => {
    expect(parseCustomerCsv([
      "member_id,external_id,display_name,email,marketing_consent,consent_source,attributes_json",
      'member-001,guest-001,"Demo, Guest",guest@example.test,true,signup,"{""favorite_location"":""location-001""}"'
    ].join("\n"))).toEqual([{
      member_id: "member-001",
      external_id: "guest-001",
      display_name: "Demo, Guest",
      email: "guest@example.test",
      consent: { marketing: true, source: "signup" },
      attributes: { favorite_location: "location-001" }
    }]);
  });
});
