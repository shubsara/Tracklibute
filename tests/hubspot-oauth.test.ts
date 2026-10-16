import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as hubspotCallback } from "@/app/api/integrations/hubspot/callback/route";
import { GET as hubspotConnect } from "@/app/api/integrations/hubspot/connect/route";
import { DELETE as hubspotDisconnect, GET as hubspotStatus } from "@/app/api/integrations/hubspot/route";
import type { AuthContext } from "@/domain/auth/auth-context";
import { disconnectAppDb } from "@/server/db/client";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { loadIntegrationCredentials } from "@/server/integrations/integrations.service";

import { cookieFrom } from "./support/auth-flow";
import { type FakeHubSpot, HUBSPOT_READ_SCOPES } from "./support/fake-hubspot";
import { closeOwnerDb, createOrgFixture, ownerDb } from "./support/fixtures";
import { captureConsole } from "./support/google-env";
import { connectHubSpotFixture } from "./support/hubspot-fixtures";
import { HUBSPOT_REDIRECT, startFakeHubSpotEnv } from "./support/hubspot-env";
import { authedRequest as req } from "./support/requests";

let hubspot: FakeHubSpot;

beforeAll(async () => {
  hubspot = await startFakeHubSpotEnv();
});
afterAll(async () => {
  await hubspot.stop();
  await disconnectAppDb();
  await closeOwnerDb();
});

async function connect(admin: AuthContext, opts: { scopes?: string[]; hubId?: string; callbackAs?: AuthContext; tamperState?: boolean } = {}) {
  const start = await hubspotConnect(req("/api/integrations/hubspot/connect", admin));
  expect(start.status).toBe(302);
  let cb = hubspot.authorize(start.headers.get("location")!, { scopes: opts.scopes, hubId: opts.hubId });
  if (opts.tamperState) cb = cb.replace(/state=[^&]+/, "state=forged");
  return hubspotCallback(req(cb, opts.callbackAs ?? admin, { cookie: cookieFrom(start, "tl_oauth_hubspot")! }));
}
const orgRow = (organizationId: string) => ownerDb().integration.findFirst({ where: { organizationId, provider: "HUBSPOT", ownerUserId: null } });

describe("HubSpot connect — authorization request", () => {
  it("asks for read-only scopes only, with a signed, user-bound state cookie", async () => {
    const o = await createOrgFixture("hsauth");
    const res = await hubspotConnect(req("/api/integrations/hubspot/connect", o.members.ADMIN));
    const u = new URL(res.headers.get("location")!);
    const scopes = u.searchParams.get("scope")!.split(" ");
    expect(scopes.sort()).toEqual([...HUBSPOT_READ_SCOPES].sort());
    expect(scopes.some((s) => /write|delete|create|update/.test(s))).toBe(false);
    expect(u.searchParams.get("redirect_uri")).toBe(HUBSPOT_REDIRECT);
    expect(u.searchParams.get("state")).toMatch(/.{20,}/);
    expect(res.headers.getSetCookie().join(";")).toMatch(/tl_oauth_hubspot=.*HttpOnly/);
  });

  it("requires ADMIN (org-wide integration)", async () => {
    const o = await createOrgFixture("hsrole");
    expect((await hubspotConnect(req("/api/integrations/hubspot/connect", null))).status).toBe(401);
    expect((await hubspotConnect(req("/api/integrations/hubspot/connect", o.members.MEMBER))).status).toBe(403);
    expect((await hubspotConnect(req("/api/integrations/hubspot/connect", o.members.VIEWER))).status).toBe(403);
  });
});

