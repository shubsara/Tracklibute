import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as threadDetail } from "@/app/api/email/threads/[id]/route";
import { GET as threadList } from "@/app/api/email/threads/route";
import { POST as cron } from "@/app/api/internal/cron/gmail-sync/route";
import { GET as integrations } from "@/app/api/integrations/route";
import { DELETE as gmailDisconnect, GET as gmailStatus } from "@/app/api/integrations/gmail/route";
import { POST as gmailSync } from "@/app/api/integrations/gmail/sync/route";
import type { AuthContext } from "@/domain/auth/auth-context";
import { getEnv } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import { issueSessionToken } from "@/server/auth/session-token";
import { disconnectAppDb, getAppDb } from "@/server/db/client";
import { withOrgScope } from "@/server/db/org-scope";
import { getEmailContext, getThread, listThreads } from "@/server/email/email.service";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";
import { loadIntegrationCredentials } from "@/server/integrations/integrations.service";

import { type FakeGoogle, gmailMessage } from "./support/fake-google";
import { closeOwnerDb, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";
import { connectGmailFixture, daysAgo } from "./support/gmail-fixtures";
import { CRON_SECRET, startFakeGoogleEnv } from "./support/google-env";

let google: FakeGoogle;
let A: OrgFixture;
let B: OrgFixture;
let a1: AuthContext; // org A mailbox owner
let a2: AuthContext; // org A OWNER — same org, NOT the mailbox owner
let b1: AuthContext; // org B mailbox owner
const ids = {} as { a1Integration: string; b1Integration: string; a1Thread: string; b1Thread: string };

const req = (path: string, auth: AuthContext | null, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (auth) headers.set("authorization", `Bearer ${issueSessionToken(auth, getEnv().SESSION_SECRET)}`);
  return new Request(`http://localhost${path}`, { ...init, headers });
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  google = await startFakeGoogleEnv();
  A = await createOrgFixture("isoa");
  B = await createOrgFixture("isob");
  a1 = A.members.MEMBER;
  a2 = A.members.OWNER;
  b1 = B.members.MEMBER;
  const boxA = `a1-${A.slug}@gmail.test`;
  const boxB = `b1-${B.slug}@gmail.test`;
  ids.a1Integration = (await connectGmailFixture(google, a1, boxA)).integrationId;
  ids.b1Integration = (await connectGmailFixture(google, b1, boxB)).integrationId;
  google.mailbox(boxA).add(gmailMessage({ id: "A-secret", threadId: "TA", from: "ceo@target.io", to: boxA, subject: "A confidential", plain: "A private body", date: daysAgo(1) }));
  google.mailbox(boxB).add(gmailMessage({ id: "B-secret", threadId: "TB", from: "cfo@other.io", to: boxB, subject: "B confidential", plain: "B private body", date: daysAgo(1) }));
  await syncGmailMailbox(a1, { trigger: "manual" });
  await syncGmailMailbox(b1, { trigger: "manual" });
  ids.a1Thread = (await ownerDb().emailThread.findFirstOrThrow({ where: { integrationId: ids.a1Integration } })).id;
  ids.b1Thread = (await ownerDb().emailThread.findFirstOrThrow({ where: { integrationId: ids.b1Integration } })).id;
});

