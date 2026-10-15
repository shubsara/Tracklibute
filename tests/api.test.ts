import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as health } from "@/app/api/health/route";
import { GET as integrations } from "@/app/api/integrations/route";
import { GET as me } from "@/app/api/me/route";
import { DELETE as devLogout, POST as devLogin } from "@/app/api/dev/session/route";
import { GET as listResp, POST as createResp } from "@/app/api/responsibilities/route";
import type { AuthContext } from "@/domain/auth/auth-context";
import { getEnv } from "@/lib/env";
import { issueSessionToken } from "@/server/auth/session-token";
import { disconnectAppDb } from "@/server/db/client";
import { storeIntegrationCredentials } from "@/server/integrations/integrations.service";

import { closeOwnerDb, connectIntegration, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";

let A: OrgFixture;
let B: OrgFixture;

const bearer = (auth: Pick<AuthContext, "userId" | "organizationId">) =>
  `Bearer ${issueSessionToken(auth, getEnv().SESSION_SECRET)}`;

const req = (path: string, init: RequestInit & { auth?: AuthContext } = {}) => {
  const headers = new Headers(init.headers);
  if (init.auth) headers.set("authorization", bearer(init.auth));
  return new Request(`http://localhost${path}`, { ...init, headers });
};

beforeAll(async () => {
  A = await createOrgFixture("apia");
  B = await createOrgFixture("apib");
});

afterAll(async () => {
  await disconnectAppDb();
  await closeOwnerDb();
});

describe("GET /api/health", () => {
  it("reports database connectivity", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok" });
  });
});

describe("protected route GET /api/me", () => {
  it("401 without credentials", async () => {
    const res = await me(req("/api/me"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("401 with a forged or foreign-signed token", async () => {
    const forged = `Bearer ${issueSessionToken(A.members.OWNER, "not-the-server-secret-but-long-enough-000")}`;
    expect((await me(req("/api/me", { headers: { authorization: forged } }))).status).toBe(401);
    expect((await me(req("/api/me", { headers: { authorization: "Bearer garbage" } }))).status).toBe(401);
  });

  it("returns the server-derived user, organization and role", async () => {
    const res = await me(req("/api/me", { auth: A.members.ADMIN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      user: { id: A.members.ADMIN.userId, email: A.members.ADMIN.email },
      organization: { id: A.organizationId, slug: A.slug },
      role: "ADMIN",
    });
  });

  it("ignores client-supplied organization / user identifiers", async () => {
    const res = await me(
      req(`/api/me?organizationId=${B.organizationId}&userId=${B.members.OWNER.userId}`, {
        auth: A.members.VIEWER,
        headers: { "x-organization-id": B.organizationId, "x-user-id": B.members.OWNER.userId },
      }),
    );
    const body = await res.json();
    expect(body.organization.id).toBe(A.organizationId);
    expect(body.user.id).toBe(A.members.VIEWER.userId);
  });

  it("401 for a validly signed token claiming an org the user does not belong to", async () => {
    const claim = { userId: A.members.OWNER.userId, organizationId: B.organizationId };
    const res = await me(req("/api/me", { headers: { authorization: bearer(claim) } }));
    expect(res.status).toBe(401);
  });

  it("re-checks membership on every request (removal and role change take effect immediately)", async () => {
    const org = await createOrgFixture("apirevoke");
    const token = bearer(org.members.MEMBER);
    expect((await me(req("/api/me", { headers: { authorization: token } }))).status).toBe(200);

    await ownerDb().organizationMember.update({
      where: { organizationId_userId: { organizationId: org.organizationId, userId: org.members.MEMBER.userId } },
      data: { role: "VIEWER" },
    });
    expect((await (await me(req("/api/me", { headers: { authorization: token } }))).json()).role).toBe("VIEWER");

    await ownerDb().organizationMember.delete({
      where: { organizationId_userId: { organizationId: org.organizationId, userId: org.members.MEMBER.userId } },
    });
    expect((await me(req("/api/me", { headers: { authorization: token } }))).status).toBe(401);
  });
});

describe("organization-scoped routes", () => {
  it("GET /api/responsibilities returns only the caller's organization", async () => {
    const res = await listResp(req("/api/responsibilities", { auth: A.members.VIEWER }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; organizationId: string }[] };
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((r) => r.organizationId === A.organizationId)).toBe(true);
    expect(data.map((r) => r.id)).not.toContain(B.responsibilityId);
  });

  it("POST /api/responsibilities enforces roles and ignores a body organizationId", async () => {
    const body = JSON.stringify({ name: "Renewals watch", description: "Watch renewals", organizationId: B.organizationId });
    const asMember = await createResp(req("/api/responsibilities", { method: "POST", body, auth: A.members.MEMBER }));
    expect(asMember.status).toBe(403);

    const bad = await createResp(
      req("/api/responsibilities", {
        method: "POST",
        auth: A.members.ADMIN,
        body: JSON.stringify({ name: "x", description: "y", config: { steps: [{ action: "send_email" }] } }),
      }),
    );
    expect(bad.status).toBe(400);

    const asAdmin = await createResp(req("/api/responsibilities", { method: "POST", body, auth: A.members.ADMIN }));
    expect(asAdmin.status).toBe(201);
    const { data } = await asAdmin.json();
    expect(data).toMatchObject({ type: "CUSTOM", organizationId: A.organizationId });
  });

  it("GET /api/integrations never exposes credentials", async () => {
    const integration = await connectIntegration(A.organizationId, "HUBSPOT");
    await storeIntegrationCredentials(A.members.ADMIN, integration.id, { access_token: "hs-SECRET-123" });

    const res = await integrations(req("/api/integrations", { auth: A.members.MEMBER }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("hs-SECRET-123");
    expect(text).not.toContain("encryptedCredentials");
    expect(text).not.toMatch(/"v1\./);
    const { data } = JSON.parse(text) as { data: { id: string; hasCredentials: boolean }[] };
    expect(data.find((i) => i.id === integration.id)?.hasCredentials).toBe(true);
  });
});

describe("development session endpoint", () => {
  it("issues a session cookie only for a real membership", async () => {
    const ok = await devLogin(
      req("/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: A.members.OWNER.email, organizationSlug: A.slug }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/tl_dev_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
    const { token } = await ok.json();
    const viaToken = await me(req("/api/me", { headers: { authorization: `Bearer ${token}` } }));
    expect((await viaToken.json()).organization.id).toBe(A.organizationId);

    const wrongOrg = await devLogin(
      req("/api/dev/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: A.members.OWNER.email, organizationSlug: B.slug }),
      }),
    );
    expect(wrongOrg.status).toBe(401);
  });

  it("clears the session cookie on logout", async () => {
    const res = await devLogout();
    expect(res.headers.get("set-cookie")).toMatch(/tl_dev_session=; .*Max-Age=0/);
  });
});
