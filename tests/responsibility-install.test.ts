import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `after()` needs a live Next.js request scope; in tests run the callback and
// keep its promise so the test can await it (same code path as production).
const pending = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: Promise<unknown> | (() => unknown)) => {
      pending.push(Promise.resolve(typeof task === "function" ? task() : task));
    },
  };
});

import { GET as hubspotStatus } from "@/app/api/integrations/hubspot/route";
import { POST as syncRoute } from "@/app/api/integrations/hubspot/sync/route";
import { POST as createOrg } from "@/app/api/organizations/route";
import { POST as installRoute } from "@/app/api/responsibilities/system/route";
import type { AuthContext } from "@/domain/auth/auth-context";
import { SYSTEM_TEMPLATE_KEYS } from "@/domain/responsibilities/templates";
import { disconnectAppDb } from "@/server/db/client";
import { runHubSpotCronSync } from "@/server/integrations/hubspot/hubspot-cron.service";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { installSystemResponsibilities } from "@/server/responsibilities/responsibilities.service";

import { bearer, signIn } from "./support/auth-flow";
import type { FakeGoogle } from "./support/fake-google";
import type { FakeHubSpot } from "./support/fake-hubspot";
import { closeOwnerDb, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";
import { connectGmailFixture } from "./support/gmail-fixtures";
import { captureConsole, startFakeGoogleEnv } from "./support/google-env";
import { connectHubSpotFixture, isoDaysAgo } from "./support/hubspot-fixtures";
import { startFakeHubSpotEnv } from "./support/hubspot-env";
import { authedRequest as req } from "./support/requests";

let google: FakeGoogle;
let hubspot: FakeHubSpot;
let n = 0;

beforeAll(async () => {
  google = await startFakeGoogleEnv();
  hubspot = await startFakeHubSpotEnv();
});
afterAll(async () => {
  await google.stop();
  await hubspot.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});
beforeEach(() => {
  pending.length = 0;
  hubspot.deals.clear();
  hubspot.contacts.clear();
  hubspot.companies.clear();
  hubspot.owners = [];
  hubspot.failures = [];
});
const flushAfter = async () => {
  while (pending.length) await pending.shift();
};

const templateKeys = async (organizationId: string) =>
  (await ownerDb().responsibility.findMany({ where: { organizationId, type: "SYSTEM" }, select: { templateKey: true } }))
    .map((r) => r.templateKey)
    .sort();
const install = (auth: AuthContext | null, body?: unknown) =>
  installRoute(
    req("/api/responsibilities/system", auth, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );

/** The reported real-world shape: an org created before onboarding installed responsibilities, HubSpot + Gmail connected, one synced deal with no contacts/companies. */
async function brokenOrgWithSyncedDeal(): Promise<{ org: OrgFixture; integrationId: string; gmailIntegrationId: string }> {
  const org = await createOrgFixture(`repair${n++}`);
  // The fixture only has lead_health — Opportunity Health is missing, as in the field.
  const { integrationId } = await connectHubSpotFixture(hubspot, org.members.ADMIN, `24775${n}`);
  const { integrationId: gmailIntegrationId } = await connectGmailFixture(google, org.members.MEMBER, `rep-${org.slug}@seller.test`);
  hubspot.addDeal({ dealname: "Tracklibute Test Deal 01", createdate: isoDaysAgo(1), notes_next_activity_date: isoDaysAgo(-5) });
  await syncHubSpot(org.members.ADMIN, { trigger: "manual" });
  return { org, integrationId, gmailIntegrationId };
}

describe("new organizations", () => {
  it("onboarding installs every SYSTEM responsibility (incl. an ACTIVE Opportunity Health)", async () => {
    // Unique per run: the test database persists between runs.
    const u = randomUUID().slice(0, 8);
    const { token } = await signIn(google, { sub: `sub-ri-${u}`, email: `founder-ri-${u}@example.com` });
    const res = await createOrg(
      new Request("http://localhost/api/organizations", {
        method: "POST",
        headers: { ...bearer(token!), "content-type": "application/json" },
        body: JSON.stringify({ name: "Fresh Co" }),
      }),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(await templateKeys(data.organizationId)).toEqual([...SYSTEM_TEMPLATE_KEYS].sort());
    const oh = await ownerDb().responsibility.findFirstOrThrow({ where: { organizationId: data.organizationId, templateKey: "opportunity_health" } });
    expect(oh).toMatchObject({ status: "ACTIVE", type: "SYSTEM" });
    expect(await ownerDb().auditLog.count({ where: { organizationId: data.organizationId, event: "responsibility.created" } })).toBe(SYSTEM_TEMPLATE_KEYS.length);
  });
});

describe("idempotent installation", () => {
  it("re-running installs nothing and never touches existing config or status", async () => {
    const org = await createOrgFixture(`idem${n++}`);
    const admin = org.members.ADMIN;
    const lead = await ownerDb().responsibility.findFirstOrThrow({ where: { organizationId: org.organizationId, templateKey: "lead_health" } });
    await ownerDb().responsibility.update({ where: { id: lead.id }, data: { status: "PAUSED", config: { firstTouchWithinHours: 4, staleAfterDays: 9 } } });

    expect(await installSystemResponsibilities(admin)).toBe(SYSTEM_TEMPLATE_KEYS.length - 1);
    expect(await installSystemResponsibilities(admin)).toBe(0);
    expect(await templateKeys(org.organizationId)).toEqual([...SYSTEM_TEMPLATE_KEYS].sort());
    expect(await ownerDb().responsibility.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: "PAUSED",
      config: { firstTouchWithinHours: 4, staleAfterDays: 9 },
    });
  });

  it("is safe under concurrent calls (no duplicates, no unique-violation errors)", async () => {
    const org = await createOrgFixture(`race${n++}`);
    const results = await Promise.all([1, 2, 3].map(() => installSystemResponsibilities(org.members.ADMIN)));
    expect(results.reduce((a, b) => a + b, 0)).toBe(SYSTEM_TEMPLATE_KEYS.length - 1);
    expect(await ownerDb().responsibility.count({ where: { organizationId: org.organizationId, templateKey: "opportunity_health" } })).toBe(1);
  });
});

describe("post-sync Opportunity Health failures are observable", () => {
  it("a completed manual sync whose health run fails logs it, records it, and surfaces it in the HubSpot status", async () => {
    const { org } = await brokenOrgWithSyncedDeal();
    const logs = captureConsole();
    try {
      const res = await syncRoute(req("/api/integrations/hubspot/sync", org.members.ADMIN, { method: "POST" }));
      expect(res.status).toBe(200);
      await flushAfter();
    } finally {
      logs.restore();
    }
    const line = logs.lines.find((l) => l.includes('"opportunity_health.post_sync_failed"'));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!)).toMatchObject({ level: "error", organizationId: org.organizationId, syncTrigger: "manual", errorCode: "not_found" });
    expect(logs.lines.join("\n")).not.toMatch(/hat-|hrt-|client_secret/);

    const audit = await ownerDb().auditLog.findFirstOrThrow({ where: { organizationId: org.organizationId, event: "opportunity_health.post_sync_failed" } });
    expect(audit).toMatchObject({ actorType: "SYSTEM", metadata: { errorCode: "not_found", syncTrigger: "manual" } });

    const status = (await (await hubspotStatus(req("/api/integrations/hubspot", org.members.VIEWER))).json()).data;
    expect(status.opportunityHealth).toMatchObject({ installed: false, lastFailure: { errorCode: "not_found" } });
    expect(status.opportunityHealth.lastFailure.message).toMatch(/not installed/);
  });

  it("cron reports the post-sync health outcome instead of discarding it", async () => {
    const { org, integrationId } = await brokenOrgWithSyncedDeal();
    await ownerDb().integration.updateMany({
      where: { provider: "HUBSPOT", status: "CONNECTED", id: { not: integrationId } },
      data: { status: "DISCONNECTED" },
    });
    const summary = await runHubSpotCronSync();
    expect(summary.results.find((r) => r.integrationId === integrationId)).toMatchObject({ outcome: "succeeded", health: "failed", healthErrorCode: "not_found" });
    expect(await ownerDb().auditLog.count({ where: { organizationId: org.organizationId, event: "opportunity_health.post_sync_failed" } })).toBe(1);
  });
});

