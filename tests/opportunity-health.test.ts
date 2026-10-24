import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as dealDetail } from "@/app/api/crm/deals/[id]/route";
import { GET as dealList } from "@/app/api/crm/deals/route";
import { POST as healthCron } from "@/app/api/internal/cron/opportunity-health/route";
import { POST as recAction } from "@/app/api/recommendations/[id]/[action]/route";
import { GET as recList } from "@/app/api/recommendations/route";
import { POST as runRoute } from "@/app/api/responsibilities/[id]/run/route";
import type { AuthContext } from "@/domain/auth/auth-context";
import { decideAction, executeAction, proposeAction } from "@/server/actions/actions.service";
import { disconnectAppDb } from "@/server/db/client";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { dedupeKeyForDeal, runOpportunityHealth } from "@/server/opportunity-health/opportunity-health.service";

import { type FakeGoogle, gmailMessage } from "./support/fake-google";
import type { FakeHubSpot } from "./support/fake-hubspot";
import { closeOwnerDb, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";
import { connectGmailFixture, daysAgo } from "./support/gmail-fixtures";
import { startFakeGoogleEnv } from "./support/google-env";
import { connectHubSpotFixture, installOpportunityHealth, isoDaysAgo } from "./support/hubspot-fixtures";
import { SPEC03_CRON_SECRET, startFakeHubSpotEnv } from "./support/hubspot-env";
import { authedRequest as req, routeParams } from "./support/requests";

let google: FakeGoogle;
let hubspot: FakeHubSpot;
let org: OrgFixture;
let admin: AuthContext; // runs health; NOT a mailbox owner
let rep: AuthContext & { email: string }; // mailbox owner; mapped HubSpot owner
let responsibilityId: string;
let integrationId: string;
const ext = {} as Record<"quiet" | "awaiting" | "healthy" | "overdue" | "won" | "unmapped" | "lonely" | "ghosted", string>;
const SUBJECT = "Secret discount ladder";
const BODY = "We can drop to 30% if pushed";

const health = async () => {
  const rows = await ownerDb().crmDeal.findMany({ where: { integrationId }, include: { health: true } });
  return Object.fromEntries(rows.map((d) => [d.name, d.health?.state ?? null]));
};
const recFor = async (dealName: string) => {
  const d = await ownerDb().crmDeal.findFirstOrThrow({ where: { integrationId, name: dealName } });
  return ownerDb().recommendation.findFirst({ where: { dedupeKey: dedupeKeyForDeal(d.id) } });
};
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  google = await startFakeGoogleEnv();
  hubspot = await startFakeHubSpotEnv();
  org = await createOrgFixture("oh");
  admin = org.members.ADMIN;
  rep = org.members.MEMBER;
  responsibilityId = (await installOpportunityHealth(org.organizationId)).id;
  integrationId = (await connectHubSpotFixture(hubspot, admin, "555001")).integrationId;

  const repOwner = hubspot.addOwner({ email: rep.email, firstName: "Rep" });
  const strangerOwner = hubspot.addOwner({ email: "contractor@agency.test", firstName: "Contractor" });
  const mk = (key: keyof typeof ext, email: string | null, props: Record<string, string | null>, ownerId = repOwner.id) => {
    const contacts = email ? [hubspot.addContact(email).id] : [];
    ext[key] = hubspot.addDeal({ dealname: key, hubspot_owner_id: ownerId, notes_next_activity_date: future(5), createdate: isoDaysAgo(60), ...props }, { contacts }).id;
  };
  // CRM-only inactivity fixture isolates INACTIVE from email-direction reasons.
  mk("quiet", "quiet@buyer-a.io", { notes_last_updated: isoDaysAgo(9) });
  mk("awaiting", "wait@buyer-b.io", {});
  mk("healthy", "happy@buyer-c.io", {});
  mk("overdue", "late@buyer-d.io", { closedate: isoDaysAgo(3) });
  mk("won", "won@buyer-e.io", { dealstage: "closedwon" });
  mk("unmapped", "x@buyer-f.io", { notes_last_updated: isoDaysAgo(1) }, strangerOwner.id);
  mk("lonely", null, { notes_last_updated: isoDaysAgo(1) });
  mk("ghosted", "ghosted@buyer-g.io", {});

  const address = `rep-${org.slug}@seller.test`;
  await connectGmailFixture(google, rep, address);
  const box = google.mailbox(address);
  const mail = (id: string, from: string, to: string, days: number, sent = false) =>
    box.add(gmailMessage({ id, threadId: `T-${id}`, from, to, subject: SUBJECT, plain: BODY, date: daysAgo(days), ...(sent ? { labelIds: ["SENT"] } : {}) }));
  mail("w-out", address, "wait@buyer-b.io", 6, true);
  mail("w-in", "wait@buyer-b.io", address, 4);
  mail("h-in", "happy@buyer-c.io", address, 2);
  mail("h-out", address, "happy@buyer-c.io", 1, true);
  mail("o-out", address, "late@buyer-d.io", 1, true);
  mail("g-out", address, "ghosted@buyer-g.io", 3, true);

  await syncHubSpot(admin, { trigger: "manual" });
  await syncGmailMailbox(rep, { trigger: "manual" });
});
afterAll(async () => {
  await google.stop();
  await hubspot.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

describe("Opportunity Health run", () => {
  it("evaluates every open deal deterministically from HubSpot + content-free Gmail activity (no Calendar)", async () => {
    expect(await ownerDb().integration.count({ where: { organizationId: org.organizationId, provider: "GOOGLE_CALENDAR" } })).toBe(0);
    const before = hubspot.requests.length;
    const r = await runOpportunityHealth(admin, { trigger: "cron" });
    expect(hubspot.requests.length).toBe(before); // no HubSpot calls at all
    expect(r).toMatchObject({ dealsEvaluated: 7, created: 5 });
    expect(await health()).toEqual({
      quiet: "NEEDS_ATTENTION",
      awaiting: "NEEDS_ATTENTION",
      healthy: "HEALTHY",
      overdue: "AT_RISK",
      won: null,
      unmapped: "HEALTHY",
      lonely: "NEEDS_ATTENTION",
      ghosted: "NEEDS_ATTENTION",
    });
    const quiet = await recFor("quiet");
    expect(quiet).toMatchObject({ status: "OPEN", severity: "MEDIUM", title: "quiet has gone quiet" });
    expect((await recFor("awaiting"))!.title).toBe("awaiting: the buyer is waiting for a reply");
    expect((await recFor("overdue"))!.severity).toBe("HIGH");
    expect((await recFor("lonely"))!.title).toBe("lonely has no contacts to track");
    expect((await recFor("ghosted"))!.title).toBe("ghosted: waiting for the buyer to reply");
    expect(await recFor("healthy")).toBeNull();
  });

  it("evidence and recommendations are metadata-only: no email subject or body anywhere", async () => {
    const recs = await ownerDb().recommendation.findMany({ where: { responsibilityId } });
    const healthRows = await ownerDb().opportunityHealth.findMany({ where: { organizationId: org.organizationId } });
    const dump = JSON.stringify({ recs, healthRows });
    expect(dump).not.toContain("Secret discount");
    expect(dump).not.toContain("drop to 30%");
    const ev = (await recFor("ghosted"))!.evidence as Record<string, unknown>;
    expect(Object.keys(ev).sort()).toEqual([
      "crmLastActivityAt", "deal", "emailCoverage", "lastActivityAt", "lastEmailAt", "lastInboundAt", "lastOutboundAt",
      "lastTouchMailboxUserId", "matchedCounterpartCount", "reasons", "state",
    ]);
    expect(ev).toMatchObject({ lastTouchMailboxUserId: rep.userId, matchedCounterpartCount: 1 });
  });

  it("limited signal: flagged when the deal owner is unmapped / has no Gmail connected", async () => {
    const byName = Object.fromEntries(
      (await ownerDb().crmDeal.findMany({ where: { integrationId }, include: { health: true } })).map((d) => [d.name, d.health?.reasons as { emailCoverage: { limitedSignal: boolean; ownerMapped: boolean } } | undefined]),
    );
    expect(byName.quiet!.emailCoverage).toMatchObject({ ownerMapped: true, limitedSignal: false });
    expect(byName.unmapped!.emailCoverage).toMatchObject({ ownerMapped: false, limitedSignal: true });
  });

  it("deduplicates: re-running updates in place, never duplicates", async () => {
    const count = await ownerDb().recommendation.count({ where: { responsibilityId } });
    const r = await runOpportunityHealth(admin, { trigger: "cron" });
    expect(r).toMatchObject({ created: 0, reopened: 0, refreshed: 5 });
    expect(await ownerDb().recommendation.count({ where: { responsibilityId } })).toBe(count);
  });
});

describe("recommendation lifecycle", () => {
  const act = (auth: AuthContext, id: string, action: string, body: unknown = {}) =>
    recAction(req(`/api/recommendations/${id}/${action}`, auth, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), routeParams({ id, action }));

  it("dismissed stays dismissed until it escalates, then reopens", async () => {
    const rec = (await recFor("quiet"))!;
    expect((await act(org.members.VIEWER, rec.id, "dismiss")).status).toBe(403);
    expect((await act(rep, rec.id, "dismiss")).status).toBe(200);
    await runOpportunityHealth(admin, { trigger: "cron" });
    expect((await recFor("quiet"))!.status).toBe("DISMISSED");
    // 10 days later the deal is twice past the inactivity threshold → AT_RISK → reopened.
    await runOpportunityHealth(admin, { trigger: "cron", now: new Date(Date.now() + 10 * 86_400_000) });
    const after = (await recFor("quiet"))!;
    expect(after).toMatchObject({ status: "OPEN", severity: "HIGH" });
    expect(await ownerDb().auditLog.count({ where: { entityId: rec.id, event: "recommendation.reopened" } })).toBe(1);
  });

  it("snooze holds until it expires; actions go through the action registry", async () => {
    const rec = (await recFor("awaiting"))!;
    expect((await act(rep, rec.id, "snooze", { days: 3 })).status).toBe(200);
    expect(await ownerDb().proposedAction.findFirst({ where: { recommendationId: rec.id, actionType: "recommendation.snooze" } })).toMatchObject({ status: "EXECUTED", source: "USER" });
    await runOpportunityHealth(admin, { trigger: "cron" });
    expect((await recFor("awaiting"))!.status).toBe("SNOOZED");
    await runOpportunityHealth(admin, { trigger: "cron", now: new Date(Date.now() + 4 * 86_400_000) });
    expect((await recFor("awaiting"))!.status).toBe("OPEN");
  });

  it("auto-resolves when the deal closes; a resolved recommendation cannot be acted on", async () => {
    hubspot.updateDeal(ext.overdue, { dealstage: "closedwon" }, Date.now() + 2000);
    await syncHubSpot(admin, { trigger: "manual" });
    const r = await runOpportunityHealth(admin, { trigger: "cron" });
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    const rec = (await recFor("overdue"))!;
    expect(rec).toMatchObject({ status: "RESOLVED" });
    expect(rec.resolvedAt).not.toBeNull();
    expect((await health()).overdue).toBeNull();
    expect((await act(rep, rec.id, "accept")).status).toBe(409);
  });

  it("auto-resolves AWAITING_BUYER_REPLY when a buyer reply is synced", async () => {
    const address = `rep-${org.slug}@seller.test`;
    google.mailbox(address).add(gmailMessage({
      id: "g-reply",
      threadId: "T-g-out",
      from: "ghosted@buyer-g.io",
      to: address,
      date: new Date(),
    }));
    await syncGmailMailbox(rep, { trigger: "manual" });
    await runOpportunityHealth(admin, { trigger: "cron" });
    expect((await recFor("ghosted"))!.status).toBe("RESOLVED");
    expect((await health()).ghosted).toBe("HEALTHY");
  });

  it("auto-resolves AWAITING_OUR_REPLY when the buyer is answered", async () => {
    const address = `rep-${org.slug}@seller.test`;
    google.mailbox(address).add(gmailMessage({ id: "w-reply", threadId: "T-w", from: address, to: "wait@buyer-b.io", date: new Date(), labelIds: ["SENT"] }));
    await syncGmailMailbox(rep, { trigger: "manual" });
    await runOpportunityHealth(admin, { trigger: "cron" });
    expect((await recFor("awaiting"))!.status).toBe("RESOLVED");
    expect((await health()).awaiting).toBe("HEALTHY");
  });
});

describe("unknown open/closed status", () => {
  it("deals whose status cannot be determined are skipped and their recommendations left untouched", async () => {
    const before = (await recFor("lonely"))!;
    expect(before.status).not.toBe("RESOLVED");
    // Pipeline metadata becomes unavailable and the deal's stage is no longer known.
    const lonely = await ownerDb().crmDeal.findFirstOrThrow({ where: { integrationId, name: "lonely" } });
    await ownerDb().crmDeal.update({ where: { id: lonely.id }, data: { isClosed: null } });
    const r = await runOpportunityHealth(admin, { trigger: "cron" });
    expect(r.skippedUnknownStatus).toBe(1);
    const after = (await recFor("lonely"))!;
    expect(after.status).toBe(before.status);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await health()).lonely).toBeNull(); // no stale health claim kept
    await ownerDb().crmDeal.update({ where: { id: lonely.id }, data: { isClosed: false } });
  });
});

