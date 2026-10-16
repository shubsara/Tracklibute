import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as cronRoute } from "@/app/api/internal/cron/hubspot-sync/route";
import { POST as syncRoute } from "@/app/api/integrations/hubspot/sync/route";
import type { CrmSource } from "@/domain/crm/types";
import { disconnectAppDb } from "@/server/db/client";
import { createHubSpotCrmSource } from "@/server/integrations/hubspot/hubspot.adapter";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";

import { VirtualClock } from "./support/fake-google";
import type { FakeHubSpot } from "./support/fake-hubspot";
import { closeOwnerDb, createOrgFixture, ownerDb } from "./support/fixtures";
import { connectHubSpotFixture, isoDaysAgo } from "./support/hubspot-fixtures";
import { SPEC03_CRON_SECRET, startFakeHubSpotEnv } from "./support/hubspot-env";
import { authedRequest as req } from "./support/requests";

let hubspot: FakeHubSpot;
let n = 0;

beforeAll(async () => {
  hubspot = await startFakeHubSpotEnv();
});
afterAll(async () => {
  await hubspot.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

/** Fresh org + connected portal; the fake portal is reset for each test. */
async function setup() {
  hubspot.deals.clear();
  hubspot.contacts.clear();
  hubspot.companies.clear();
  hubspot.owners = [];
  hubspot.failures = [];
  hubspot.rateLimit = null;
  hubspot.daily = null;
  hubspot.searchCap = 10_000;
  hubspot.searchPageSize = 200;
  const org = await createOrgFixture(`hssync${n++}`);
  const admin = org.members.ADMIN;
  const { integrationId } = await connectHubSpotFixture(hubspot, admin, `90${n}`);
  return { org, admin, integrationId };
}
const deals = (integrationId: string) => ownerDb().crmDeal.findMany({ where: { integrationId }, orderBy: { externalId: "asc" }, include: { contacts: true, companies: true } });
const integration = (id: string) => ownerDb().integration.findUniqueOrThrow({ where: { id } });

describe("full reconcile", () => {
  it("mirrors owners, stages, deals and ONLY deal-associated contacts/companies; auto-maps owners by email", async () => {
    const { org, admin, integrationId } = await setup();
    const owner = hubspot.addOwner({ email: org.members.MEMBER.email.toUpperCase(), firstName: "Mem", lastName: "Ber" });
    hubspot.addOwner({ email: "stranger@elsewhere.test" });
    const c1 = hubspot.addContact("pat@buyer.io");
    hubspot.addContact("unrelated@nobody.io"); // never associated → never fetched
    const co = hubspot.addCompany("https://www.buyer.io");
    hubspot.addDeal({ dealname: "Buyer expansion", amount: "5000", hubspot_owner_id: owner.id, closedate: isoDaysAgo(-20) }, { contacts: [c1.id], companies: [co.id] });
    hubspot.addDeal({ dealname: "Won deal", dealstage: "closedwon" });

    const r = await syncHubSpot(admin, { trigger: "manual" });
    expect(r).toMatchObject({ mode: "full", outcome: "completed", dealsUpserted: 2, contactsUpserted: 1, companiesUpserted: 1, ownersUpserted: 2, ownersAutoMapped: 1 });

    const rows = await deals(integrationId);
    expect(rows.map((d) => [d.name, d.isClosed])).toEqual([["Buyer expansion", false], ["Won deal", true]]);
    expect(rows[0]!.contacts).toHaveLength(1);
    expect(rows[0]!.companies).toHaveLength(1);
    expect(rows[0]!.amount?.toFixed(2)).toBe("5000.00");
    expect(await ownerDb().crmContact.findMany({ where: { integrationId }, select: { email: true } })).toEqual([{ email: "pat@buyer.io" }]);
    expect((await ownerDb().crmCompany.findFirstOrThrow({ where: { integrationId } })).domain).toBe("buyer.io");
    const mapping = await ownerDb().crmOwnerMapping.findFirstOrThrow({ where: { organizationId: org.organizationId } });
    expect(mapping).toMatchObject({ userId: org.members.MEMBER.userId, source: "AUTO_EMAIL" });
    expect(await ownerDb().crmPipelineStage.count({ where: { integrationId } })).toBe(4);

    const row = await integration(integrationId);
    expect(row.fullSyncedAt).not.toBeNull();
    expect(row.backfillCursor).toBeNull();
    expect(JSON.parse(row.syncCursor!)).toMatchObject({ v: 1, watermark: expect.any(Number) });
    expect(row.syncLeaseExpiresAt).toBeNull();
    expect(hubspot.writeRequests()).toEqual([]);
    expect(hubspot.unexpected).toEqual([]);
  });

  it("is idempotent: a second full pass creates no duplicates", async () => {
    const { admin, integrationId } = await setup();
    const c = hubspot.addContact("a@x.io");
    hubspot.addDeal({ dealname: "D1" }, { contacts: [c.id] });
    await syncHubSpot(admin, { trigger: "manual" });
    await syncHubSpot(admin, { trigger: "manual", forceFull: true });
    expect(await ownerDb().crmDeal.count({ where: { integrationId } })).toBe(1);
    expect(await ownerDb().crmContact.count({ where: { integrationId } })).toBe(1);
    expect(await ownerDb().crmDealContact.count({ where: { deal: { integrationId } } })).toBe(1);
  });

  it("archives deals that disappeared — only after a COMPLETE pass", async () => {
    const { admin, integrationId } = await setup();
    const keep = hubspot.addDeal({ dealname: "Keep" });
    const gone = hubspot.addDeal({ dealname: "Gone" });
    await syncHubSpot(admin, { trigger: "manual" });
    hubspot.deals.delete(gone.id);
    const r = await syncHubSpot(admin, { trigger: "manual", forceFull: true });
    expect(r.dealsArchived).toBe(1);
    const rows = await deals(integrationId);
    expect(rows.find((d) => d.externalId === gone.id)!.archivedAt).not.toBeNull();
    expect(rows.find((d) => d.externalId === keep.id)!.archivedAt).toBeNull();
  });

  it("time-boxed: a partial pass checkpoints, archives nothing, and the next run resumes", async () => {
    const { admin, integrationId } = await setup();
    for (let i = 0; i < 250; i++) hubspot.addDeal({ dealname: `Bulk ${i}` });
    const clock = new VirtualClock();
    const real = createHubSpotCrmSource(admin, integrationId, { clock, requestsPer10s: 1_000_000, searchPerSecond: 1_000_000 });
    const deadlineAt = clock.now() + 60_000;
    // Expire the run budget right after the first page.
    const source: CrmSource = Object.assign(Object.create(Object.getPrototypeOf(real)) as CrmSource, real, {
      listDeals: async (after?: string) => {
        const page = await real.listDeals(after);
        clock.t = deadlineAt + 1;
        return page;
      },
    });
    const first = await syncHubSpot(admin, { trigger: "manual", source, clock, deadlineAt });
    expect(first).toMatchObject({ mode: "full", outcome: "partial", dealsUpserted: 100, dealsArchived: 0 });
    const mid = await integration(integrationId);
    expect(JSON.parse(mid.backfillCursor!)).toMatchObject({ after: "100" });
    expect(mid.fullSyncedAt).toBeNull();
    expect(mid.syncLeaseExpiresAt).toBeNull();
    expect(mid.lastError).toBeNull();

    const second = await syncHubSpot(admin, { trigger: "manual" });
    expect(second).toMatchObject({ mode: "full", outcome: "completed", resumed: true, dealsUpserted: 150 });
    expect(await ownerDb().crmDeal.count({ where: { integrationId, archivedAt: null } })).toBe(250);
  });
});

describe("incremental", () => {
  it("fetches only deals modified since the watermark; associations via v4 batch read", async () => {
    const { admin, integrationId } = await setup();
    const old = hubspot.addDeal({ dealname: "Old", hs_lastmodifieddate: isoDaysAgo(10) });
    await syncHubSpot(admin, { trigger: "manual" });
    const c = hubspot.addContact("new@buyer.io");
    const fresh = hubspot.addDeal({ dealname: "Fresh", hs_lastmodifieddate: new Date(Date.now() + 1000).toISOString() }, { contacts: [c.id] });
    hubspot.requests = [];
    const r = await syncHubSpot(admin, { trigger: "manual" });
    expect(r).toMatchObject({ mode: "incremental", outcome: "completed", dealsUpserted: 1, contactsUpserted: 1 });
    expect(hubspot.requests).toContain("POST /crm/v3/objects/deals/search");
    expect(hubspot.requests).toContain("POST /crm/v4/associations/deals/contacts/batch/read");
    expect(hubspot.requests).not.toContain("GET /crm/v3/objects/deals");
    const rows = await deals(integrationId);
    expect(rows.find((d) => d.externalId === fresh.id)!.contacts).toHaveLength(1);
    expect(rows.find((d) => d.externalId === old.id)).toBeTruthy();
    expect(hubspot.writeRequests()).toEqual([]);
  });

  it("re-anchors the watermark when HubSpot's search result window is exhausted", async () => {
    const { admin, integrationId } = await setup();
    await syncHubSpot(admin, { trigger: "manual" });
    const base = Date.now() + 5_000;
    for (let i = 0; i < 7; i++) hubspot.addDeal({ dealname: `M${i}`, hs_lastmodifieddate: new Date(base + i * 1000).toISOString() });
    hubspot.searchPageSize = 2;
    hubspot.searchCap = 4;
    const source = createHubSpotCrmSource(admin, integrationId, { searchResultCap: 4, requestsPer10s: 1_000_000, searchPerSecond: 1_000_000 });
    const r = await syncHubSpot(admin, { trigger: "manual", source });
    expect(r.outcome).toBe("completed");
    expect(await ownerDb().crmDeal.count({ where: { integrationId } })).toBe(7);
    expect(JSON.parse((await integration(integrationId)).syncCursor!).watermark).toBe(base + 6000);
  });

  it("re-runs a full reconcile once a day", async () => {
    const { admin, integrationId } = await setup();
    await syncHubSpot(admin, { trigger: "manual" });
    await ownerDb().integration.update({ where: { id: integrationId }, data: { fullSyncedAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect((await syncHubSpot(admin, { trigger: "manual" })).mode).toBe("full");
  });
});

describe("limits and safety", () => {
  it("adapts to X-HubSpot-RateLimit headers before hitting a 429", async () => {
    const { admin, integrationId } = await setup();
    for (let i = 0; i < 3; i++) hubspot.addDeal({ dealname: `R${i}` }, { contacts: [hubspot.addContact(`r${i}@x.io`).id] });
    const clock = new VirtualClock();
    hubspot.clock = clock;
    hubspot.rateLimit = { perWindow: 3, windowMs: 2_000 };
    try {
      const source = createHubSpotCrmSource(admin, integrationId, { clock });
      const r = await syncHubSpot(admin, { trigger: "manual", source, clock, deadlineAt: Number.POSITIVE_INFINITY });
      expect(r.outcome).toBe("completed");
      expect(hubspot.rateLimited).toBe(0);
      expect(clock.sleeps).toContain(2000); // waited for the rolling window
    } finally {
      hubspot.rateLimit = null;
      hubspot.clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    }
  });

  it("backs off on a 429 (Retry-After) and completes", async () => {
    const { admin, integrationId } = await setup();
    hubspot.addDeal({ dealname: "D" });
    hubspot.fail(/^\/crm\/v3\/objects\/deals$/, 429, 2, { status: "error", errorType: "RATE_LIMIT", policyName: "TEN_SECONDLY_ROLLING" }, { "retry-after": "1" });
    const clock = new VirtualClock();
    const source = createHubSpotCrmSource(admin, integrationId, { clock });
    const r = await syncHubSpot(admin, { trigger: "manual", source, clock, deadlineAt: Number.POSITIVE_INFINITY });
    expect(r).toMatchObject({ outcome: "completed", dealsUpserted: 1 });
    expect(clock.sleeps.filter((x) => x === 1000)).toHaveLength(2);
  });

  it("stops PARTIAL (not failed) when the daily allowance reserve is reached", async () => {
    const { admin, integrationId } = await setup();
    hubspot.addDeal({ dealname: "D" });
    hubspot.daily = { max: 250_000, remaining: 50 };
    const r = await syncHubSpot(admin, { trigger: "manual" });
    expect(r.outcome).toBe("partial");
    expect((await integration(integrationId)).lastError).toBeNull();
  });

  it("only ADMIN can sync; one sync at a time", async () => {
    const { org, admin, integrationId } = await setup();
    expect((await syncRoute(req("/api/integrations/hubspot/sync", org.members.MEMBER, { method: "POST" }))).status).toBe(403);
    await ownerDb().integration.update({ where: { id: integrationId }, data: { syncLeaseExpiresAt: new Date(Date.now() + 60_000) } });
    await expect(syncHubSpot(admin, { trigger: "manual" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("transient failures keep progress and leave the integration CONNECTED", async () => {
    const { admin, integrationId } = await setup();
    hubspot.fail(/^\/crm\/v3\/owners$/, 503, 10);
    await expect(syncHubSpot(admin, { trigger: "manual" })).rejects.toMatchObject({ code: "upstream_error" });
    const row = await integration(integrationId);
    expect(row.status).toBe("CONNECTED");
    expect(row.lastError).toMatch(/temporarily unavailable/);
    expect(row.syncLeaseExpiresAt).toBeNull();
  });

  it("missing scopes at the API (403 MISSING_SCOPES) require reconnecting", async () => {
    const { admin, integrationId } = await setup();
    hubspot.fail(/^\/crm\/v3\/owners$/, 403, 1, { status: "error", category: "MISSING_SCOPES" });
    await expect(syncHubSpot(admin, { trigger: "manual" })).rejects.toMatchObject({ code: "policy_violation" });
    expect((await integration(integrationId)).status).toBe("REAUTH_REQUIRED");
  });
});

describe("cron", () => {
  it("rejects a missing / wrong secret and syncs due portals with the right one", async () => {
    const { integrationId } = await setup();
    hubspot.addDeal({ dealname: "Cron deal" });
    expect((await cronRoute(new Request("http://localhost/api/internal/cron/hubspot-sync", { method: "POST" }))).status).toBe(401);
    expect((await cronRoute(new Request("http://localhost/api/internal/cron/hubspot-sync", { method: "POST", headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    // Other test files leave CONNECTED portals behind (dead fake tokens): retire them.
    await ownerDb().integration.updateMany({
      where: { provider: "HUBSPOT", status: "CONNECTED", id: { not: integrationId } },
      data: { status: "DISCONNECTED" },
    });
    const res = await cronRoute(new Request("http://localhost/api/internal/cron/hubspot-sync", { method: "POST", headers: { authorization: `Bearer ${SPEC03_CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results.find((x: { integrationId: string }) => x.integrationId === integrationId)).toMatchObject({ outcome: "succeeded" });
    const audit = await ownerDb().auditLog.findFirst({ where: { entityId: integrationId, event: "hubspot.sync_completed" } });
    expect(audit?.actorType).toBe("SYSTEM");
  });
});