afterAll(async () => {
  await google.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

describe("mailbox owner sees their own data", () => {
  it("lists and opens own threads", async () => {
    const list = await (await threadList(req("/api/email/threads", a1))).json();
    expect(list.data.threads.map((t: { id: string }) => t.id)).toEqual([ids.a1Thread]);
    expect(list.data.threads[0]).toMatchObject({ subject: "A confidential", messageCount: 1 });
    expect(JSON.stringify(list)).not.toContain("A private body"); // list never returns bodies
    const detail = await (await threadDetail(req(`/api/email/threads/${ids.a1Thread}`, a1), params(ids.a1Thread))).json();
    expect(detail.data.messages[0]).toMatchObject({ bodyText: "A private body", direction: "INBOUND" });
    const ctx = await getEmailContext(a1, ids.a1Thread);
    expect(ctx).toMatchObject({ messageCount: 1, lastDirection: "INBOUND", participants: [{ email: "ceo@target.io", name: null }] });
  });
});

describe("cross-ORGANIZATION isolation", () => {
  it("A cannot read B's messages, threads or integration (and vice versa)", async () => {
    await expect(getThread(a1, ids.b1Thread)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getThread(b1, ids.a1Thread)).rejects.toBeInstanceOf(NotFoundError);
    expect((await threadDetail(req(`/api/email/threads/${ids.b1Thread}`, a1), params(ids.b1Thread))).status).toBe(404);
    expect((await listThreads(a1, {})).threads.map((t) => t.id)).not.toContain(ids.b1Thread);
    await expect(loadIntegrationCredentials(a1, ids.b1Integration)).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadIntegrationCredentials(b1, ids.a1Integration)).rejects.toBeInstanceOf(NotFoundError);
    const aInts = (await (await integrations(req("/api/integrations", a2))).json()).data.map((i: { id: string }) => i.id);
    const bInts = (await (await integrations(req("/api/integrations", b1))).json()).data.map((i: { id: string }) => i.id);
    expect(aInts).not.toContain(ids.b1Integration);
    expect(bInts).not.toContain(ids.a1Integration);
  });
});

describe("cross-MAILBOX isolation inside one organization", () => {
  it("an OWNER of the same org cannot see another member's raw mailbox", async () => {
    expect((await listThreads(a2, {})).threads).toEqual([]);
    await expect(getThread(a2, ids.a1Thread)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getEmailContext(a2, ids.a1Thread)).rejects.toBeInstanceOf(NotFoundError);
    expect((await threadDetail(req(`/api/email/threads/${ids.a1Thread}`, a2), params(ids.a1Thread))).status).toBe(404);
    await expect(loadIntegrationCredentials(a2, ids.a1Integration)).rejects.toBeInstanceOf(NotFoundError);
    const status = await (await gmailStatus(req("/api/integrations/gmail", a2))).json();
    expect(status.data).toMatchObject({ connected: false, status: "NOT_CONNECTED", accountEmail: null });
    const list = (await (await integrations(req("/api/integrations", a2))).json()).data.map((i: { id: string }) => i.id);
    expect(list).not.toContain(ids.a1Integration);
  });

  it("URL / body manipulation cannot widen scope", async () => {
    const res = await threadList(req(`/api/email/threads?mailboxUserId=${a1.userId}&organizationId=${B.organizationId}&userId=${a1.userId}`, a2));
    expect((await res.json()).data.threads).toEqual([]);
    const sync = await gmailSync(req("/api/integrations/gmail/sync", a2, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": a1.userId },
      body: JSON.stringify({ integrationId: ids.a1Integration, mailboxUserId: a1.userId }),
    }));
    expect(sync.status).toBe(404);
    const del = await gmailDisconnect(req(`/api/integrations/gmail?integrationId=${ids.a1Integration}`, a2, { method: "DELETE" }));
    expect(del.status).toBe(404);
    expect((await ownerDb().integration.findUniqueOrThrow({ where: { id: ids.a1Integration } })).status).toBe("CONNECTED");
    const forgedCursor = Buffer.from(`2999-01-01T00:00:00.000Z|${ids.a1Thread}`).toString("base64url");
    expect((await listThreads(a2, { cursor: forgedCursor })).threads).toEqual([]);
  });
});