describe("HubSpot connect — callback", () => {
  it("connects: one org-wide row, encrypted credentials, hub id, audit; no secrets anywhere visible", async () => {
    const o = await createOrgFixture("hsconnect");
    await ownerDb().integration.create({ data: { organizationId: o.organizationId, provider: "HUBSPOT" } }); // seed placeholder
    const logs = captureConsole();
    let res: Response;
    try {
      res = await connect(o.members.ADMIN, { hubId: "777001" });
    } finally {
      logs.restore();
    }
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings/integrations?hubspot=connected");
    const rows = await ownerDb().integration.findMany({ where: { organizationId: o.organizationId, provider: "HUBSPOT" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "CONNECTED", externalAccountId: "777001", ownerUserId: null, connectedByUserId: o.members.ADMIN.userId });
    expect(rows[0]!.encryptedCredentials).toMatch(/^v1\./);
    expect(rows[0]!.encryptedCredentials).not.toMatch(/hat-|hrt-/);
    const creds = await loadIntegrationCredentials(o.members.ADMIN, rows[0]!.id);
    expect(creds).toMatchObject({ hubId: "777001" });
    expect(logs.lines.join("\n")).not.toMatch(/hat-|hrt-|code-[0-9a-f]{10}|fake-hubspot-client-secret/);

    const status = await (await hubspotStatus(req("/api/integrations/hubspot", o.members.VIEWER))).json();
    expect(status.data).toMatchObject({ connected: true, hubId: "777001" });
    expect(JSON.stringify(status)).not.toMatch(/hat-|hrt-|v1\./);
    const audit = await ownerDb().auditLog.findMany({ where: { organizationId: o.organizationId, event: "hubspot.connected" } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/hat-|hrt-/);
  });

  it("refuses a grant that carries any write scope — nothing stored", async () => {
    const o = await createOrgFixture("hswrite");
    const res = await connect(o.members.ADMIN, { scopes: [...HUBSPOT_READ_SCOPES, "crm.objects.deals.write"] });
    expect(res.headers.get("location")).toBe("/settings/integrations?hubspot=permissions");
    expect((await orgRow(o.organizationId))?.encryptedCredentials ?? null).toBeNull();
  });

  it("refuses a grant missing a required read scope", async () => {
    const o = await createOrgFixture("hsmissing");
    const res = await connect(o.members.ADMIN, { scopes: ["oauth", "crm.objects.deals.read"] });
    expect(res.headers.get("location")).toBe("/settings/integrations?hubspot=permissions");
    expect(await orgRow(o.organizationId)).toBeNull();
  });

  it("rejects a forged state and a callback from a different session", async () => {
    const o = await createOrgFixture("hsstate");
    expect((await connect(o.members.ADMIN, { tamperState: true })).headers.get("location")).toBe("/settings/integrations?hubspot=invalid_state");
    expect((await connect(o.members.ADMIN, { callbackAs: o.members.OWNER })).headers.get("location")).toBe("/settings/integrations?hubspot=connect_failed");
    expect((await connect(o.members.ADMIN, { callbackAs: o.members.MEMBER })).headers.get("location")).toBe("/settings/integrations?hubspot=forbidden");
    expect(await orgRow(o.organizationId)).toBeNull();
  });

  it("a callback cannot be replayed into another organization", async () => {
    const a = await createOrgFixture("hsreplaya");
    const b = await createOrgFixture("hsreplayb");
    const res = await connect(a.members.ADMIN, { callbackAs: b.members.ADMIN });
    expect(res.headers.get("location")).toBe("/settings/integrations?hubspot=connect_failed");
    expect(await orgRow(a.organizationId)).toBeNull();
    expect(await orgRow(b.organizationId)).toBeNull();
  });

  it("reconnecting to a different portal wipes the previous portal's CRM data", async () => {
    const o = await createOrgFixture("hsportal");
    await connect(o.members.ADMIN, { hubId: "1001" });
    const row = (await orgRow(o.organizationId))!;
    await ownerDb().crmDeal.create({ data: { organizationId: o.organizationId, integrationId: row.id, externalId: "x1", name: "Old portal deal" } });
    await connect(o.members.ADMIN, { hubId: "1002" });
    expect(await ownerDb().crmDeal.count({ where: { integrationId: row.id } })).toBe(0);
    expect((await orgRow(o.organizationId))!.externalAccountId).toBe("1002");
  });
});

describe("tokens", () => {
  it("refreshes an expired 30-minute access token and stores it encrypted", async () => {
    const o = await createOrgFixture("hsrefresh");
    const { integrationId, tokens } = await connectHubSpotFixture(hubspot, o.members.ADMIN, "2001", { expiresInSeconds: 1 });
    await ownerDb().integration.update({ where: { id: integrationId }, data: { tokenExpiresAt: new Date(0) } });
    await syncHubSpot(o.members.ADMIN, { trigger: "manual" });
    const creds = (await loadIntegrationCredentials(o.members.ADMIN, integrationId)) as { accessToken: string; refreshToken: string };
    expect(creds.accessToken).not.toBe(tokens.accessToken);
    expect(creds.refreshToken).toBe(tokens.refreshToken);
    expect(hubspot.requests).toContain("POST /oauth/v3/token");
  });

  it("a revoked grant (app uninstalled) → REAUTH_REQUIRED, audited once", async () => {
    const o = await createOrgFixture("hsrevoked");
    const { integrationId } = await connectHubSpotFixture(hubspot, o.members.ADMIN, "2002");
    hubspot.revokeAll();
    await expect(syncHubSpot(o.members.ADMIN, { trigger: "manual" })).rejects.toMatchObject({ code: "policy_violation" });
    const row = await ownerDb().integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(row.status).toBe("REAUTH_REQUIRED");
    expect(row.syncLeaseExpiresAt).toBeNull();
    expect(await ownerDb().auditLog.count({ where: { organizationId: o.organizationId, event: "hubspot.reauth_required" } })).toBe(1);
    await expect(syncHubSpot(o.members.ADMIN, { trigger: "manual" })).rejects.toMatchObject({ code: "policy_violation" });
  });
});

describe("disconnect", () => {
  it("ADMIN only; wipes credentials and the CRM mirror; sends nothing to HubSpot", async () => {
    const o = await createOrgFixture("hsdisc");
    const { integrationId } = await connectHubSpotFixture(hubspot, o.members.ADMIN, "3001");
    await ownerDb().crmDeal.create({ data: { organizationId: o.organizationId, integrationId, externalId: "d1", name: "Deal" } });
    expect((await hubspotDisconnect(req("/api/integrations/hubspot", o.members.MEMBER, { method: "DELETE" }))).status).toBe(403);
    const before = hubspot.requests.length;
    expect((await hubspotDisconnect(req("/api/integrations/hubspot", o.members.ADMIN, { method: "DELETE" }))).status).toBe(200);
    expect(hubspot.requests.length).toBe(before);
    const row = await ownerDb().integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(row).toMatchObject({ status: "DISCONNECTED", encryptedCredentials: null, syncCursor: null });
    expect(await ownerDb().crmDeal.count({ where: { integrationId } })).toBe(0);
  });
});
