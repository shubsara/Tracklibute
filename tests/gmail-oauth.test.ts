import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELETE as disconnect, GET as gmailStatus } from "@/app/api/integrations/gmail/route";
import { GET as gmailCallback } from "@/app/api/integrations/gmail/callback/route";
import { GET as gmailConnect } from "@/app/api/integrations/gmail/connect/route";
import { getEnv } from "@/lib/env";
import { issueSessionToken } from "@/server/auth/session-token";
import { disconnectAppDb } from "@/server/db/client";
import { loadIntegrationCredentials } from "@/server/integrations/integrations.service";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";

import { cookieFrom } from "./support/auth-flow";
import type { FakeGoogle } from "./support/fake-google";
import { closeOwnerDb, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";
import { GMAIL_REDIRECT, startFakeGoogleEnv } from "./support/google-env";
import type { AuthContext } from "@/domain/auth/auth-context";

let google: FakeGoogle;
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

const tokenFor = (a: AuthContext) => issueSessionToken(a, getEnv().SESSION_SECRET);
const req = (path: string, auth: AuthContext | null, init: RequestInit & { cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (auth) headers.set("authorization", `Bearer ${tokenFor(auth)}`);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(path.startsWith("http") ? path : `http://localhost${path}`, { ...init, headers });
};

/** Run the full connect flow; returns the callback response. */
async function connect(auth: AuthContext, mailbox: string, opts: { grantedScope?: string; callbackAs?: AuthContext | null } = {}) {
  const start = await gmailConnect(req("/api/integrations/gmail/connect", auth));
  expect(start.status).toBe(302);
  const cb = google.authorize(start.headers.get("location")!, { sub: `g-${mailbox}`, email: mailbox, grantedScope: opts.grantedScope });
  const as = opts.callbackAs === undefined ? auth : opts.callbackAs;
  return gmailCallback(req(cb, as, { cookie: cookieFrom(start, "tl_oauth_gmail")! }));
}

beforeAll(async () => {
  google = await startFakeGoogleEnv();
});
afterAll(async () => {
  await google.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

let org: OrgFixture;
const mailboxOf = (o: OrgFixture) => `owner-${o.slug}@gmail.test`;

describe("Gmail connect — authorization request", () => {
  it("builds a read-only, offline, PKCE-protected authorization URL", async () => {
    org = await createOrgFixture("gmoauth");
    const res = await gmailConnect(req("/api/integrations/gmail/connect", org.members.MEMBER));
    const u = new URL(res.headers.get("location")!);
    expect(u.searchParams.get("scope")).toBe(`openid email ${GMAIL_READONLY}`);
    expect(u.searchParams.get("scope")).not.toMatch(/gmail\.(send|modify|compose)|mail\.google\.com/);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe(GMAIL_REDIRECT);
    expect(u.searchParams.get("state")).toMatch(/.{20,}/);
    expect(cookieFrom(res, "tl_oauth_gmail")).toBeTruthy();
    expect(res.headers.getSetCookie().join(";")).toMatch(/HttpOnly/);

    const again = new URL((await gmailConnect(req("/api/integrations/gmail/connect", org.members.MEMBER))).headers.get("location")!);
    expect(again.searchParams.get("state")).not.toBe(u.searchParams.get("state"));
  });

  it("requires authentication and a non-viewer role", async () => {
    expect((await gmailConnect(req("/api/integrations/gmail/connect", null))).status).toBe(401);
    expect((await gmailConnect(req("/api/integrations/gmail/connect", org.members.VIEWER))).status).toBe(403);
  });
});

describe("Gmail connect — callback", () => {
  it("connects the mailbox: encrypted credentials, CONNECTED status, audit trail", async () => {
    const o = await createOrgFixture("gmconnect");
    const res = await connect(o.members.MEMBER, mailboxOf(o));
    expect(res.headers.get("location")).toBe("/settings/integrations?gmail=connected");

    const row = await ownerDb().integration.findFirstOrThrow({ where: { organizationId: o.organizationId, provider: "GMAIL" } });
    expect(row).toMatchObject({ status: "CONNECTED", ownerUserId: o.members.MEMBER.userId, externalAccountId: mailboxOf(o) });
    expect(row.scopes).toContain(GMAIL_READONLY);
    expect(row.encryptedCredentials).toMatch(/^v1\./);
    expect(row.encryptedCredentials).not.toMatch(/at-|rt-/);
    const creds = await loadIntegrationCredentials(o.members.MEMBER, row.id);
    expect(creds).toMatchObject({ accessToken: expect.stringMatching(/^at-/), refreshToken: expect.stringMatching(/^rt-/) });

    const events = (await ownerDb().auditLog.findMany({ where: { organizationId: o.organizationId }, orderBy: { createdAt: "asc" } })).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["gmail.connect_started", "gmail.connected"]));

    const status = await (await gmailStatus(req("/api/integrations/gmail", o.members.MEMBER))).json();
    expect(status.data).toMatchObject({ connected: true, status: "CONNECTED", accountEmail: mailboxOf(o), messagesSynced: 0 });
    expect(JSON.stringify(status)).not.toMatch(/at-|rt-|encrypted|token/i);
  });

  it("rejects a callback without an authenticated session", async () => {
    const o = await createOrgFixture("gmnoauth");
    const res = await connect(o.members.MEMBER, mailboxOf(o), { callbackAs: null });
    expect(res.headers.get("location")).toBe("/login?error=session_required");
    expect(await ownerDb().integration.count({ where: { organizationId: o.organizationId, provider: "GMAIL" } })).toBe(0);
  });

  it("rejects an invalid or missing state", async () => {
    const o = await createOrgFixture("gmstate");
    const start = await gmailConnect(req("/api/integrations/gmail/connect", o.members.MEMBER));
    const cb = google.authorize(start.headers.get("location")!, { sub: "x", email: mailboxOf(o) });
    expect((await gmailCallback(req(cb, o.members.MEMBER))).headers.get("location")).toBe("/settings/integrations?gmail=invalid_state");
    const forged = new URL(cb);
    forged.searchParams.set("state", "attacker-state");
    const res = await gmailCallback(req(forged.toString(), o.members.MEMBER, { cookie: cookieFrom(start, "tl_oauth_gmail")! }));
    expect(res.headers.get("location")).toBe("/settings/integrations?gmail=connect_failed");
    expect(await ownerDb().integration.count({ where: { organizationId: o.organizationId, provider: "GMAIL" } })).toBe(0);
  });

  it("rejects a transaction started by a different user (session binding)", async () => {
    const o = await createOrgFixture("gmbind");
    const res = await connect(o.members.MEMBER, mailboxOf(o), { callbackAs: o.members.OWNER });
    expect(res.headers.get("location")).toBe("/settings/integrations?gmail=connect_failed");
    expect(await ownerDb().integration.count({ where: { organizationId: o.organizationId, provider: "GMAIL" } })).toBe(0);
  });

  it("ignores organization/user identifiers smuggled into the callback URL", async () => {
    const o = await createOrgFixture("gmsmuggle");
    const victim = await createOrgFixture("gmvictim");
    const start = await gmailConnect(req("/api/integrations/gmail/connect", o.members.MEMBER));
    const cb = new URL(google.authorize(start.headers.get("location")!, { sub: "s", email: mailboxOf(o) }));
    cb.searchParams.set("organizationId", victim.organizationId);
    cb.searchParams.set("userId", victim.members.OWNER.userId);
    await gmailCallback(req(cb.toString(), o.members.MEMBER, { cookie: cookieFrom(start, "tl_oauth_gmail")! }));
    expect(await ownerDb().integration.count({ where: { organizationId: victim.organizationId, provider: "GMAIL" } })).toBe(0);
    expect(await ownerDb().integration.count({ where: { organizationId: o.organizationId, ownerUserId: o.members.MEMBER.userId } })).toBe(1);
  });

  it("refuses when read-only Gmail access was not granted", async () => {
    const o = await createOrgFixture("gmscope");
    const res = await connect(o.members.MEMBER, mailboxOf(o), { grantedScope: "openid email" });
    expect(res.headers.get("location")).toBe("/settings/integrations?gmail=connect_failed");
    expect(await ownerDb().integration.count({ where: { organizationId: o.organizationId, provider: "GMAIL" } })).toBe(0);
  });
});

describe("Gmail disconnect and revoked authorization", () => {
  it("disconnect revokes at Google, wipes credentials and cursor, keeps the row", async () => {
    const o = await createOrgFixture("gmdisc");
    await connect(o.members.MEMBER, mailboxOf(o));
    const row = await ownerDb().integration.findFirstOrThrow({ where: { organizationId: o.organizationId, provider: "GMAIL" } });
    const { refreshToken } = (await loadIntegrationCredentials(o.members.MEMBER, row.id)) as { refreshToken: string };

    const res = await disconnect(req("/api/integrations/gmail", o.members.MEMBER, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(google.revokedTokens).toContain(refreshToken);
    const after = await ownerDb().integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "DISCONNECTED", encryptedCredentials: null, syncCursor: null });
    const status = await (await gmailStatus(req("/api/integrations/gmail", o.members.MEMBER))).json();
    expect(status.data).toMatchObject({ connected: false, status: "DISCONNECTED" });
    expect((await disconnect(req("/api/integrations/gmail", o.members.OWNER, { method: "DELETE" }))).status).toBe(404);
  });

  it("revoked Google access → REAUTH_REQUIRED status; reconnecting restores CONNECTED", async () => {
    const o = await createOrgFixture("gmrevoke");
    const box = mailboxOf(o);
    await connect(o.members.MEMBER, box);
    google.revokeAllFor(box);
    await expect(syncGmailMailbox(o.members.MEMBER, { trigger: "manual" })).rejects.toThrow(/Reconnect Gmail/);
    const status = await (await gmailStatus(req("/api/integrations/gmail", o.members.MEMBER))).json();
    expect(status.data).toMatchObject({ connected: false, status: "REAUTH_REQUIRED" });

    await connect(o.members.MEMBER, box);
    const rows = await ownerDb().integration.findMany({ where: { organizationId: o.organizationId, provider: "GMAIL" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("CONNECTED");
  });

  it("connecting a different Google mailbox discards the previous mailbox's data", async () => {
    const o = await createOrgFixture("gmswap");
    await connect(o.members.MEMBER, `first-${randomUUID().slice(0, 6)}@gmail.test`);
    const row = await ownerDb().integration.findFirstOrThrow({ where: { organizationId: o.organizationId, provider: "GMAIL" } });
    await ownerDb().emailThread.create({
      data: { organizationId: o.organizationId, mailboxUserId: o.members.MEMBER.userId, integrationId: row.id, externalThreadId: "old", firstMessageAt: new Date(), lastMessageAt: new Date() },
    });
    await connect(o.members.MEMBER, `second-${randomUUID().slice(0, 6)}@gmail.test`);
    expect(await ownerDb().emailThread.count({ where: { integrationId: row.id } })).toBe(0);
    expect((await ownerDb().integration.findUniqueOrThrow({ where: { id: row.id } })).syncCursor).toBeNull();
  });
});