describe("guards", () => {
  it("one run at a time; stale runs are recovered", async () => {
    const stuck = await ownerDb().responsibilityRun.create({ data: { organizationId: org.organizationId, responsibilityId, status: "RUNNING", startedAt: new Date() } });
    await expect(runOpportunityHealth(admin, { trigger: "cron" })).rejects.toMatchObject({ code: "conflict" });
    await ownerDb().responsibilityRun.update({ where: { id: stuck.id }, data: { startedAt: new Date(Date.now() - 60 * 60_000) } });
    await expect(runOpportunityHealth(admin, { trigger: "cron" })).resolves.toMatchObject({ dealsEvaluated: expect.any(Number) });
    expect((await ownerDb().responsibilityRun.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("FAILED");
  });

  it("manual run is ADMIN-only; requires HubSpot; refuses when paused", async () => {
    const url = `/api/responsibilities/${responsibilityId}/run`;
    expect((await runRoute(req(url, rep, { method: "POST" }), routeParams({ id: responsibilityId }))).status).toBe(403);
    expect((await runRoute(req(url, admin, { method: "POST" }), routeParams({ id: responsibilityId }))).status).toBe(200);
    const other = await createOrgFixture("ohnohub");
    await installOpportunityHealth(other.organizationId);
    await expect(runOpportunityHealth(other.members.ADMIN, { trigger: "manual" })).rejects.toMatchObject({ code: "policy_violation" });
    await ownerDb().responsibility.update({ where: { id: responsibilityId }, data: { status: "PAUSED" } });
    await expect(runOpportunityHealth(admin, { trigger: "manual" })).rejects.toMatchObject({ code: "policy_violation" });
    await ownerDb().responsibility.update({ where: { id: responsibilityId }, data: { status: "ACTIVE" } });
  });

  it("HubSpot stays read-only: a proposed hubspot.create_task can never execute", async () => {
    const before = hubspot.requests.length;
    const action = await proposeAction(admin, {
      actionType: "hubspot.create_task",
      payload: { objectType: "deal", objectId: ext.quiet, title: "Follow up", dueAt: new Date(Date.now() + 86_400_000).toISOString() },
      source: "SYSTEM",
    });
    await decideAction(admin, action.id, "APPROVED");
    await expect(executeAction(admin, action.id)).rejects.toThrow(/No executor/);
    expect(hubspot.requests.length).toBe(before);
    expect(hubspot.writeRequests()).toEqual([]);
  });

  it("cron endpoint requires the secret and runs due organizations", async () => {
    expect((await healthCron(new Request("http://localhost/api/internal/cron/opportunity-health", { method: "POST" }))).status).toBe(401);
    const res = await healthCron(new Request("http://localhost/api/internal/cron/opportunity-health", { method: "POST", headers: { authorization: `Bearer ${SPEC03_CRON_SECRET}` } }));
    expect(res.status).toBe(200);
  });
});

describe("read API", () => {
  it("lists deals with health, filters by state and 'mine'", async () => {
    const all = (await (await dealList(req("/api/crm/deals", org.members.VIEWER))).json()).data as Array<{ name: string; health: { state: string } | null }>;
    expect(all.map((d) => d.name).sort()).toEqual(["awaiting", "healthy", "lonely", "quiet", "unmapped"]);
    const mine = (await (await dealList(req("/api/crm/deals?mine=true", rep))).json()).data as Array<{ name: string }>;
    expect(mine.map((d) => d.name)).not.toContain("unmapped");
    const recs = (await (await recList(req("/api/recommendations?mine=true", rep))).json()).data as Array<{ dealId: string }>;
    expect(recs.length).toBeGreaterThan(0);
  });

  it("deal detail shows a metadata-only timeline to any member", async () => {
    const deal = await ownerDb().crmDeal.findFirstOrThrow({ where: { integrationId, name: "quiet" } });
    const res = await dealDetail(req(`/api/crm/deals/${deal.id}`, org.members.VIEWER), routeParams({ id: deal.id }));
    const body = (await res.json()).data;
    expect(body.timeline.map((t: { direction: string }) => t.direction)).toEqual(["OUTBOUND", "INBOUND"]);
    expect(JSON.stringify(body)).not.toMatch(/Secret discount|drop to 30%/);
  });

  it("another organization cannot see the deal", async () => {
    const outsider = await createOrgFixture("ohout");
    const deal = await ownerDb().crmDeal.findFirstOrThrow({ where: { integrationId, name: "quiet" } });
    expect((await dealDetail(req(`/api/crm/deals/${deal.id}`, outsider.members.OWNER), routeParams({ id: deal.id }))).status).toBe(404);
  });
});
