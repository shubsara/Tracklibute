import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as googleCallback } from "@/app/api/auth/google/callback/route";
import { GET as googleLogin } from "@/app/api/auth/google/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as devLoginRoute } from "@/app/api/dev/session/route";
import { GET as me } from "@/app/api/me/route";
import { POST as createOrg } from "@/app/api/organizations/route";
import { getEnv, resetEnvCache } from "@/lib/env";
import { issueSessionToken } from "@/server/auth/session-token";
import { hashSessionToken } from "@/server/auth/session-store";
import { disconnectAppDb, getAppDb } from "@/server/db/client";

import { bearer, cookieFrom, signIn } from "./support/auth-flow";
import type { FakeGoogle } from "./support/fake-google";
import { closeOwnerDb, createOrgFixture, ownerDb } from "./support/fixtures";
import { startFakeGoogleEnv } from "./support/google-env";

let google: FakeGoogle;
const uniq = () => randomUUID().slice(0, 8);
const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);

beforeAll(async () => {
  google = await startFakeGoogleEnv();
});
afterAll(async () => {
  await google.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

describe("Google sign-in + opaque sessions", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await me(req("/api/me"))).status).toBe(401);
    expect((await me(req("/api/me", { headers: bearer("A".repeat(43)) }))).status).toBe(401);
  });

  it("new user → onboarding → creates organization → becomes OWNER", async () => {
    const u = uniq();
    const { token, location } = await signIn(google, { sub: `sub-${u}`, email: `new-${u}@Example.com`, name: "New User" });
    expect(location).toBe("/onboarding");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await me(req("/api/me", { headers: bearer(token!) }))).status).toBe(401); // no org yet

    const res = await createOrg(req("/api/organizations", {
      method: "POST",
      headers: { ...bearer(token!), "content-type": "application/json" },
      body: JSON.stringify({ name: "Initech Sales", organizationId: randomUUID(), userId: randomUUID() }),
    }));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ name: "Initech Sales", role: "OWNER" });

    const meRes = await (await me(req("/api/me", { headers: bearer(token!) }))).json();
    expect(meRes).toMatchObject({ user: { email: `new-${u}@example.com`, name: "New User" }, organization: { id: data.organizationId }, role: "OWNER" });

    const user = await ownerDb().user.findUniqueOrThrow({ where: { email: `new-${u}@example.com` } });
    expect(user.googleSubject).toBe(`sub-${u}`);
    const member = await ownerDb().organizationMember.findFirstOrThrow({ where: { userId: user.id } });
    expect(member).toMatchObject({ organizationId: data.organizationId, role: "OWNER" });
    const audit = await ownerDb().auditLog.findFirst({ where: { organizationId: data.organizationId, event: "organization.created" } });
    expect(audit?.actorUserId).toBe(user.id);
  });

  it("refuses a second organization and validates the name", async () => {
    const u = uniq();
    const { token } = await signIn(google, { sub: `sub-${u}`, email: `two-${u}@example.com` });
    const post = (name: string) =>
      createOrg(req("/api/organizations", { method: "POST", headers: { ...bearer(token!), "content-type": "application/json" }, body: JSON.stringify({ name }) }));
    expect((await post("x")).status).toBe(400);
    expect((await post("First Co")).status).toBe(201);
    expect((await post("Second Co")).status).toBe(409);
    expect((await createOrg(req("/api/organizations", { method: "POST", body: "{}" }))).status).toBe(401);
  });

  it("an existing member signs in straight into their organization (identity keyed on Google sub)", async () => {
    const org = await createOrgFixture("signin");
    const { token, location } = await signIn(google, { sub: `sub-${uniq()}`, email: org.members.ADMIN.email.toUpperCase() });
    expect(location).toBe("/");
    const body = await (await me(req("/api/me", { headers: bearer(token!) }))).json();
    expect(body).toMatchObject({ organization: { id: org.organizationId }, role: "ADMIN", user: { id: org.members.ADMIN.userId } });
  });

  it("organization is server-derived; client cannot select another organization", async () => {
    const org = await createOrgFixture("nosel");
    const other = await createOrgFixture("noselother");
    const { token } = await signIn(google, { sub: `sub-${uniq()}`, email: org.members.MEMBER.email });
    const body = await (
      await me(req(`/api/me?organizationId=${other.organizationId}`, { headers: { ...bearer(token!), "x-organization-id": other.organizationId } }))
    ).json();
    expect(body.organization.id).toBe(org.organizationId);
  });

  it("stores only a hash of the session token", async () => {
    const u = uniq();
    const { token } = await signIn(google, { sub: `sub-${u}`, email: `hash-${u}@example.com` });
    expect(await ownerDb().session.count({ where: { tokenHash: token! } })).toBe(0);
    expect(await ownerDb().session.count({ where: { tokenHash: hashSessionToken(token!) } })).toBe(1);
  });

  it("logout revokes the server-side session and clears cookies", async () => {
    const org = await createOrgFixture("logout");
    const { token } = await signIn(google, { sub: `sub-${uniq()}`, email: org.members.OWNER.email });
    expect((await me(req("/api/me", { headers: bearer(token!) }))).status).toBe(200);
    const out = await logout(req("/api/auth/logout", { method: "POST", headers: bearer(token!) }));
    expect(out.status).toBe(200);
    expect(cookieFrom(out, "tl_session")).toBe("tl_session=");
    expect((await me(req("/api/me", { headers: bearer(token!) }))).status).toBe(401);
    const s = await ownerDb().session.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(token!) } });
    expect(s.revokedAt).not.toBeNull();
  });

  it("rejects cross-origin state-changing requests", async () => {
    const org = await createOrgFixture("csrf");
    const { token } = await signIn(google, { sub: `sub-${uniq()}`, email: org.members.OWNER.email });
    const res = await logout(req("/api/auth/logout", { method: "POST", headers: { ...bearer(token!), origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect((await me(req("/api/me", { headers: bearer(token!) }))).status).toBe(200);
  });

  it("app role cannot read the sessions table directly", async () => {
    await expect(getAppDb().$queryRawUnsafe("SELECT * FROM sessions")).rejects.toThrow(/permission denied/);
  });
});

describe("OAuth sign-in callback validation", () => {
  it("rejects a missing or tampered state cookie", async () => {
    const start = await googleLogin();
    const cb = google.authorize(start.headers.get("location")!, { sub: "s", email: "s@example.com" });
    const noCookie = await googleCallback(new Request(cb));
    expect(noCookie.headers.get("location")).toBe("/login?error=invalid_state");
    const tampered = cookieFrom(start, "tl_oauth_login")!.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await googleCallback(new Request(cb, { headers: { cookie: tampered } }))).headers.get("location")).toBe("/login?error=invalid_state");
  });

  it("rejects a callback whose state does not match the cookie (CSRF / login injection)", async () => {
    const victim = await googleLogin();
    const attacker = await googleLogin();
    const attackerCallback = google.authorize(attacker.headers.get("location")!, { sub: "attacker", email: "attacker@example.com" });
    const res = await googleCallback(new Request(attackerCallback, { headers: { cookie: cookieFrom(victim, "tl_oauth_login")! } }));
    expect(res.headers.get("location")).toBe("/login?error=sign_in_failed");
    expect(cookieFrom(res, "tl_session")).toBeNull();
  });

  it("rejects unverified Google emails and consent denial", async () => {
    const start = await googleLogin();
    const cb = google.authorize(start.headers.get("location")!, { sub: `sub-${uniq()}`, email: "unverified@example.com", emailVerified: false });
    const res = await googleCallback(new Request(cb, { headers: { cookie: cookieFrom(start, "tl_oauth_login")! } }));
    expect(res.headers.get("location")).toBe("/login?error=sign_in_failed");

    const denied = await googleLogin();
    const url = new URL("http://localhost/api/auth/google/callback?error=access_denied");
    const res2 = await googleCallback(new Request(url, { headers: { cookie: cookieFrom(denied, "tl_oauth_login")! } }));
    expect(res2.headers.get("location")).toBe("/login?error=consent_denied");
  });

  it("sign-in requests identity scopes only — it never connects Gmail", async () => {
    const start = await googleLogin();
    const u = new URL(start.headers.get("location")!);
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const id = uniq();
    const { token } = await signIn(google, { sub: `sub-${id}`, email: `nogmail-${id}@example.com` });
    const user = await ownerDb().user.findUniqueOrThrow({ where: { email: `nogmail-${id}@example.com` } });
    expect(token).not.toBeNull();
    expect(await ownerDb().integration.count({ where: { ownerUserId: user.id } })).toBe(0);
  });
});

describe("development auth boundary", () => {
  it("dev auth is unavailable in production mode", async () => {
    const org = await createOrgFixture("devprod");
    const devToken = issueSessionToken(org.members.OWNER, getEnv().SESSION_SECRET);
    expect((await me(req("/api/me", { headers: bearer(devToken) }))).status).toBe(200);

    const prev = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      resetEnvCache();
      expect((await me(req("/api/me", { headers: bearer(devToken) }))).status).toBe(401);
      const login = await devLoginRoute(req("/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: org.members.OWNER.email, organizationSlug: org.slug }),
      }));
      expect(login.status).toBe(403);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
      resetEnvCache();
    }
  });

  it("dev auth is off unless DEV_AUTH_ENABLED=true", async () => {
    const org = await createOrgFixture("devflag");
    const devToken = issueSessionToken(org.members.OWNER, getEnv().SESSION_SECRET);
    const prev = process.env.DEV_AUTH_ENABLED;
    try {
      process.env.DEV_AUTH_ENABLED = "false";
      resetEnvCache();
      expect((await me(req("/api/me", { headers: bearer(devToken) }))).status).toBe(401);
    } finally {
      process.env.DEV_AUTH_ENABLED = prev;
      resetEnvCache();
    }
  });
});