describe("PostgreSQL RLS (application filters deliberately omitted)", () => {
  it("unfiltered queries only ever return the caller's own mailbox rows", async () => {
    const seen = await withOrgScope(a2, async (tx) => ({
      threads: await tx.emailThread.findMany(),
      messages: await tx.emailMessage.findMany(),
      recipients: await tx.emailMessageRecipient.findMany(),
      integrations: await tx.integration.findMany({ where: { provider: "GMAIL" } }),
    }));
    expect(seen).toEqual({ threads: [], messages: [], recipients: [], integrations: [] });

    const own = await withOrgScope(a1, (tx) => tx.emailMessage.findMany());
    expect(own.map((m) => m.externalMessageId)).toEqual(["A-secret"]);
    expect(await getAppDb().emailMessage.findMany()).toEqual([]); // no context at all
  });

  it("blocks writes into another member's mailbox", async () => {
    const res = await withOrgScope(a2, async (tx) => ({
      upd: await tx.emailMessage.updateMany({ data: { subject: "hijacked" } }),
      del: await tx.emailThread.deleteMany({}),
      int: await tx.integration.updateMany({ where: { id: ids.a1Integration }, data: { status: "DISCONNECTED" } }),
    }));
    expect(res).toEqual({ upd: { count: 0 }, del: { count: 0 }, int: { count: 0 } });
    await expect(
      withOrgScope(a2, (tx) =>
        tx.emailThread.create({
          data: { organizationId: A.organizationId, mailboxUserId: a1.userId, integrationId: ids.a1Integration, externalThreadId: "inject", firstMessageAt: new Date(), lastMessageAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    expect((await ownerDb().emailMessage.findFirstOrThrow({ where: { integrationId: ids.a1Integration } })).subject).toBe("A confidential");
  });

  it("composite FKs forbid attaching mail to an integration owned by someone else (even bypassing RLS)", async () => {
    await expect(
      ownerDb().emailThread.create({
        data: { organizationId: A.organizationId, mailboxUserId: a2.userId, integrationId: ids.a1Integration, externalThreadId: "fk", firstMessageAt: new Date(), lastMessageAt: new Date() },
      }),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      ownerDb().emailThread.create({
        data: { organizationId: B.organizationId, mailboxUserId: a1.userId, integrationId: ids.a1Integration, externalThreadId: "fk2", firstMessageAt: new Date(), lastMessageAt: new Date() },
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("protected cron endpoint", () => {
  it("requires the secret", async () => {
    expect((await cron(req("/api/internal/cron/gmail-sync", null, { method: "POST" }))).status).toBe(401);
    const wrong = new Request("http://localhost/api/internal/cron/gmail-sync", { method: "POST", headers: { authorization: "Bearer nope" } });
    expect((await cron(wrong)).status).toBe(401);
    const userSession = await cron(req("/api/internal/cron/gmail-sync", a1, { method: "POST" }));
    expect(userSession.status).toBe(401);
  });

  it("syncs eligible mailboxes and returns counts only", async () => {
    google.mailbox(`a1-${A.slug}@gmail.test`).add(gmailMessage({ id: "A-new", threadId: "TA", from: "ceo@target.io", plain: "new private", date: daysAgo(0) }));
    // The shared test DB may hold stale mailboxes from earlier runs; cron marks
    // them REAUTH_REQUIRED (no longer eligible), so drain batches until ours ran.
    const processed = new Set<string>();
    for (let i = 0; i < 30 && !(processed.has(ids.a1Integration) && processed.has(ids.b1Integration)); i++) {
      const res = await cron(new Request("http://localhost/api/internal/cron/gmail-sync", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toMatch(/gmail\.test|private|confidential|at-|rt-/);
      const body = JSON.parse(text) as { data: { candidates: number; results: Array<{ integrationId: string; outcome: string }> } };
      for (const r of body.data.results) if (r.outcome === "succeeded") processed.add(r.integrationId);
      if (body.data.candidates === 0) break;
    }
    expect(processed).toContain(ids.a1Integration);
    expect(processed).toContain(ids.b1Integration);
    expect(await ownerDb().emailMessage.count({ where: { integrationId: ids.a1Integration } })).toBe(2);
    const sys = await ownerDb().auditLog.findFirst({ where: { entityId: ids.a1Integration, event: "gmail.sync_completed", actorType: "SYSTEM" } });
    expect(sys?.actorUserId).toBeNull();
  });
});

describe("member removal", () => {
  it("removing a member removes their mailbox integration and synced mail", async () => {
    const o = await createOrgFixture("isorm");
    const box = `rm-${o.slug}@gmail.test`;
    const { integrationId } = await connectGmailFixture(google, o.members.MEMBER, box);
    google.mailbox(box).add(gmailMessage({ threadId: "R", from: "x@y.io", date: daysAgo(1) }));
    await syncGmailMailbox(o.members.MEMBER, { trigger: "manual" });
    await ownerDb().organizationMember.delete({ where: { organizationId_userId: { organizationId: o.organizationId, userId: o.members.MEMBER.userId } } });
    expect(await ownerDb().integration.count({ where: { id: integrationId } })).toBe(0);
    expect(await ownerDb().emailMessage.count({ where: { integrationId } })).toBe(0);
  });
});
