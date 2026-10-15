import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as gmailCallback } from "@/app/api/integrations/gmail/callback/route";
import { GET as gmailConnect } from "@/app/api/integrations/gmail/connect/route";
import type { AuthContext } from "@/domain/auth/auth-context";
import {
  MailboxAccessDeniedError,
  MailboxAuthorizationRevokedError,
  MailboxProviderMisconfiguredError,
  MailboxRateLimitedError,
} from "@/domain/email/types";
import { getEnv } from "@/lib/env";
import { PolicyViolationError, ServiceUnavailableError, UpstreamServiceError } from "@/lib/errors";
import { issueSessionToken } from "@/server/auth/session-token";
import { disconnectAppDb } from "@/server/db/client";
import { GmailMailboxSource } from "@/server/integrations/gmail/gmail.adapter";
import { GmailClient } from "@/server/integrations/gmail/gmail.client";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";

import { cookieFrom } from "./support/auth-flow";
import { type FakeGoogle, gmailMessage, VirtualClock } from "./support/fake-google";
import { closeOwnerDb, createOrgFixture, ownerDb } from "./support/fixtures";
import { connectGmailFixture, daysAgo } from "./support/gmail-fixtures";
import { captureConsole, startFakeGoogleEnv } from "./support/google-env";

let google: FakeGoogle;
let n = 0;

/** Realistic Google error bodies (reason codes as Google documents them). */
const API_DISABLED = {
  error: {
    code: 403,
    status: "PERMISSION_DENIED",
    errors: [{ reason: "accessNotConfigured" }],
    details: [{ reason: "SERVICE_DISABLED" }],
  },
};
const API_DISABLED_DETAILS_ONLY = { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "forbidden" }], details: [{ reason: "SERVICE_DISABLED" }] } };
const INSUFFICIENT_SCOPE = { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }], details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } };
const GENERIC_403 = { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "domainPolicy" }] } };
const RATE_LIMIT_403 = { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } };

beforeAll(async () => {
  google = await startFakeGoogleEnv();
});
afterAll(async () => {
  await google.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});
beforeEach(() => {
  google.failures = [];
  google.requests = [];
  google.quota = null;
});

describe("client/adapter classification of Gmail 403s", () => {
  const BOX = "classify@acme.test";
  const source = () => {
    const t = google.issueTokens(BOX);
    const clock = new VirtualClock();
    return new GmailMailboxSource(new GmailClient({ baseUrl: google.gmailBase, getAccessToken: async () => t.accessToken, clock }));
  };

  it.each([
    ["accessNotConfigured / SERVICE_DISABLED", API_DISABLED, MailboxProviderMisconfiguredError, "accessNotConfigured"],
    ["SERVICE_DISABLED only in details[]", API_DISABLED_DETAILS_ONLY, MailboxProviderMisconfiguredError, "SERVICE_DISABLED"],
    ["insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT", INSUFFICIENT_SCOPE, MailboxAuthorizationRevokedError, "insufficientPermissions"],
    ["any other 403", GENERIC_403, MailboxAccessDeniedError, "domainPolicy"],
  ])("%s", async (_label, body, Expected, reason) => {
    google.fail(/\/profile$/, 403, 1, body);
    const err = await source().getMailbox().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Expected);
    expect((err as MailboxProviderMisconfiguredError).diagnostics).toEqual({ endpoint: "getProfile", httpStatus: 403, providerReason: reason });
  });

  it("rate-limit 403s are still rate limits (retried, then rate_limited)", async () => {
    google.fail(/\/profile$/, 403, 50, RATE_LIMIT_403);
    await expect(source().getMailbox()).rejects.toBeInstanceOf(MailboxRateLimitedError);
  });

  it("a persistent 401 (after one forced refresh) is a genuine revocation", async () => {
    google.fail(/\/profile$/, 401, 5, { error: { code: 401, status: "UNAUTHENTICATED" } });
    const err = await source().getMailbox().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailboxAuthorizationRevokedError);
    expect((err as MailboxAuthorizationRevokedError).diagnostics).toMatchObject({ httpStatus: 401, endpoint: "getProfile" });
  });
});

