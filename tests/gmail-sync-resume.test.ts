import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { UpstreamServiceError } from "@/lib/errors";
import { disconnectAppDb } from "@/server/db/client";
import { QuotaPacer, rateLimitBackoffMs } from "@/server/integrations/gmail/gmail.client";
import { getGmailStatus } from "@/server/integrations/gmail/gmail-connection.service";
import { FETCH_CONCURRENCY, syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";

import { type FakeGoogle, gmailMessage, VirtualClock } from "./support/fake-google";
import { closeOwnerDb, createOrgFixture, ownerDb } from "./support/fixtures";
import { connectGmailFixture, daysAgo } from "./support/gmail-fixtures";
import { captureConsole, startFakeGoogleEnv } from "./support/google-env";

let google: FakeGoogle;
let clock: VirtualClock;
let n = 0;

beforeAll(async () => {
  google = await startFakeGoogleEnv();
});
afterAll(async () => {
  await google.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});
beforeEach(() => {
  clock = new VirtualClock();
  google.clock = clock;
  google.quota = null;
  google.rateLimited = 0;
  google.failures = [];
  google.requests = [];
});

async function setup(messageCount: number) {
  const org = await createOrgFixture(`resume${n++}`);
  const auth = org.members.MEMBER;
  const address = `rs${n}-${org.slug}@acme.test`;
  const { integrationId } = await connectGmailFixture(google, auth, address);
  const box = google.mailbox(address);
  for (let i = 0; i < messageCount; i++) {
    box.add(gmailMessage({ id: `r${n}m${i}`, threadId: `r${n}t${i % 25}`, from: "buyer@x.io", plain: "hi", date: daysAgo(1 + (i % 28)) }));
  }
  return { org, auth, address, integrationId, box };
}

const row = (id: string) => ownerDb().integration.findUniqueOrThrow({ where: { id } });
const stored = (integrationId: string) => ownerDb().emailMessage.count({ where: { integrationId } });
const getRequests = () => google.requests.filter((r) => /\/messages\/[^?/]+\?/.test(r)).map((r) => r.match(/\/messages\/([^?]+)\?/)![1]!);

describe("quota pacer and backoff (units)", () => {
  it("spaces requests to the configured units/second", async () => {
    const c = new VirtualClock();
    const start = c.now();
    const pacer = new QuotaPacer(80, c);
    for (let i = 0; i < 5; i++) await pacer.acquire(20); // messages.get = 20 units
    expect(c.now() - start).toBe(1000); // 4 gets/second → 5th starts at +1s
    pacer.pauseUntil(c.now() + 5000);
    await pacer.acquire(1);
    expect(c.now() - start).toBe(6000);
  });

  it("uses truncated exponential backoff with jitter (Google guidance)", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => rateLimitBackoffMs(a, () => 0))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 32000]);
    expect(rateLimitBackoffMs(0, () => 0.999)).toBeLessThan(2000);
    expect(rateLimitBackoffMs(10, () => 0.999)).toBeLessThan(33000);
  });

  it("runs at most 2 concurrent message fetches", () => {
    expect(FETCH_CONCURRENCY).toBe(2);
  });
});

describe("quota-aware initial sync", () => {
  it("stays under Gmail's 6,000 units/minute/user — zero 429s", async () => {
    const { auth, integrationId } = await setup(400);
    google.quota = { unitsPerWindow: 6000, windowMs: 60_000 };
    const t0 = clock.now();
    const r = await syncGmailMailbox(auth, { trigger: "manual", clock, unitsPerSecond: 80, deadlineAt: t0 + 30 * 60_000 });
    expect(r.outcome).toBe("completed");
    expect(await stored(integrationId)).toBe(400);
    expect(google.rateLimited).toBe(0);
    expect(clock.now() - t0).toBeGreaterThanOrEqual((400 * 20 * 1000) / 80); // ≥ 100 s of paced time
  }, 60_000);

  it("unpaced bursts that hit 429 recover through exponential backoff", async () => {
    const { auth, integrationId } = await setup(120);
    google.quota = { unitsPerWindow: 1200, windowMs: 10_000 };
    const r = await syncGmailMailbox(auth, { trigger: "manual", clock, unitsPerSecond: 1_000_000, deadlineAt: clock.now() + 30 * 60_000 });
    expect(r.outcome).toBe("completed");
    expect(await stored(integrationId)).toBe(120);
    expect(google.rateLimited).toBeGreaterThan(0);
    expect(clock.sleeps.some((ms) => ms >= 1000)).toBe(true);
  }, 60_000);
});

