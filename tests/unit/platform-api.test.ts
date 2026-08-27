import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDemoPlatform,
  startReferenceServer
} from "@loyalty-interchange/server";

describe("platform HTTP API", () => {
  it("runs a customer-to-campaign-to-attribution lifecycle outside /lip/v1", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-platform-api-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false
    });
    const apiKey = "platform-api-test-key";
    const running = await startReferenceServer(platform.engine, {
      apiKey,
      persistState: (state) => platform.store.save(state),
      admin: {
        campaigns: platform.campaigns,
        customerData: platform.customerData,
        engagement: platform.engagement,
        access: platform.access
      }
    });
    const request = async (path: string, init: RequestInit = {}) => fetch(`${running.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers
      }
    });
    try {
      expect((await fetch(`${running.url}/platform/v1`)).status).toBe(401);
      const root = await request("/platform/v1");
      expect(await root.json()).toMatchObject({
        api_version: "1.0",
        boundaries: {
          transaction_protocol: "/lip/v1",
          customer_engagement: "/platform/v1"
        }
      });

      const member = await request("/platform/v1/members", {
        method: "PUT",
        body: JSON.stringify({
          member_id: "member-001",
          external_id: "guest-001",
          email: "guest@example.test",
          consent: { marketing: true, source: "wallet-signup" }
        })
      });
      expect(member.status).toBe(200);

      const visit = await request("/platform/v1/events", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: "visit-001",
          member_id: "member-001",
          type: "visit.completed",
          occurred_at: new Date().toISOString()
        })
      });
      expect(visit.status).toBe(201);

      const segmentResponse = await request("/platform/v1/segments", {
        method: "PUT",
        body: JSON.stringify({
          name: "Recent opted-in guests",
          rules: {
            profile: { marketing_consent: true },
            event: { type: "visit.completed", minimum_count: 1, within_days: 30 }
          }
        })
      });
      const segment = (await segmentResponse.json()) as { segment: { segment_id: string } };
      const preview = await request("/platform/v1/segments/preview", {
        method: "POST",
        body: JSON.stringify({ segment_id: segment.segment.segment_id })
      });
      expect(await preview.json()).toMatchObject({ estimated_size: 1 });

      const campaignResponse = await request("/platform/v1/campaigns", {
        method: "PUT",
        body: JSON.stringify({
          name: "Return visit reward",
          reward_id: "five-off",
          segment_id: segment.segment.segment_id,
          holdout_percent: 0,
          attribution_window_days: 7
        })
      });
      const campaign = (await campaignResponse.json()) as { campaign: { campaign_id: string } };
      const activated = await request("/platform/v1/campaigns/status", {
        method: "POST",
        body: JSON.stringify({ campaign_id: campaign.campaign.campaign_id, status: "active" })
      });
      expect(await activated.json()).toMatchObject({ campaign: { status: "active" } });
      const run = await request("/platform/v1/campaigns/run", {
        method: "POST",
        body: JSON.stringify({ campaign_id: campaign.campaign.campaign_id })
      });
      expect(await run.json()).toMatchObject({ run: { issued: 1, failed: 0 } });

      await request("/platform/v1/events", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: "conversion-001",
          member_id: "member-001",
          type: "purchase.completed",
          campaign_id: campaign.campaign.campaign_id,
          value_minor_units: 3150,
          currency: "USD"
        })
      });
      const report = await request(
        `/platform/v1/campaigns/report?campaign_id=${encodeURIComponent(campaign.campaign.campaign_id)}`
      );
      expect(await report.json()).toMatchObject({
        attribution: {
          targeted_members: 1,
          converted_members: 1,
          conversions: 1,
          attributed_value_minor_units: 3150,
          conversion_rate: 1
        }
      });

      const connector = await request("/platform/v1/connectors", {
        method: "PUT",
        body: JSON.stringify({
          name: "Example webhook",
          type: "webhook",
          configuration: { url: "https://example.test/messages" },
          secret: "example-only-secret-value"
        })
      });
      expect(connector.status).toBe(200);
      const connectors = await (await request("/platform/v1/connectors")).json() as {
        connectors: Array<Record<string, unknown>>;
      };
      expect(connectors.connectors[0]).toMatchObject({ secret_configured: true });
      expect(connectors.connectors[0]).not.toHaveProperty("secret");

      const analytics = await request("/platform/v1/analytics");
      expect(await analytics.json()).toMatchObject({
        customer_data: { profiles: { total: 1 }, events: { total: 2 } },
        loyalty: { campaigns: { runs: 1, rewards_issued: 1 } }
      });
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces read/write roles and rejects location-scoped principals", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lip-platform-auth-"));
    const platform = await createDemoPlatform({
      databasePath: join(directory, "reference.db"),
      reset: true,
      seed: false
    });
    const viewer = await platform.access.createApiKey(
      { name: "Read only", role: "viewer" },
      platform.access.rootPrincipal()
    );
    const scoped = await platform.access.createApiKey(
      {
        name: "Scoped integration",
        role: "integration",
        allowed_location_ids: ["location-001"]
      },
      platform.access.rootPrincipal()
    );
    const running = await startReferenceServer(platform.engine, {
      apiKey: "platform-auth-root-key",
      admin: {
        campaigns: platform.campaigns,
        customerData: platform.customerData,
        access: platform.access
      }
    });
    try {
      const viewerRead = await fetch(`${running.url}/platform/v1/members`, {
        headers: { authorization: `Bearer ${viewer.secret}` }
      });
      expect(viewerRead.status).toBe(200);
      const viewerWrite = await fetch(`${running.url}/platform/v1/members`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${viewer.secret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ member_id: "member-001" })
      });
      expect(viewerWrite.status).toBe(403);
      expect(await viewerWrite.json()).toMatchObject({ code: "forbidden" });

      const scopedRead = await fetch(`${running.url}/platform/v1/members`, {
        headers: { authorization: `Bearer ${scoped.secret}` }
      });
      expect(scopedRead.status).toBe(403);
      expect(await scopedRead.json()).toMatchObject({ code: "location_scoped_forbidden" });
    } finally {
      await running.close();
      await platform.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
