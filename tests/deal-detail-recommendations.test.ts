import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as dealDetail } from "@/app/api/crm/deals/[id]/route";
import { disconnectAppDb } from "@/server/db/client";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { runOpportunityHealth } from "@/server/opportunity-health/opportunity-health.service";

import type { FakeHubSpot } from "./support/fake-hubspot";
import { closeOwnerDb, createOrgFixture, ownerDb } from "./support/fixtures";
import { connectHubSpotFixture, installOpportunityHealth, isoDaysAgo } from "./support/hubspot-fixtures";
import { startFakeHubSpotEnv } from "./support/hubspot-env";
import { authedRequest as req, routeParams } from "./support/requests";

let hubspot: FakeHubSpot;

beforeAll(async () => {
  hubspot = await startFakeHubSpotEnv();
});
afterAll(async () => {
  await hubspot.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

describe("deal detail: open vs resolved recommendations (regression)", () => {
  it("shows the open recommendation as the issue, then — once resolved — only as history", async () => {
    // Reproduces the real-portal sequence: no next step → recommendation OPEN;
    // a next activity is scheduled in HubSpot → deal HEALTHY, recommendation RESOLVED.
    const org = await createOrgFixture("dealrecs");
    const admin = org.members.ADMIN;
    await installOpportunityHealth(org.organizationId);
    const { integrationId } = await connectHubSpotFixture(hubspot, admin, "247756835");
    const contact = hubspot.addContact("buyer@dealrecs-buyer.io");
    const deal = hubspot.addDeal(
      { dealname: "Tracklibute Test Deal 01", createdate: isoDaysAgo(1), notes_last_updated: isoDaysAgo(1), notes_next_activity_date: null },
      { contacts: [contact.id] },
    );
    await syncHubSpot(admin, { trigger: "manual" });
    await runOpportunityHealth(admin, { trigger: "cron" });

    const row = await ownerDb().crmDeal.findFirstOrThrow({ where: { integrationId, externalId: deal.id } });
    const detail = async () => (await (await dealDetail(req(`/api/crm/deals/${row.id}`, org.members.VIEWER), routeParams({ id: row.id }))).json()).data;

    const open = await detail();
    expect(open.health.state).toBe("NEEDS_ATTENTION");
    expect(open.recommendation).toMatchObject({ status: "OPEN", title: "Tracklibute Test Deal 01 has no next step scheduled" });
    expect(open.resolvedRecommendations).toEqual([]);

    hubspot.updateDeal(deal.id, { notes_next_activity_date: new Date(Date.now() + 7 * 86_400_000).toISOString() }, Date.now() + 2000);
    await syncHubSpot(admin, { trigger: "manual" });
    await runOpportunityHealth(admin, { trigger: "cron" });

    const resolved = await detail();
    expect(resolved.health.state).toBe("HEALTHY");
    expect(resolved.recommendation).toBeNull(); // never presented as an active issue
    expect(resolved.resolvedRecommendations).toHaveLength(1);
    expect(resolved.resolvedRecommendations[0]).toMatchObject({ status: "RESOLVED", title: "Tracklibute Test Deal 01 has no next step scheduled" });
    expect(resolved.resolvedRecommendations[0].resolvedAt).toEqual(expect.any(String));

    // The problem returns: the same recommendation reopens and is active again (lifecycle unchanged).
    hubspot.updateDeal(deal.id, { notes_next_activity_date: null }, Date.now() + 4000);
    await syncHubSpot(admin, { trigger: "manual" });
    await runOpportunityHealth(admin, { trigger: "cron" });
    const reopened = await detail();
    expect(reopened.recommendation).toMatchObject({ status: "OPEN" });
    expect(reopened.resolvedRecommendations).toEqual([]);
  });
});
