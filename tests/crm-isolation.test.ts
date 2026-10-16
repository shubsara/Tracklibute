import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PUT as putMapping } from "@/app/api/crm/owners/[id]/mapping/route";
import { GET as ownersList } from "@/app/api/crm/owners/route";
import type { AuthContext } from "@/domain/auth/auth-context";
import { disconnectAppDb, getAppDb } from "@/server/db/client";
import { withOrgScope } from "@/server/db/org-scope";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { runOpportunityHealth } from "@/server/opportunity-health/opportunity-health.service";

import type { FakeHubSpot } from "./support/fake-hubspot";
import { closeOwnerDb, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";
import { connectHubSpotFixture, installOpportunityHealth } from "./support/hubspot-fixtures";
import { startFakeHubSpotEnv } from "./support/hubspot-env";
import { authedRequest as req, routeParams } from "./support/requests";

let hubspot: FakeHubSpot;
let A: OrgFixture;
let B: OrgFixture;
let integrationA: string;
let ownerExt: string;

const TABLES = [
  "crm_owners",
  "crm_owner_mappings",
  "crm_pipeline_stages",
  "crm_companies",
  "crm_contacts",
  "crm_deals",
  "crm_deal_contacts",
  "crm_deal_companies",
  "opportunity_health",
  "email_activities",
] as const;

beforeAll(async () => {
  hubspot = await startFakeHubSpotEnv();
  A = await createOrgFixture("crmisoa");
  B = await createOrgFixture("crmisob");
  integrationA = (await connectHubSpotFixture(hubspot, A.members.ADMIN, "8001")).integrationId;
  await connectHubSpotFixture(hubspot, B.members.ADMIN, "8002");
  ownerExt = hubspot.addOwner({ email: A.members.MEMBER.email }).id;
  const c = hubspot.addContact("buyer@a-customer.io");
  const co = hubspot.addCompany("a-customer.io");
  hubspot.addDeal({ dealname: "A secret deal", hubspot_owner_id: ownerExt }, { contacts: [c.id], companies: [co.id] });
  await syncHubSpot(A.members.ADMIN, { trigger: "manual" });
  await installOpportunityHealth(A.organizationId);
  await runOpportunityHealth(A.members.ADMIN, { trigger: "cron" });
});
afterAll(async () => {
  await hubspot.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

const countAs = (auth: AuthContext, table: string) =>
  withOrgScope(auth, async (tx) => (await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n);

describe("RLS on every Spec 03 table", () => {
  it("RLS is enabled with policies, and the app role is not the owner", async () => {
    const rows = await ownerDb().$queryRaw<{ relname: string; relrowsecurity: boolean; owner: string; policies: number }[]>`
      SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) AS owner,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
        FROM pg_class c WHERE c.relname = ANY(${[...TABLES]}::text[])`;
    expect(rows).toHaveLength(TABLES.length);
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.policies, r.relname).toBeGreaterThan(0);
      expect(r.owner).not.toBe("tracklibute_app");
    }
  });

  it("org A sees its rows; org B sees none of A's; no context sees nothing", async () => {
    for (const t of ["crm_owners", "crm_pipeline_stages", "crm_companies", "crm_contacts", "crm_deals", "crm_deal_contacts", "crm_deal_companies", "opportunity_health", "crm_owner_mappings"]) {
      expect(await countAs(A.members.VIEWER, t), t).toBeGreaterThan(0);
    }
    await withOrgScope(B.members.OWNER, async (tx) => {
      expect(await tx.crmDeal.count({ where: { organizationId: A.organizationId } })).toBe(0);
      expect(await tx.crmContact.count({ where: { organizationId: A.organizationId } })).toBe(0);
      expect(await tx.opportunityHealth.count({ where: { organizationId: A.organizationId } })).toBe(0);
      expect(await tx.crmOwnerMapping.count({ where: { organizationId: A.organizationId } })).toBe(0);
    });
    const raw = await getAppDb().$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM crm_deals`);
    expect(raw[0]!.n).toBe(0);
  });

  it("org B cannot write into org A (WITH CHECK) or modify A's rows", async () => {
    await expect(
      withOrgScope(B.members.OWNER, (tx) => tx.crmDeal.create({ data: { organizationId: A.organizationId, integrationId: integrationA, externalId: "evil", name: "x" } })),
    ).rejects.toThrow();
    const updated = await withOrgScope(B.members.OWNER, (tx) => tx.crmDeal.updateMany({ where: { integrationId: integrationA }, data: { name: "pwned" } }));
    expect(updated.count).toBe(0);
    const deleted = await withOrgScope(B.members.OWNER, (tx) => tx.crmDeal.deleteMany({ where: { integrationId: integrationA } }));
    expect(deleted.count).toBe(0);
    expect(await ownerDb().crmDeal.count({ where: { integrationId: integrationA, name: "A secret deal" } })).toBe(1);
  });

  it("composite FKs stop cross-tenant references even for the owner role", async () => {
    const deal = await ownerDb().crmDeal.findFirstOrThrow({ where: { integrationId: integrationA } });
    const bRec = await ownerDb().recommendation.findUniqueOrThrow({ where: { id: B.recommendationId } });
    await expect(ownerDb().recommendation.update({ where: { id: bRec.id }, data: { dealId: deal.id } })).rejects.toThrow();
    await expect(
      ownerDb().crmOwnerMapping.create({ data: { organizationId: A.organizationId, crmOwnerId: (await ownerDb().crmOwner.findFirstOrThrow({ where: { integrationId: integrationA } })).id, userId: B.members.MEMBER.userId, source: "MANUAL" } }),
    ).rejects.toThrow();
  });

  it("at most one org-wide HubSpot integration per organization (partial unique index)", async () => {
    await expect(ownerDb().integration.create({ data: { organizationId: A.organizationId, provider: "HUBSPOT" } })).rejects.toThrow();
  });

  it("definer helpers expose only the caller's organization", async () => {
    const ids = await withOrgScope(B.members.OWNER, (tx) => tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text FROM app_connected_mailbox_user_ids()`);
    expect(ids).toEqual([]);
    await expect(getAppDb().$queryRaw`SELECT app_org_system_actor(${A.organizationId}::uuid, NULL)`).rejects.toThrow(/permission denied/);
  });
});

describe("owner → member mapping", () => {
  it("lists owners with their auto mapping to any member", async () => {
    const body = (await (await ownersList(req("/api/crm/owners", A.members.VIEWER))).json()).data;
    const owner = body.owners.find((o: { externalId: string }) => o.externalId === ownerExt);
    expect(owner.mapping).toMatchObject({ userId: A.members.MEMBER.userId, source: "AUTO_EMAIL" });
  });

  it("only ADMIN can map; only to members of the same organization; manual survives sync", async () => {
    const owner = await ownerDb().crmOwner.findFirstOrThrow({ where: { integrationId: integrationA, externalId: ownerExt } });
    const put = (auth: AuthContext, userId: string) =>
      putMapping(req(`/api/crm/owners/${owner.id}/mapping`, auth, { method: "PUT", body: JSON.stringify({ userId }), headers: { "content-type": "application/json" } }), routeParams({ id: owner.id }));
    expect((await put(A.members.MEMBER, A.members.VIEWER.userId)).status).toBe(403);
    expect((await put(A.members.ADMIN, B.members.MEMBER.userId)).status).toBe(400);
    expect((await put(B.members.ADMIN, B.members.MEMBER.userId)).status).toBe(404);
    expect((await put(A.members.ADMIN, A.members.VIEWER.userId)).status).toBe(200);
    await syncHubSpot(A.members.ADMIN, { trigger: "manual", forceFull: true });
    expect(await ownerDb().crmOwnerMapping.findFirstOrThrow({ where: { crmOwnerId: owner.id } })).toMatchObject({ userId: A.members.VIEWER.userId, source: "MANUAL" });
  });

  it("removing a member removes their mapping (cascade)", async () => {
    const owner = await ownerDb().crmOwner.findFirstOrThrow({ where: { integrationId: integrationA, externalId: ownerExt } });
    await ownerDb().organizationMember.delete({ where: { organizationId_userId: { organizationId: A.organizationId, userId: A.members.VIEWER.userId } } });
    expect(await ownerDb().crmOwnerMapping.count({ where: { crmOwnerId: owner.id } })).toBe(0);
  });
});