describe("sync: only genuine authorization problems set REAUTH_REQUIRED", () => {
  async function setup() {
    const org = await createOrgFixture(`c403${n++}`);
    const auth = org.members.MEMBER;
    const address = `c403-${n}-${org.slug}@acme.test`;
    const { integrationId } = await connectGmailFixture(google, auth, address);
    google.mailbox(address).add(gmailMessage({ threadId: "T", from: "x@y.io", date: daysAgo(1) }));
    return { auth, integrationId };
  }
  const row = (id: string) => ownerDb().integration.findUniqueOrThrow({ where: { id } });
  const events = async (id: string) => (await ownerDb().auditLog.findMany({ where: { entityId: id } })).map((e) => e.event);

  it("API disabled → stays CONNECTED with an actionable error and diagnostics", async () => {
    const { auth, integrationId } = await setup();
    google.fail(/\/profile$/, 403, 1, API_DISABLED);
    const cap = captureConsole();
    try {
      await expect(syncGmailMailbox(auth, { trigger: "manual" })).rejects.toBeInstanceOf(ServiceUnavailableError);
    } finally {
      cap.restore();
    }
    const r = await row(integrationId);
    expect(r.status).toBe("CONNECTED");
    expect(r.lastError).toMatch(/Gmail API is not enabled/);
    expect(r.syncLeaseExpiresAt).toBeNull();
    expect(await events(integrationId)).not.toContain("gmail.reauth_required");
    const failed = await ownerDb().auditLog.findFirstOrThrow({ where: { entityId: integrationId, event: "gmail.sync_failed" } });
    expect(failed.metadata).toMatchObject({ errorCode: "gmail_api_disabled", endpoint: "getProfile", httpStatus: 403, providerReason: "accessNotConfigured" });
    const line = JSON.parse(cap.lines.find((l) => l.includes('"event":"gmail.sync_failed"'))!);
    expect(line).toMatchObject({ errorCode: "gmail_api_disabled", endpoint: "getProfile", httpStatus: 403, providerReason: "accessNotConfigured" });
    expect(cap.lines.join("\n")).not.toMatch(/at-[0-9a-f]{8}|rt-[0-9a-f]{8}/);

    // Once fixed, the next sync simply works — no reconnect needed.
    google.failures = [];
    await expect(syncGmailMailbox(auth, { trigger: "manual" })).resolves.toMatchObject({ outcome: "completed" });
    expect((await row(integrationId)).lastError).toBeNull();
  });

  it("generic 403 → stays CONNECTED (access denied, retried later)", async () => {
    const { auth, integrationId } = await setup();
    google.fail(/\/messages$/, 403, 1, GENERIC_403);
    await expect(syncGmailMailbox(auth, { trigger: "cron" })).rejects.toBeInstanceOf(UpstreamServiceError);
    const r = await row(integrationId);
    expect(r.status).toBe("CONNECTED");
    expect(r.lastError).toMatch(/denied access/);
    expect(await events(integrationId)).not.toContain("gmail.reauth_required");
  });

  it("insufficient scope → REAUTH_REQUIRED (audited once, with diagnostics)", async () => {
    const { auth, integrationId } = await setup();
    google.fail(/\/profile$/, 403, 1, INSUFFICIENT_SCOPE);
    await expect(syncGmailMailbox(auth, { trigger: "manual" })).rejects.toBeInstanceOf(PolicyViolationError);
    expect((await row(integrationId)).status).toBe("REAUTH_REQUIRED");
    const reauth = await ownerDb().auditLog.findMany({ where: { entityId: integrationId, event: "gmail.reauth_required" } });
    expect(reauth).toHaveLength(1);
    expect(reauth[0]!.metadata).toMatchObject({ endpoint: "getProfile", httpStatus: 403, providerReason: "insufficientPermissions" });
  });

  it("persistent 401 from the Gmail API → REAUTH_REQUIRED", async () => {
    const { auth, integrationId } = await setup();
    google.fail(/\/profile$/, 401, 5, { error: { code: 401, status: "UNAUTHENTICATED" } });
    await expect(syncGmailMailbox(auth, { trigger: "manual" })).rejects.toBeInstanceOf(PolicyViolationError);
    expect((await row(integrationId)).status).toBe("REAUTH_REQUIRED");
  });

  it("revoked refresh token still → REAUTH_REQUIRED, without a duplicate audit entry", async () => {
    const org = await createOrgFixture(`c403rt${n++}`);
    const address = `rt-${org.slug}@acme.test`;
    const { integrationId } = await connectGmailFixture(google, org.members.MEMBER, address, { expiresInSeconds: 1 });
    google.revokeAllFor(address);
    await expect(syncGmailMailbox(org.members.MEMBER, { trigger: "manual" })).rejects.toBeInstanceOf(PolicyViolationError);
    expect((await row(integrationId)).status).toBe("REAUTH_REQUIRED");
    expect(await ownerDb().auditLog.count({ where: { entityId: integrationId, event: "gmail.reauth_required" } })).toBe(1);
  });
});

