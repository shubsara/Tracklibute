import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthContext } from "@/domain/auth/auth-context";
import { installSystemResponsibilities } from "@/server/responsibilities/responsibilities.service";
import { disconnectAppDb } from "@/server/db/client";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { runLeadHealth } from "@/server/lead-health/lead-health.service";

import { type FakeGoogle, gmailMessage } from "./support/fake-google";
import type { FakeHubSpot } from "./support/fake-hubspot";
import { closeOwnerDb, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";
import { connectGmailFixture } from "./support/gmail-fixtures";
import { startFakeGoogleEnv } from "./support/google-env";
import { connectHubSpotFixture, isoDaysAgo } from "./support/hubspot-fixtures";
import { startFakeHubSpotEnv } from "./support/hubspot-env";

let google: FakeGoogle;
let hubspot: FakeHubSpot;
let org: OrgFixture;
let admin: AuthContext;
let rep: AuthContext & { email: string };
let responsibilityId: string;
let integrationId: string;
let mailboxAddress: string;
let sqlContactId: string;
let lostContactId: string;
let mqlContactId: string;
let activeDealContactId: string;
let wonDealContactId: string;

beforeAll(async () => {
  google = await startFakeGoogleEnv();
  hubspot = await startFakeHubSpotEnv();
  org = await createOrgFixture("leadhealth");
  admin = org.members.ADMIN;
  rep = org.members.MEMBER;
  await installSystemResponsibilities(admin);
  const leadHealth = await ownerDb().responsibility.findFirstOrThrow({
    where: { organizationId: org.organizationId, templateKey: "lead_health" },
  });
  responsibilityId = leadHealth.id;
  integrationId = (await connectHubSpotFixture(hubspot, admin, "555002")).integrationId;
  mailboxAddress = "rep-" + org.slug + "@seller.test";
  await connectGmailFixture(google, rep, mailboxAddress);

  const qualifiedAt = isoDaysAgo(6);
  const sql = hubspot.addContact("sql@buyer.io", {
    lifecyclestage: "salesqualifiedlead",
    hs_lead_status: "IN_PROGRESS",
    hs_v2_date_entered_salesqualifiedlead: qualifiedAt,
    createdate: qualifiedAt,
  });
  const lost = hubspot.addContact("lost@buyer.io", {
    lifecyclestage: "salesqualifiedlead",
    hs_lead_status: "IN_PROGRESS",
    hs_v2_date_entered_salesqualifiedlead: qualifiedAt,
    createdate: qualifiedAt,
  });
  const mql = hubspot.addContact("mql@buyer.io", {
    lifecyclestage: "marketingqualifiedlead",
    hs_lead_status: "NEW",
    hs_v2_date_entered_marketingqualifiedlead: qualifiedAt,
    createdate: qualifiedAt,
  });
  const active = hubspot.addContact("active@buyer.io", {
    lifecyclestage: "salesqualifiedlead",
    hs_lead_status: "IN_PROGRESS",
    hs_v2_date_entered_salesqualifiedlead: qualifiedAt,
    createdate: qualifiedAt,
  });
  const won = hubspot.addContact("won@buyer.io", {
    lifecyclestage: "salesqualifiedlead",
    hs_lead_status: "IN_PROGRESS",
    hs_v2_date_entered_salesqualifiedlead: qualifiedAt,
    createdate: qualifiedAt,
  });
  sqlContactId = sql.id;
  lostContactId = lost.id;
  mqlContactId = mql.id;
  activeDealContactId = active.id;
  wonDealContactId = won.id;

  hubspot.addDeal({ dealname: "Prior closed-lost deal", dealstage: "closedlost" }, { contacts: [lost.id] });
  hubspot.addDeal({ dealname: "Active opportunity", dealstage: "qualified" }, { contacts: [active.id] });
  hubspot.addDeal({ dealname: "Closed-won customer", dealstage: "closedwon" }, { contacts: [won.id] });

  await syncHubSpot(admin, { trigger: "manual" });
  await syncGmailMailbox(rep, { trigger: "manual" });
});

afterAll(async () => {
  await google.stop();
  await hubspot.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

const localContact = (externalId: string) =>
  ownerDb().crmContact.findFirstOrThrow({ where: { organizationId: org.organizationId, integrationId, externalId } });
const leadRecommendation = async (externalId: string) => {
  const contact = await localContact(externalId);
  return ownerDb().recommendation.findFirst({
    where: { organizationId: org.organizationId, responsibilityId, dedupeKey: "lead_health:contact:" + contact.id },
  });
};

describe("Lead Health", () => {
  it("detects qualified standalone contacts, excludes MQL by default and contacts with an active deal", async () => {
    const r = await runLeadHealth(admin, { trigger: "manual" });
    expect(r).toMatchObject({ contactsEvaluated: 2, atRisk: 2, created: 2, limitedSignal: 0 });
    expect(await leadRecommendation(sqlContactId)).toMatchObject({
      status: "OPEN",
      severity: "HIGH",
      title: "Pat Buyer has not received a first sales touch",
    });
    expect(await leadRecommendation(lostContactId)).toMatchObject({ status: "OPEN", severity: "HIGH" });
    expect((await leadRecommendation(lostContactId))!.summary).toContain("prior closed-lost");
    expect(await leadRecommendation(mqlContactId)).toBeNull();
    expect(await leadRecommendation(activeDealContactId)).toBeNull();
    expect(await leadRecommendation(wonDealContactId)).toBeNull();
    expect(hubspot.writeRequests()).toEqual([]);

    const rows = await ownerDb().crmContact.findMany({
      where: { organizationId: org.organizationId, integrationId, archivedAt: null },
      select: { email: true, lifecycleStage: true, leadStatus: true, dateEnteredSalesQualifiedLead: true },
    });
    expect(rows).toHaveLength(5);
    expect(rows.find((row) => row.email === "sql@buyer.io")).toMatchObject({ lifecycleStage: "salesqualifiedlead", leadStatus: "in_progress" });
  });

  it("resolves the recommendation after matching outbound activity is synced from Gmail", async () => {
    google.mailbox(mailboxAddress).add(gmailMessage({
      id: "lead-first-touch",
      threadId: "lead-first-touch-thread",
      from: mailboxAddress,
      to: "sql@buyer.io",
      date: new Date(),
      labelIds: ["SENT"],
      plain: "Following up on our conversation.",
    }));
    await syncGmailMailbox(rep, { trigger: "manual" });
    const r = await runLeadHealth(admin, { trigger: "manual" });
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect(await leadRecommendation(sqlContactId)).toMatchObject({ status: "RESOLVED" });
    const rec = (await leadRecommendation(sqlContactId))!;
    expect(rec.resolvedAt).not.toBeNull();
    const dump = JSON.stringify(rec.evidence);
    expect(dump).not.toContain("sql@buyer.io");
    expect(dump).not.toContain("Following up on our conversation");
  });
});