describe("repairing an existing organization", () => {
  it("ADMIN installs the missing responsibilities and runs Opportunity Health — connections untouched, deal evaluated UNTRACKABLE / NEEDS_ATTENTION", async () => {
    const { org, integrationId, gmailIntegrationId } = await brokenOrgWithSyncedDeal();
    const before = await ownerDb().integration.findMany({ where: { organizationId: org.organizationId }, select: { id: true, status: true, encryptedCredentials: true } });

    const res = await install(org.members.ADMIN, { runOpportunityHealth: true });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.created).toBe(SYSTEM_TEMPLATE_KEYS.length - 1);
    expect(data.opportunityHealth).toMatchObject({ status: "succeeded", result: { dealsEvaluated: 1, needsAttention: 1 } });

    const deal = await ownerDb().crmDeal.findFirstOrThrow({ where: { integrationId, name: "Tracklibute Test Deal 01" }, include: { health: true } });
    expect(deal.health?.state).toBe("NEEDS_ATTENTION");
    expect((deal.health?.reasons as { reasons: Array<{ code: string }> }).reasons.map((r) => r.code)).toEqual(["UNTRACKABLE"]);
    const rec = await ownerDb().recommendation.findFirstOrThrow({ where: { dealId: deal.id } });
    expect(rec).toMatchObject({ status: "OPEN", severity: "MEDIUM", title: "Tracklibute Test Deal 01 has no contacts to track" });

    // HubSpot and Gmail connections are exactly as they were.
    const after = await ownerDb().integration.findMany({ where: { organizationId: org.organizationId }, select: { id: true, status: true, encryptedCredentials: true } });
    expect(after).toEqual(before);
    expect(after.find((i) => i.id === gmailIntegrationId)?.status).toBe("CONNECTED");

    // The status now shows a successful run and no outstanding failure.
    const status = (await (await hubspotStatus(req("/api/integrations/hubspot", org.members.VIEWER))).json()).data.opportunityHealth;
    expect(status).toMatchObject({ installed: true, responsibilityStatus: "ACTIVE", lastRun: { status: "SUCCEEDED", dealsEvaluated: 1 }, lastFailure: null });

    // Repeating the repair is a no-op.
    expect((await (await install(org.members.ADMIN)).json()).data).toMatchObject({ created: 0, opportunityHealth: null });
  });

  it("after repair, a completed HubSpot sync triggers the health evaluation", async () => {
    const { org, integrationId } = await brokenOrgWithSyncedDeal();
    await install(org.members.ADMIN);
    hubspot.updateDeal([...hubspot.deals.keys()][0]!, { dealname: "Tracklibute Test Deal 01 (renamed)" }, Date.now() + 2000);
    const res = await syncRoute(req("/api/integrations/hubspot/sync", org.members.ADMIN, { method: "POST" }));
    expect(res.status).toBe(200);
    await flushAfter();
    const deal = await ownerDb().crmDeal.findFirstOrThrow({ where: { integrationId }, include: { health: true } });
    expect(deal.health?.state).toBe("NEEDS_ATTENTION");
    const run = await ownerDb().responsibilityRun.findFirstOrThrow({ where: { organizationId: org.organizationId }, orderBy: { createdAt: "desc" } });
    expect(run).toMatchObject({ status: "SUCCEEDED", summary: { trigger: "sync", dealsEvaluated: 1 } });
  });
});

describe("repair route authorization and isolation", () => {
  it("requires ADMIN; MEMBER / VIEWER / anonymous are refused and nothing is installed", async () => {
    const org = await createOrgFixture(`authz${n++}`);
    expect((await install(null)).status).toBe(401);
    expect((await install(org.members.MEMBER)).status).toBe(403);
    expect((await install(org.members.VIEWER)).status).toBe(403);
    expect(await templateKeys(org.organizationId)).toEqual(["lead_health"]);
    expect((await install(org.members.OWNER)).status).toBe(200);
  });

  it("installs only into the caller's own organization; ids in the body are ignored", async () => {
    const a = await createOrgFixture(`isoa${n++}`);
    const b = await createOrgFixture(`isob${n++}`);
    const res = await install(b.members.ADMIN, { organizationId: a.organizationId, runOpportunityHealth: false });
    expect(res.status).toBe(200);
    expect(await templateKeys(b.organizationId)).toEqual([...SYSTEM_TEMPLATE_KEYS].sort());
    expect(await templateKeys(a.organizationId)).toEqual(["lead_health"]);
  });
});
