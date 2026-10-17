import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CrmAuthorizationRevokedError } from "@/domain/crm/types";
import { resetEnvCache } from "@/lib/env";
import { PolicyViolationError, UpstreamServiceError, ValidationError } from "@/lib/errors";
import { exchangeHubSpotCode, refreshHubSpotCredentials, validateIntrospection } from "@/server/integrations/hubspot/hubspot.oauth";

const CLIENT = "unit-client-id";
const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, {
    HUBSPOT_CLIENT_ID: CLIENT,
    HUBSPOT_CLIENT_SECRET: "unit-secret-value",
    HUBSPOT_REDIRECT_URI: "http://localhost/api/integrations/hubspot/callback",
    HUBSPOT_API_BASE_URL: "http://hubspot.test",
  });
  resetEnvCache();
});
afterAll(() => {
  process.env = saved;
  resetEnvCache();
});

const READ = ["oauth", "crm.objects.deals.read", "crm.objects.contacts.read", "crm.objects.companies.read", "crm.objects.owners.read"];
const good = {
  active: true,
  token_use: "access_token",
  client_id: CLIENT,
  hub_id: "1234567",
  scopes: [...READ].reverse(),
  signed_access_token: { isUserLevel: false },
};

describe("introspection validation (POST /oauth/2026-03/token/introspect)", () => {
  it("accepts an active, account-level, read-only access token for this app", () => {
    expect(validateIntrospection(good)).toEqual({ hubId: "1234567", scopes: [...READ].sort() });
  });

  it("rejects inactive (expired / revoked) tokens as revoked", () => {
    expect(() => validateIntrospection({ ...good, active: false })).toThrow(CrmAuthorizationRevokedError);
  });

  it("rejects a refresh-token description, a foreign client and user-level apps", () => {
    expect(() => validateIntrospection({ ...good, token_use: "refresh_token" })).toThrow(UpstreamServiceError);
    expect(() => validateIntrospection({ ...good, client_id: "someone-else" })).toThrow(PolicyViolationError);
    expect(() => validateIntrospection({ ...good, signed_access_token: { isUserLevel: true } })).toThrow(PolicyViolationError);
  });

  it("requires a numeric portal id, every read scope, and no write scope", () => {
    expect(() => validateIntrospection({ ...good, hub_id: undefined })).toThrow(UpstreamServiceError);
    expect(() => validateIntrospection({ ...good, hub_id: "abc" })).toThrow(UpstreamServiceError);
    expect(() => validateIntrospection({ ...good, scopes: ["oauth", "crm.objects.deals.read"] })).toThrow(ValidationError);
    expect(() => validateIntrospection({ ...good, scopes: [...READ, "crm.objects.deals.write"] })).toThrow(ValidationError);
  });
});

/** fetch stub that records requests and plays scripted responses. */
function stub(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string; body: string; contentType: string | null }> = [];
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? ""), contentType: new Headers(init?.headers).get("content-type") });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokenBody = { token_type: "bearer", access_token: "AT-secret", refresh_token: "RT-secret", expires_in: 1800, hub_id: 1234567, scopes: READ };
const introBody = { ...good, hub_id: 1234567, token: "AT-secret" };

describe("token exchange + introspection requests", () => {
  it("uses the 2026-03 endpoints with every secret in a form body, never the URL", async () => {
    const { fetchImpl, calls } = stub([json(200, tokenBody), json(200, introBody)]);
    const r = await exchangeHubSpotCode("CODE-secret", fetchImpl);
    expect(r.credentials).toMatchObject({ accessToken: "AT-secret", refreshToken: "RT-secret", hubId: "1234567" });
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["POST", "/oauth/2026-03/token"],
      ["POST", "/oauth/2026-03/token/introspect"],
    ]);
    for (const c of calls) {
      expect(c.contentType).toBe("application/x-www-form-urlencoded");
      expect(new URL(c.url).search).toBe("");
      expect(c.url).not.toMatch(/secret|CODE|AT-|RT-/);
    }
    expect(new URLSearchParams(calls[0]!.body).get("grant_type")).toBe("authorization_code");
    const intro = new URLSearchParams(calls[1]!.body);
    expect([intro.get("token_type_hint"), intro.get("token"), intro.get("client_id")]).toEqual(["access_token", "AT-secret", CLIENT]);
  });

  it("rejects malformed responses and inconsistent portal ids safely", async () => {
    await expect(exchangeHubSpotCode("c", stub([json(200, { nope: 1 })]).fetchImpl)).rejects.toThrow(UpstreamServiceError);
    await expect(exchangeHubSpotCode("c", stub([json(200, tokenBody), json(200, { hello: "world" })]).fetchImpl)).rejects.toThrow(UpstreamServiceError);
    await expect(exchangeHubSpotCode("c", stub([json(200, { ...tokenBody, hub_id: 9 }), json(200, introBody)]).fetchImpl)).rejects.toThrow(/inconsistent portal/);
    await expect(exchangeHubSpotCode("c", stub([new Response("<html>", { status: 200 })]).fetchImpl)).rejects.toThrow(UpstreamServiceError);
  });

  it("network failures become a safe upstream error that echoes no secret", async () => {
    const err = await exchangeHubSpotCode("CODE-secret", stub([new TypeError("fetch failed")]).fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamServiceError);
    expect(String((err as Error).message)).not.toMatch(/secret|CODE/);
    const err2 = await refreshHubSpotCredentials({ accessToken: "AT", refreshToken: "RT-secret", expiresAt: 0, hubId: "1" }, stub([new TypeError("fetch failed")]).fetchImpl).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(UpstreamServiceError);
  });

  it("refresh: invalid_grant → revoked; invalid_client → configuration error (not a reconnect); portal switch → revoked", async () => {
    const creds = { accessToken: "AT", refreshToken: "RT-secret", expiresAt: 0, hubId: "1234567" };
    const revoked = await refreshHubSpotCredentials(creds, stub([json(400, { error: "invalid_grant", error_description: "refresh token RT-secret is invalid", status: "BAD_REFRESH_TOKEN" })]).fetchImpl).catch((e: unknown) => e);
    expect(revoked).toBeInstanceOf(CrmAuthorizationRevokedError);
    expect((revoked as CrmAuthorizationRevokedError).diagnostics.providerReason).toBe("invalid_grant");
    expect(JSON.stringify(revoked)).not.toContain("RT-secret");
    await expect(refreshHubSpotCredentials(creds, stub([json(401, { error: "invalid_client", status: "BAD_CLIENT_ID" })]).fetchImpl)).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(refreshHubSpotCredentials(creds, stub([json(503, {})]).fetchImpl)).rejects.toThrow(UpstreamServiceError);
    await expect(refreshHubSpotCredentials(creds, stub([json(200, { ...tokenBody, hub_id: 42 })]).fetchImpl)).rejects.toThrow(CrmAuthorizationRevokedError);
    const ok = await refreshHubSpotCredentials(creds, stub([json(200, { ...tokenBody, refresh_token: undefined })]).fetchImpl);
    expect(ok).toMatchObject({ accessToken: "AT-secret", refreshToken: "RT-secret", hubId: "1234567" });
  });
});
