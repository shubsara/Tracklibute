import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MailboxAuthorizationRevokedError,
  MailboxCursorExpiredError,
  MailboxRateLimitedError,
  MailboxUnavailableError,
} from "@/domain/email/types";
import { GmailMailboxSource } from "@/server/integrations/gmail/gmail.adapter";
import { GmailApiError, GmailClient } from "@/server/integrations/gmail/gmail.client";
import { extractBodies, mapGmailMessage } from "@/server/integrations/gmail/gmail.mapper";

import { type FakeGoogle, gmailMessage } from "./support/fake-google";
import { startFakeGoogleEnv } from "./support/google-env";

let google: FakeGoogle;
const BOX = "rep@acme.test";
let tokens: ReturnType<FakeGoogle["issueTokens"]>;
let refreshCalls = 0;
const sleeps: number[] = [];

function client(overrides: Partial<ConstructorParameters<typeof GmailClient>[0]> = {}) {
  return new GmailClient({
    baseUrl: google.gmailBase,
    getAccessToken: async (force) => {
      if (force) {
        refreshCalls++;
        tokens = google.issueTokens(BOX);
      }
      return tokens.accessToken;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
}

beforeAll(async () => {
  google = await startFakeGoogleEnv();
});
afterAll(async () => {
  await google.stop();
});
beforeEach(() => {
  google.mailboxes.clear();
  google.failures = [];
  google.requests = [];
  tokens = google.issueTokens(BOX);
  refreshCalls = 0;
  sleeps.length = 0;
});

describe("Gmail client", () => {
  it("lists message ids with a field mask and paginates", async () => {
    const box = google.mailbox(BOX);
    for (let i = 0; i < 150; i++) box.add(gmailMessage({ id: `m${i}`, threadId: `t${i % 7}`, from: "a@x.io", date: new Date(Date.UTC(2026, 9, 1, 0, i)) }));
    const source = new GmailMailboxSource(client());
    const p1 = await source.listMessageIdsSince(new Date(Date.UTC(2026, 8, 1)));
    expect(p1.ids).toHaveLength(100);
    const p2 = await source.listMessageIdsSince(new Date(Date.UTC(2026, 8, 1)), p1.nextPageToken!);
    expect(p2.ids).toHaveLength(50);
    expect(p2.nextPageToken).toBeNull();
    expect(google.requests.find((r) => r.includes("/messages?"))).toMatch(/fields=messages%28id%2CthreadId%29%2CnextPageToken/);
  });

  it("retrieves a message, its thread metadata, and the profile", async () => {
    google.mailbox(BOX).add(gmailMessage({ id: "m1", threadId: "t1", from: "Buyer <b@x.io>", subject: "Hi", plain: "Hello" }));
    google.mailbox(BOX).add(gmailMessage({ id: "m2", threadId: "t1", from: BOX, subject: "Re: Hi", plain: "Yo" }));
    const source = new GmailMailboxSource(client());
    expect((await source.getMessage("m1"))?.subject).toBe("Hi");
    expect(await source.getMessage("missing")).toBeNull();
    const meta = await source.getThreadMetadata("t1");
    expect(meta.messageIds.sort()).toEqual(["m1", "m2"]);
    expect(await source.getMailbox()).toEqual({ address: BOX, cursor: String(google.mailbox(BOX).historyId) });
  });

  it("retrieves history: added, relabelled and deleted messages", async () => {
    const box = google.mailbox(BOX);
    const start = String(box.historyId);
    box.add(gmailMessage({ id: "a", threadId: "t", from: "x@y.io" }));
    box.add(gmailMessage({ id: "b", threadId: "t", from: "x@y.io" }));
    box.relabel("a", ["INBOX", "IMPORTANT"]);
    box.remove("b");
    const page = await new GmailMailboxSource(client()).listChangesSince(start);
    expect(page.changed).toEqual(["a"]);
    expect(page.deleted).toEqual(["b"]);
    expect(page.cursor).toBe(String(box.historyId));
  });

  it("maps an expired history cursor to MailboxCursorExpiredError", async () => {
    const box = google.mailbox(BOX);
    box.add(gmailMessage({ threadId: "t", from: "x@y.io" }));
    box.expireHistory();
    await expect(new GmailMailboxSource(client()).listChangesSince("1")).rejects.toBeInstanceOf(MailboxCursorExpiredError);
  });

  it("retries rate limits (honouring Retry-After) and 5xx, then succeeds", async () => {
    google.fail(/\/profile$/, 429, 1, { error: { code: 429 } }, { "retry-after": "2" });
    google.fail(/\/profile$/, 503, 1);
    google.fail(/\/profile$/, 403, 1, { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } });
    await expect(client().getProfile()).resolves.toMatchObject({ emailAddress: BOX });
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(3);
  });

  it("gives up after bounded retries with typed errors", async () => {
    google.fail(/\/profile$/, 429, 10);
    await expect(new GmailMailboxSource(client()).getMailbox()).rejects.toBeInstanceOf(MailboxRateLimitedError);
    google.failures = [];
    google.fail(/\/profile$/, 500, 10);
    await expect(new GmailMailboxSource(client()).getMailbox()).rejects.toBeInstanceOf(MailboxUnavailableError);
    google.failures = [];
    google.fail(/\/profile$/, 400, 1);
    await expect(client().getProfile()).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("refreshes once on an expired access token, then fails as revoked", async () => {
    google.expireAccessTokens();
    await expect(client().getProfile()).resolves.toMatchObject({ emailAddress: BOX });
    expect(refreshCalls).toBe(1);

    const broken = client({ getAccessToken: async () => "invalid-token" });
    await expect(broken.getProfile()).rejects.toBeInstanceOf(GmailApiError);
    await expect(new GmailMailboxSource(broken).getMailbox()).rejects.toBeInstanceOf(MailboxAuthorizationRevokedError);
  });

  it("never puts the access token in errors", async () => {
    google.fail(/\/profile$/, 400, 1, { error: { message: `bad token ${tokens.accessToken}` } });
    const err = await client().getProfile().catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(tokens.accessToken);
  });
});

describe("Gmail mapper", () => {
  it("parses sender, recipients, CC/BCC, subject, timestamps, snippet and labels", () => {
    const date = new Date("2026-10-01T10:00:00Z");
    const m = mapGmailMessage(
      gmailMessage({
        id: "x1",
        threadId: "t1",
        from: `"Doe, Jane" <JANE@Buyer.io>`,
        to: "rep@acme.test, Other <o@acme.test>",
        cc: "cfo@buyer.io",
        bcc: "boss@acme.test",
        subject: "=?UTF-8?Q?Pricing_=E2=80=94_Q4?=",
        date,
        plain: "Body",
        snippet: "It&#39;s &amp; ok",
        labelIds: ["INBOX", "IMPORTANT", "Label_123", "CATEGORY_PERSONAL"],
        extraHeaders: [
          { name: "In-Reply-To", value: "<prev@mail>" },
          { name: "References", value: "<a@m> <b@m>" },
          { name: "List-Unsubscribe", value: "<mailto:u@x>" },
        ],
      }),
    )!;
    expect(m.from).toEqual({ email: "jane@buyer.io", name: "Doe, Jane" });
    expect(m.to).toEqual([{ email: "rep@acme.test", name: null }, { email: "o@acme.test", name: "Other" }]);
    expect(m.cc).toEqual([{ email: "cfo@buyer.io", name: null }]);
    expect(m.bcc).toEqual([{ email: "boss@acme.test", name: null }]);
    expect(m.subject).toBe("Pricing — Q4");
    expect(m.sentAt?.toISOString()).toBe(date.toISOString());
    expect(m.receivedAt.toISOString()).toBe(date.toISOString());
    expect(m.snippet).toBe("It's & ok");
    expect(m.labels).toEqual(["INBOX", "IMPORTANT", "CATEGORY_PERSONAL"]);
    expect(m.metadata).toMatchObject({ inReplyTo: "<prev@mail>", references: ["<a@m>", "<b@m>"], hasListUnsubscribe: true });
  });

  it("prefers text/plain, falls back to text/html", () => {
    expect(mapGmailMessage(gmailMessage({ threadId: "t", from: "a@b.io", plain: "plain wins", html: "<p>html</p>" }))!.bodyText).toBe("plain wins");
    expect(mapGmailMessage(gmailMessage({ threadId: "t", from: "a@b.io", html: "<p>Only&nbsp;<b>html</b></p>" }))!.bodyText).toBe("Only html");
  });

  it("walks nested MIME, skips attachments, and decodes charsets", () => {
    const latin1 = Buffer.from("Café", "latin1").toString("base64url");
    const bodies = extractBodies({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "att1", size: 10 } },
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }], body: { data: latin1 } }],
        },
      ],
    });
    expect(bodies.plain).toBe("Café");
  });

  it("tolerates malformed MIME, missing bodies and missing participants", () => {
    const weird = mapGmailMessage({
      id: "w1",
      threadId: "t",
      internalDate: "1767225600000",
      payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: "<<<broken" }], parts: [{ mimeType: "text/plain", body: { data: "%%%not-base64%%%" } }, {} as never] },
    });
    expect(weird).toMatchObject({ from: null, to: [], subject: null, sentAt: null });
    expect(mapGmailMessage(gmailMessage({ threadId: "t", from: "a@b.io", plain: null, html: null }))!.bodyText).toBeNull();
    expect(mapGmailMessage({ id: "nopayload", threadId: "t", internalDate: "1767225600000" })).toMatchObject({ bodyText: null, from: null });
  });

  it("excludes drafts, spam, trash and chat; rejects messages without ids or dates", () => {
    for (const l of ["DRAFT", "SPAM", "TRASH", "CHAT"]) {
      expect(mapGmailMessage(gmailMessage({ threadId: "t", from: "a@b.io", labelIds: [l] }))).toBeNull();
    }
    expect(mapGmailMessage({ id: "", threadId: "t" } as never)).toBeNull();
    expect(mapGmailMessage({ id: "x", threadId: "t", payload: { headers: [] } })).toBeNull();
  });
});
