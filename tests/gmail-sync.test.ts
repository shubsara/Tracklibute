import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConflictError, PolicyViolationError, UpstreamServiceError } from "@/lib/errors";
import { disconnectAppDb } from "@/server/db/client";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";

import { type FakeGoogle, gmailMessage } from "./support/fake-google";
import { closeOwnerDb, createOrgFixture, ownerDb } from "./support/fixtures";
import { connectGmailFixture, daysAgo } from "./support/gmail-fixtures";
import { startFakeGoogleEnv } from "./support/google-env";

let google: FakeGoogle;
let n = 0;

beforeAll(async () => {
  google = await startFakeGoogleEnv();
});
afterAll(async () => {
  await google.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

/** Fresh org + member + connected mailbox per test, so tests are independent. */
async function setup() {
  const org = await createOrgFixture(`sync${n++}`);
  const auth = org.members.MEMBER;
  const address = `rep${n}-${org.slug}@acme.test`;
  const { integrationId } = await connectGmailFixture(google, auth, address);
  return { org, auth, address, integrationId, box: google.mailbox(address) };
}

const counts = async (integrationId: string) => ({
  messages: await ownerDb().emailMessage.count({ where: { integrationId } }),
  threads: await ownerDb().emailThread.count({ where: { integrationId } }),
});
const integration = (id: string) => ownerDb().integration.findUniqueOrThrow({ where: { id } });

describe("initial sync", () => {
  it("applies the 90-day default lookback and imports messages into threads", async () => {
    const { auth, address, integrationId, box } = await setup();
    box.add(gmailMessage({ id: "old", threadId: "T0", from: "x@buyer.io", date: daysAgo(120) }));
    box.add(gmailMessage({ id: "a1", threadId: "TA", from: `Buyer <b@buyer.io>`, to: address, subject: "Pricing", plain: "Hi", date: daysAgo(10) }));
    box.add(gmailMessage({ id: "a2", threadId: "TA", from: address, to: "b@buyer.io", cc: "cfo@buyer.io", subject: "Re: Pricing", plain: "Hello", date: daysAgo(9), labelIds: ["SENT"] }));
    box.add(gmailMessage({ id: "b1", threadId: "TB", from: "c@other.io", to: address, subject: "Intro", plain: "Hey", date: daysAgo(1) }));
    box.add(gmailMessage({ id: "draft", threadId: "TC", from: address, date: daysAgo(1), labelIds: ["DRAFT"] }));

    const r = await syncGmailMailbox(auth, { trigger: "manual" });
    expect(r).toMatchObject({ syncType: "initial", messagesUpserted: 3, threadsTouched: 2, cursorBefore: null });
    expect(google.requests.some((q) => q.includes(`after%3A${Math.floor(daysAgo(90).getTime() / 1000)}`.slice(0, 18)))).toBe(true);
    expect(await counts(integrationId)).toEqual({ messages: 3, threads: 2 });

    const ta = await ownerDb().emailThread.findFirstOrThrow({ where: { integrationId, externalThreadId: "TA" }, include: { messages: { include: { recipients: true }, orderBy: { receivedAt: "asc" } } } });
    expect(ta).toMatchObject({ subject: "Pricing", messageCount: 2, mailboxUserId: auth.userId, organizationId: auth.organizationId });
    expect(ta.firstMessageAt.getTime()).toBeLessThan(ta.lastMessageAt.getTime());
    expect(ta.messages.map((m) => [m.externalMessageId, m.direction])).toEqual([["a1", "INBOUND"], ["a2", "OUTBOUND"]]);
    expect(ta.messages[0]).toMatchObject({ fromEmail: "b@buyer.io", fromName: "Buyer", bodyText: "Hi", threadId: ta.id });
    expect(ta.messages[1]!.recipients.map((x) => `${x.kind}:${x.email}`).sort()).toEqual(["CC:cfo@buyer.io", "TO:b@buyer.io"]);
    expect(ta.id).not.toBe("TA"); // internal primary key, Gmail id is external only

    const row = await integration(integrationId);
    expect(row.syncCursor).toBe(String(box.historyId));
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.syncLeaseExpiresAt).toBeNull();
  });

  it("respects a configured lookback", async () => {
    const { auth, integrationId, box } = await setup();
    box.add(gmailMessage({ threadId: "T1", from: "x@y.io", date: daysAgo(20) }));
    box.add(gmailMessage({ threadId: "T2", from: "x@y.io", date: daysAgo(3) }));
    await syncGmailMailbox(auth, { trigger: "manual", lookbackDays: 7 });
    expect((await counts(integrationId)).messages).toBe(1);
  });

  it("handles an empty mailbox", async () => {
    const { auth, integrationId } = await setup();
    const r = await syncGmailMailbox(auth, { trigger: "manual" });
    expect(r.messagesUpserted).toBe(0);
    expect((await integration(integrationId)).syncCursor).not.toBeNull();
  });

  it("processes thousands of messages in bounded batches", async () => {
    const { auth, integrationId, box } = await setup();
    for (let i = 0; i < 1050; i++) box.add(gmailMessage({ id: `bulk${i}`, threadId: `BT${i % 40}`, from: "n@x.io", date: daysAgo(1 + (i % 30)) }));
    const r = await syncGmailMailbox(auth, { trigger: "manual" });
    expect(r.messagesUpserted).toBe(1050);
    expect(await counts(integrationId)).toEqual({ messages: 1050, threads: 40 });
    expect(google.requests.filter((q) => q.includes(`/messages?`) && q.includes("maxResults=100")).length).toBeGreaterThanOrEqual(11);
  }, 60_000);
});

describe("incremental sync (History API)", () => {
  it("uses the stored cursor, processes only changed messages, persists the new cursor", async () => {
    const { auth, integrationId, box, address } = await setup();
    box.add(gmailMessage({ id: "i1", threadId: "IT", from: "b@buyer.io", date: daysAgo(2) }));
    await syncGmailMailbox(auth, { trigger: "manual" });
    const cursor = (await integration(integrationId)).syncCursor!;

    box.add(gmailMessage({ id: "i2", threadId: "IT", from: address, date: daysAgo(0), labelIds: ["SENT"] }));
    google.requests = [];
    const r = await syncGmailMailbox(auth, { trigger: "cron" });
    expect(r).toMatchObject({ syncType: "incremental", cursorBefore: cursor, messagesUpserted: 1 });
    expect(google.requests.some((q) => q.includes(`/history?startHistoryId=${cursor}`))).toBe(true);
    const fetched = google.requests.filter((q) => /\/messages\/[^?]+\?/.test(q));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("/messages/i2?");
    expect((await integration(integrationId)).syncCursor).toBe(String(box.historyId));
    expect((await ownerDb().emailThread.findFirstOrThrow({ where: { integrationId, externalThreadId: "IT" } })).messageCount).toBe(2);
  });

  it("applies deletions and relabels (trash removes the message)", async () => {
    const { auth, integrationId, box } = await setup();
    box.add(gmailMessage({ id: "d1", threadId: "DT", from: "b@x.io", date: daysAgo(1) }));
    box.add(gmailMessage({ id: "d2", threadId: "DT", from: "b@x.io", date: daysAgo(1) }));
    box.add(gmailMessage({ id: "d3", threadId: "DT2", from: "b@x.io", date: daysAgo(1) }));
    await syncGmailMailbox(auth, { trigger: "manual" });
    box.remove("d1");
    box.relabel("d2", ["INBOX", "STARRED"]);
    box.relabel("d3", ["TRASH"]);
    const r = await syncGmailMailbox(auth, { trigger: "manual" });
    expect(r.messagesDeleted).toBe(2);
    const msgs = await ownerDb().emailMessage.findMany({ where: { integrationId } });
    expect(msgs.map((m) => [m.externalMessageId, m.labels])).toEqual([["d2", ["INBOX", "STARRED"]]]);
    expect(await ownerDb().emailThread.count({ where: { integrationId } })).toBe(1); // empty thread removed
  });
});

describe("idempotency", () => {
  it("running the same sync twice creates no duplicates", async () => {
    const { auth, integrationId, box } = await setup();
    for (let i = 0; i < 5; i++) box.add(gmailMessage({ threadId: `IDT${i % 2}`, from: "x@y.io", date: daysAgo(i + 1) }));
    await syncGmailMailbox(auth, { trigger: "manual" });
    const first = await counts(integrationId);
    // Force a full re-import of the same data.
    await ownerDb().integration.update({ where: { id: integrationId }, data: { syncCursor: null } });
    await syncGmailMailbox(auth, { trigger: "manual" });
    await syncGmailMailbox(auth, { trigger: "manual" });
    expect(await counts(integrationId)).toEqual(first);
    expect(await ownerDb().emailMessageRecipient.count({ where: { message: { integrationId } } })).toBe(0);
  });
});

describe("failure handling", () => {
  it("does not advance the checkpoint on failure, records a safe error, and retry succeeds", async () => {
    const { auth, integrationId, box } = await setup();
    box.add(gmailMessage({ id: "f1", threadId: "FT", from: "x@y.io", date: daysAgo(1) }));
    await syncGmailMailbox(auth, { trigger: "manual" });
    const cursor = (await integration(integrationId)).syncCursor;

    box.add(gmailMessage({ id: "f2", threadId: "FT", from: "x@y.io", date: daysAgo(0) }));
    box.add(gmailMessage({ id: "f3", threadId: "FT", from: "x@y.io", date: daysAgo(0) }));
    google.fail(/\/messages\/f3$/, 500, 10);
    await expect(syncGmailMailbox(auth, { trigger: "manual" })).rejects.toBeInstanceOf(UpstreamServiceError);
    const failed = await integration(integrationId);
    expect(failed.syncCursor).toBe(cursor);
    expect(failed.lastError).toBe("Gmail is temporarily unavailable. Progress was saved; sync will resume later.");
    expect(failed.syncLeaseExpiresAt).toBeNull();

    google.failures = [];
    const r = await syncGmailMailbox(auth, { trigger: "manual" });
    expect(r.syncType).toBe("incremental");
    expect((await counts(integrationId)).messages).toBe(3);
    expect((await integration(integrationId)).lastError).toBeNull();
  });

  it("recovers from an expired history cursor with a bounded resync", async () => {
    const { auth, integrationId, box } = await setup();
    box.add(gmailMessage({ id: "h1", threadId: "HT", from: "x@y.io", date: daysAgo(1) }));
    await syncGmailMailbox(auth, { trigger: "manual" });
    box.add(gmailMessage({ id: "h2", threadId: "HT", from: "x@y.io", date: daysAgo(0) }));
    box.expireHistory();
    const r = await syncGmailMailbox(auth, { trigger: "manual" });
    expect(r.syncType).toBe("recovery");
    expect((await integration(integrationId)).syncCursor).toBe(String(box.historyId));
    expect((await counts(integrationId)).messages).toBe(2);
    const events = await ownerDb().auditLog.findMany({ where: { entityId: integrationId }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.event)).toContain("gmail.resync_required");
  });

  it("skips individually malformed messages without failing the sync", async () => {
    const { auth, integrationId, box } = await setup();
    box.add(gmailMessage({ id: "ok1", threadId: "MT", from: "x@y.io", date: daysAgo(1) }));
    box.add({ id: "bare", threadId: "MT", internalDate: String(daysAgo(1).getTime()) }); // no payload, no headers
    box.add(gmailMessage({ id: "weird", threadId: "MT", from: "<<<", date: daysAgo(1), payload: { mimeType: "application/octet-stream" } }));
    google.fail(/\/messages\/ok1$/, 400, 1); // provider returns garbage for one message
    const r = await syncGmailMailbox(auth, { trigger: "manual" });
    expect(r.skipped).toBe(1);
    const stored = await ownerDb().emailMessage.findMany({ where: { integrationId }, orderBy: { externalMessageId: "asc" } });
    expect(stored.map((m) => [m.externalMessageId, m.fromEmail, m.bodyText, m.direction])).toEqual([
      ["bare", null, null, "UNKNOWN"],
      ["weird", null, null, "UNKNOWN"],
    ]);
  });

  it("refreshes an expired access token and persists the new credentials", async () => {
    const org = await createOrgFixture(`syncrefresh${n++}`);
    const address = `refresh-${org.slug}@acme.test`;
    const { integrationId } = await connectGmailFixture(google, org.members.MEMBER, address, { expiresInSeconds: 1 });
    const before = (await integration(integrationId)).encryptedCredentials;
    await syncGmailMailbox(org.members.MEMBER, { trigger: "manual" });
    const after = await integration(integrationId);
    expect(after.encryptedCredentials).not.toBe(before);
    expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it("marks REAUTH_REQUIRED when Google revoked access, without deleting the integration", async () => {
    const { auth, integrationId, address } = await setup();
    google.revokeAllFor(address);
    await expect(syncGmailMailbox(auth, { trigger: "manual" })).rejects.toBeInstanceOf(PolicyViolationError);
    const row = await integration(integrationId);
    expect(row.status).toBe("REAUTH_REQUIRED");
    expect(row.lastError).toMatch(/Reconnect Gmail/);
    const events = (await ownerDb().auditLog.findMany({ where: { entityId: integrationId } })).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["gmail.token_refresh_failed", "gmail.reauth_required", "gmail.sync_failed"]));
    await expect(syncGmailMailbox(auth, { trigger: "manual" })).rejects.toThrow(/reconnected/);
  });
});

describe("concurrency", () => {
  it("two concurrent syncs for one integration: exactly one runs", async () => {
    const { auth, integrationId, box } = await setup();
    for (let i = 0; i < 30; i++) box.add(gmailMessage({ threadId: `CT${i % 3}`, from: "x@y.io", date: daysAgo(1) }));
    const results = await Promise.allSettled([
      syncGmailMailbox(auth, { trigger: "manual" }),
      syncGmailMailbox(auth, { trigger: "cron" }),
      syncGmailMailbox(auth, { trigger: "manual" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected.every((r) => r.reason instanceof ConflictError)).toBe(true);
    expect((await counts(integrationId)).messages).toBe(30);
  });

  it("a stale (expired) lease is recoverable", async () => {
    const { auth, integrationId } = await setup();
    await ownerDb().integration.update({ where: { id: integrationId }, data: { syncLeaseExpiresAt: new Date(Date.now() + 60_000) } });
    await expect(syncGmailMailbox(auth, { trigger: "manual" })).rejects.toBeInstanceOf(ConflictError);
    await ownerDb().integration.update({ where: { id: integrationId }, data: { syncLeaseExpiresAt: new Date(Date.now() - 1_000) } });
    await expect(syncGmailMailbox(auth, { trigger: "manual" })).resolves.toMatchObject({ syncType: "initial" });
  });
});