describe("resumable, time-boxed initial backfill", () => {
  it("partial runs keep progress, never refetch stored messages, and commit the ORIGINAL checkpoint", async () => {
    const { auth, integrationId, box } = await setup(250);
    const h0 = String(box.historyId);

    // Run 1: budget for 100 fetches → PARTIAL (not a failure).
    const r1 = await syncGmailMailbox(auth, { trigger: "connect", clock, maxMessageFetches: 100 });
    expect(r1).toMatchObject({ outcome: "partial", syncType: "initial", resumed: false, cursorAfter: null, messagesUpserted: 100 });
    let i = await row(integrationId);
    expect(i).toMatchObject({ syncCursor: null, backfillCursor: h0, lastError: null, lastSyncedAt: null, syncLeaseExpiresAt: null });
    const status = await getGmailStatus(auth);
    expect(status).toMatchObject({ initialSyncComplete: false, backfillInProgress: true, messagesSynced: 100, lastError: null });
    const run1Ids = new Set(getRequests());
    expect(run1Ids.size).toBe(100);

    // Mailbox changes WHILE the backfill is still incomplete.
    const storedOne = [...run1Ids][0]!;
    box.remove(storedOne);
    box.add(gmailMessage({ id: `r${n}late`, threadId: "late", from: "new@x.io", date: daysAgo(0) }));

    // Run 2: resumes — fetches only messages not yet stored.
    google.requests = [];
    const r2 = await syncGmailMailbox(auth, { trigger: "manual", clock, maxMessageFetches: 100 });
    expect(r2).toMatchObject({ outcome: "partial", resumed: true, messagesUpserted: 100 });
    expect(r2.alreadySynced).toBeGreaterThanOrEqual(99);
    const run2Ids = getRequests();
    expect(run2Ids.filter((id) => run1Ids.has(id))).toEqual([]);

    // Run 3: completes; checkpoint = historyId from when the backfill FIRST started.
    google.requests = [];
    const r3 = await syncGmailMailbox(auth, { trigger: "cron", clock });
    expect(r3).toMatchObject({ outcome: "completed", resumed: true, cursorAfter: h0 });
    expect(getRequests().filter((id) => run1Ids.has(id) || run2Ids.includes(id))).toEqual([]);
    i = await row(integrationId);
    expect(i).toMatchObject({ syncCursor: h0, backfillCursor: null, lastError: null });
    expect(i.lastSyncedAt).not.toBeNull();
    expect(await stored(integrationId)).toBe(251); // 250 + late arrival; the deletion is replayed next

    // Run 4: incremental from h0 replays the deletion that happened mid-backfill.
    const r4 = await syncGmailMailbox(auth, { trigger: "cron", clock });
    expect(r4).toMatchObject({ outcome: "completed", syncType: "incremental", cursorBefore: h0 });
    expect(await ownerDb().emailMessage.count({ where: { integrationId, externalMessageId: storedOne } })).toBe(0);
    expect(await stored(integrationId)).toBe(250);
    expect(await ownerDb().auditLog.count({ where: { entityId: integrationId, event: "gmail.sync_partial" } })).toBe(2);
  }, 60_000);

  it("a wall-clock deadline ends the run as PARTIAL without overshooting by a whole batch", async () => {
    const { auth, integrationId } = await setup(300);
    const t0 = clock.now();
    const r = await syncGmailMailbox(auth, { trigger: "manual", clock, unitsPerSecond: 80, deadlineAt: t0 + 30_000 });
    expect(r.outcome).toBe("partial");
    const count = await stored(integrationId);
    expect(count).toBeGreaterThan(100);
    expect(count).toBeLessThan(300);
    expect(clock.now() - t0).toBeLessThan(30_000 + 1_000); // stops within ~one request of the deadline
    expect((await row(integrationId)).syncLeaseExpiresAt).toBeNull();
  }, 60_000);

  it("a rate-limit failure mid-backfill is a FAILURE, keeps progress and the backfill checkpoint, and resumes", async () => {
    const { auth, integrationId, box } = await setup(150);
    // Gmail lists newest first: let the first 100 succeed, then exhaust retries on one id in batch 2.
    const listed = [...box.messages.values()].sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
    const victim = listed[120]!.id;
    google.fail(new RegExp(`/messages/${victim}$`), 429, 50, { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } });

    const cap = captureConsole();
    let err: unknown;
    try {
      await syncGmailMailbox(auth, { trigger: "manual", clock }).catch((e: unknown) => (err = e));
    } finally {
      cap.restore();
    }
    expect(err).toBeInstanceOf(UpstreamServiceError);
    const i = await row(integrationId);
    expect(i.syncCursor).toBeNull();
    expect(i.backfillCursor).not.toBeNull();
    expect(i.lastError).toBe("Gmail rate limit reached. Progress was saved; sync will resume later.");
    const kept = await stored(integrationId);
    expect(kept).toBeGreaterThanOrEqual(100);

    // Diagnostics: endpoint + status + Google reason; nothing secret, no content.
    const failedLine = cap.lines.find((l) => l.includes('"event":"gmail.sync_failed"'))!;
    expect(JSON.parse(failedLine)).toMatchObject({ endpoint: "messages.get", httpStatus: 429, providerReason: "rateLimitExceeded", errorCode: "rate_limited" });
    expect(cap.lines.join("\n")).not.toMatch(/at-[0-9a-f]{8}|rt-[0-9a-f]{8}|"hi"/);
    const audit = await ownerDb().auditLog.findFirstOrThrow({ where: { entityId: integrationId, event: "gmail.sync_failed" } });
    expect(audit.metadata).toMatchObject({ endpoint: "messages.get", httpStatus: 429 });

    // Retry resumes: only messages not yet stored are fetched.
    google.failures = [];
    google.requests = [];
    const r = await syncGmailMailbox(auth, { trigger: "manual", clock });
    expect(r).toMatchObject({ outcome: "completed", resumed: true });
    expect(getRequests()).toHaveLength(150 - kept);
    expect(await stored(integrationId)).toBe(150);
  }, 60_000);

  it("a fatal error stops sibling workers instead of continuing to call Gmail", async () => {
    const { auth } = await setup(100);
    google.fail(/\/messages\/[^/]+$/, 503, 10_000);
    await expect(syncGmailMailbox(auth, { trigger: "manual", clock })).rejects.toBeInstanceOf(UpstreamServiceError);
    const ids = new Set(getRequests());
    expect(ids.size).toBeLessThanOrEqual(FETCH_CONCURRENCY); // 100 queued, only the in-flight ones were attempted
  }, 60_000);

  it("expired history → recovery backfill that can itself span runs", async () => {
    const { auth, integrationId, box } = await setup(30);
    await syncGmailMailbox(auth, { trigger: "manual", clock });
    for (let i = 0; i < 20; i++) box.add(gmailMessage({ threadId: "newer", from: "z@x.io", date: daysAgo(0) }));
    box.expireHistory();
    const r1 = await syncGmailMailbox(auth, { trigger: "cron", clock, maxMessageFetches: 10 });
    expect(r1).toMatchObject({ syncType: "recovery", outcome: "partial" });
    expect(await row(integrationId)).toMatchObject({ syncCursor: null, backfillCursor: String(box.historyId) });
    const r2 = await syncGmailMailbox(auth, { trigger: "cron", clock });
    expect(r2).toMatchObject({ syncType: "initial", outcome: "completed", resumed: true });
    expect(await stored(integrationId)).toBe(50);
    expect((await row(integrationId)).syncCursor).toBe(String(box.historyId));
  }, 60_000);
});