describe("connect callback: actionable outcomes, nothing stored", () => {
  const tokenFor = (a: AuthContext) => issueSessionToken(a, getEnv().SESSION_SECRET);
  async function connectWithProfileFailure(body: unknown) {
    const org = await createOrgFixture(`c403cb${n++}`);
    const a = org.members.MEMBER;
    const headers = { authorization: `Bearer ${tokenFor(a)}` };
    const start = await gmailConnect(new Request("http://localhost/api/integrations/gmail/connect", { headers }));
    const cb = google.authorize(start.headers.get("location")!, { sub: `s-${org.slug}`, email: `cb-${org.slug}@gmail.test` });
    google.fail(/\/profile$/, 403, 1, body);
    const cap = captureConsole();
    try {
      const res = await gmailCallback(new Request(cb, { headers: { ...headers, cookie: cookieFrom(start, "tl_oauth_gmail")! } }));
      return { res, org, logs: cap.lines };
    } finally {
      cap.restore();
    }
  }

  it("API disabled → ?gmail=api_disabled with diagnostics; no integration created", async () => {
    const { res, org, logs } = await connectWithProfileFailure(API_DISABLED);
    expect(res.headers.get("location")).toBe("/settings/integrations?gmail=api_disabled");
    expect(await ownerDb().integration.count({ where: { organizationId: org.organizationId, provider: "GMAIL" } })).toBe(0);
    const line = JSON.parse(logs.find((l) => l.includes('"event":"gmail.connect_failed"'))!);
    expect(line).toMatchObject({ endpoint: "getProfile", httpStatus: 403, providerReason: "accessNotConfigured" });
    expect(line.reason).toBe("MailboxProviderMisconfiguredError");
  });

  it("insufficient scope → ?gmail=insufficient_scope", async () => {
    const { res } = await connectWithProfileFailure(INSUFFICIENT_SCOPE);
    expect(res.headers.get("location")).toBe("/settings/integrations?gmail=insufficient_scope");
  });

  it("generic 403 → ?gmail=connect_failed", async () => {
    const { res } = await connectWithProfileFailure(GENERIC_403);
    expect(res.headers.get("location")).toBe("/settings/integrations?gmail=connect_failed");
  });
});

describe("network-error retry predicate", () => {
  it("does not retry our own revoked-grant error as a network error (fails fast, single refresh)", async () => {
    const org = await createOrgFixture(`c403net${n++}`);
    const address = `net-${org.slug}@acme.test`;
    await connectGmailFixture(google, org.members.MEMBER, address, { expiresInSeconds: 1 });
    google.revokeAllFor(address);
    google.requests = [];
    const t0 = Date.now();
    await expect(syncGmailMailbox(org.members.MEMBER, { trigger: "manual" })).rejects.toBeInstanceOf(PolicyViolationError);
    expect(Date.now() - t0).toBeLessThan(1_500); // previously ~3.5 s of bogus "network" backoff
    expect(google.requests.filter((r) => r.startsWith("POST /token"))).toHaveLength(1);
  });
});
