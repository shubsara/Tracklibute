import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PUT as putDomains } from "@/app/api/organizations/email-domains/route";
import type { AuthContext } from "@/domain/auth/auth-context";
import { disconnectAppDb } from "@/server/db/client";
import { withOrgScope } from "@/server/db/org-scope";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";

import { type FakeGoogle, gmailMessage } from "./support/fake-google";
import { closeOwnerDb, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";
import { connectGmailFixture, daysAgo } from "./support/gmail-fixtures";
import { startFakeGoogleEnv } from "./support/google-env";
import { authedRequest as req } from "./support/requests";

let google: FakeGoogle;
let A: OrgFixture;
let B: OrgFixture;
let rep: AuthContext; // org A mailbox owner
let teammate: AuthContext; // org A, NOT the mailbox owner
let outsider: AuthContext; // org B
let integrationId: string;
let address: string;

const SUBJECT = "Confidential pricing for Q4";
const BODY = "Our walk-away price is 42k";

beforeAll(async () => {
  google = await startFakeGoogleEnv();
  A = await createOrgFixture("eaa");
  B = await createOrgFixture("eab");
  rep = A.members.MEMBER;
  teammate = A.members.OWNER;
  outsider = B.members.OWNER;
  address = `rep-${A.slug}@seller.test`;
  integrationId = (await connectGmailFixture(google, rep, address)).integrationId;
  const box = google.mailbox(address);
  box.add(gmailMessage({ id: "in1", threadId: "T1", from: "Pat <pat@buyer.io>", to: address, subject: SUBJECT, plain: BODY, date: daysAgo(3) }));
  box.add(gmailMessage({ id: "out1", threadId: "T1", from: address, to: "pat@buyer.io", cc: `boss@seller.test, cfo@buyer.io`, bcc: "secret-bcc@other.io", subject: `Re: ${SUBJECT}`, plain: BODY, date: daysAgo(2), labelIds: ["SENT"] }));
  box.add(gmailMessage({ id: "internal", threadId: "T2", from: `ops@seller.test`, to: address, subject: "lunch", date: daysAgo(1) }));
  box.add(gmailMessage({ id: "news", threadId: "T3", from: "news@buyer.io", to: address, subject: "Newsletter", date: daysAgo(1), extraHeaders: [{ name: "List-Unsubscribe", value: "<mailto:u@buyer.io>" }] }));
  box.add(gmailMessage({ id: "member", threadId: "T4", from: A.members.ADMIN.email, to: address, subject: "fwd", date: daysAgo(1) }));
  await syncGmailMailbox(rep, { trigger: "manual" });
});
afterAll(async () => {
  await google.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

const rows = () => ownerDb().emailActivity.findMany({ where: { integrationId }, orderBy: [{ externalMessageId: "asc" }, { counterpartEmail: "asc" }] });

describe("derivation during Gmail sync", () => {
  it("eligible external messages produce content-free rows; internal / bulk / member / Bcc produce none", async () => {
    const r = await rows();
    expect(r.map((x) => [x.externalMessageId, x.direction, x.counterpartEmail, x.counterpartDomain])).toEqual([
      ["in1", "INBOUND", "pat@buyer.io", "buyer.io"],
      ["out1", "OUTBOUND", "cfo@buyer.io", "buyer.io"],
      ["out1", "OUTBOUND", "pat@buyer.io", "buyer.io"],
    ]);
    expect(r.every((x) => x.mailboxUserId === rep.userId && x.organizationId === A.organizationId && x.externalThreadId === "T1")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/Confidential|walk-away|Pat|secret-bcc|ops@|news@/);
    expect((await ownerDb().integration.findUniqueOrThrow({ where: { id: integrationId } })).emailActivityVersion).toBe(1);
  });

  it("the table has no content columns (schema allow-list)", async () => {
    const cols = await ownerDb().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'email_activities' ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "counterpart_domain",
      "counterpart_email",
      "created_at",
      "direction",
      "external_message_id",
      "external_thread_id",
      "id",
      "integration_id",
      "mailbox_user_id",
      "occurred_at",
      "organization_id",
    ]);
  });

  it("is idempotent and follows deletions", async () => {
    await syncGmailMailbox(rep, { trigger: "manual" });
    expect(await rows()).toHaveLength(3);
    google.mailbox(address).remove("out1");
    await syncGmailMailbox(rep, { trigger: "manual" });
    expect((await rows()).map((x) => x.externalMessageId)).toEqual(["in1"]);
    google.mailbox(address).add(gmailMessage({ id: "out1", threadId: "T1", from: address, to: "pat@buyer.io", cc: "cfo@buyer.io", date: daysAgo(2), labelIds: ["SENT"] }));
    await syncGmailMailbox(rep, { trigger: "manual" });
    expect(await rows()).toHaveLength(3);
  });
});

describe("rebuild from stored mail (no Gmail calls)", () => {
  it("backfills mailboxes that pre-date EmailActivity", async () => {
    await ownerDb().emailActivity.deleteMany({ where: { integrationId } });
    await ownerDb().integration.update({ where: { id: integrationId }, data: { emailActivityVersion: 0 } });
    google.requests = [];
    await syncGmailMailbox(rep, { trigger: "manual" });
    expect(await rows()).toHaveLength(3);
    expect(google.requests.filter((r) => /\/messages\//.test(r))).toEqual([]);
  });

  it("re-derives when an admin changes internal domains", async () => {
    const res = await putDomains(req("/api/organizations/email-domains", A.members.ADMIN, { method: "PUT", body: JSON.stringify({ domains: ["Buyer.io"] }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    await syncGmailMailbox(rep, { trigger: "manual" });
    expect(await rows()).toEqual([]);
    await putDomains(req("/api/organizations/email-domains", A.members.ADMIN, { method: "PUT", body: JSON.stringify({ domains: [] }), headers: { "content-type": "application/json" } }));
    await syncGmailMailbox(rep, { trigger: "manual" });
    expect(await rows()).toHaveLength(3);
  });

  it("internal domains: ADMIN only, valid non-public domains only", async () => {
    const put = (auth: AuthContext, domains: string[]) =>
      putDomains(req("/api/organizations/email-domains", auth, { method: "PUT", body: JSON.stringify({ domains }), headers: { "content-type": "application/json" } }));
    expect((await put(A.members.MEMBER, ["x.io"])).status).toBe(403);
    expect((await put(A.members.ADMIN, ["gmail.com"])).status).toBe(400);
    expect((await put(A.members.ADMIN, ["not a domain"])).status).toBe(400);
  });
});

describe("row-level security", () => {
  it("a teammate can READ the org's activity, but never the owner-private mail behind it", async () => {
    await withOrgScope(teammate, async (tx) => {
      expect(await tx.emailActivity.count({ where: { integrationId } })).toBe(3);
      expect(await tx.emailMessage.count({ where: { integrationId } })).toBe(0);
      expect(await tx.emailThread.count({ where: { integrationId } })).toBe(0);
    });
  });

  it("a teammate cannot write or delete another member's activity", async () => {
    await expect(
      withOrgScope(teammate, (tx) =>
        tx.emailActivity.create({
          data: {
            organizationId: A.organizationId,
            integrationId,
            mailboxUserId: rep.userId,
            externalMessageId: `forged-${randomUUID()}`,
            externalThreadId: "T",
            direction: "INBOUND",
            counterpartEmail: "x@y.io",
            counterpartDomain: "y.io",
            occurredAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
    const deleted = await withOrgScope(teammate, (tx) => tx.emailActivity.deleteMany({ where: { integrationId } }));
    expect(deleted.count).toBe(0);
    expect(await rows()).toHaveLength(3);
  });

  it("rows are immutable for the runtime role (no UPDATE grant)", async () => {
    await expect(
      withOrgScope(rep, (tx) => tx.$executeRaw`UPDATE email_activities SET counterpart_email = 'x@y.io' WHERE integration_id = ${integrationId}::uuid`),
    ).rejects.toThrow(/permission denied/);
  });

  it("another organization sees nothing", async () => {
    await withOrgScope(outsider, async (tx) => {
      expect(await tx.emailActivity.count()).toBe(0);
      expect(await tx.emailActivity.count({ where: { organizationId: A.organizationId } })).toBe(0);
    });
  });

  it("the database refuses content-like values (CHECK constraints)", async () => {
    await expect(
      ownerDb().emailActivity.create({
        data: { organizationId: A.organizationId, integrationId, mailboxUserId: rep.userId, externalMessageId: "x", externalThreadId: "T", direction: "UNKNOWN", counterpartEmail: "a@b.io", counterpartDomain: "b.io", occurredAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      ownerDb().emailActivity.create({
        data: { organizationId: A.organizationId, integrationId, mailboxUserId: rep.userId, externalMessageId: "y", externalThreadId: "T", direction: "INBOUND", counterpartEmail: "Not An Address", counterpartDomain: "b.io", occurredAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});
