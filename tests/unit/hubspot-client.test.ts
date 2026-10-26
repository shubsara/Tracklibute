import { describe, expect, it } from "vitest";

import { QuotaPacer } from "@/server/integrations/pacing";
import {
  assertAllowedHubSpotRequest,
  HUBSPOT_ALLOWED_REQUESTS,
  HubSpotApiError,
  HubSpotClient,
  HubSpotRequestNotAllowedError,
} from "@/server/integrations/hubspot/hubspot.client";
import { mapCompany, mapContact, mapDeal, mapStages, parseHubSpotDate } from "@/server/integrations/hubspot/hubspot.mapper";
import { isWriteScope } from "@/server/integrations/hubspot/hubspot.oauth";

import { VirtualClock } from "../support/fake-google";

const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
const err = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

function client(responses: Response[], opts: { clock?: VirtualClock } = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(url) });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return r;
  }) as unknown as typeof fetch;
  let refreshed = 0;
  const c = new HubSpotClient({
    baseUrl: "http://hubspot.test",
    fetchImpl,
    clock: opts.clock ?? new VirtualClock(),
    getAccessToken: async (force) => {
      if (force) refreshed++;
      return "token";
    },
  });
  return { c, calls, refreshed: () => refreshed };
}

describe("read-only allow-list", () => {
  it("only GETs and read-only query POSTs exist; no PATCH/PUT/DELETE, no object create/update/archive", () => {
    for (const r of HUBSPOT_ALLOWED_REQUESTS) {
      expect(["GET", "POST"]).toContain(r.method);
      if (r.method === "POST") expect(r.path.source).toMatch(/oauth\\\/2026-03\\\/token|search|batch\\\/read/);
    }
    const refused: Array<[string, string]> = [
      ["POST", "/crm/v3/objects/tasks"],
      ["POST", "/crm/v3/objects/deals"],
      ["PATCH", "/crm/v3/objects/deals/123"],
      ["PUT", "/crm/v4/objects/deals/1/associations/contacts/2"],
      ["DELETE", "/crm/v3/objects/deals/123"],
      ["POST", "/crm/v3/objects/deals/batch/update"],
      ["POST", "/crm/v3/objects/deals/batch/create"],
      ["POST", "/crm/v3/objects/notes"],
      ["POST", "/engagements/v1/engagements"],
      ["DELETE", "/oauth/v1/refresh-tokens/x"],
      // Deprecated / superseded endpoints are no longer reachable at all.
      ["GET", "/oauth/v1/access-tokens/some-token"],
      ["POST", "/oauth/v1/token"],
      ["POST", "/oauth/v3/token"],
      ["POST", "/oauth/2026-03/token/revoke"],
      ["GET", "/crm/v3/pipelines/deals"],
      ["GET", "/crm-pipelines/v1/pipelines/deals"],
      ["POST", "/crm/pipelines/2026-09/deals"],
      ["PATCH", "/crm/pipelines/2026-09/deals/default"],
      ["DELETE", "/crm/pipelines/2026-09/deals/default/stages/s1"],
      ["GET", "/crm/pipelines/2026-09/tickets"],
      ["GET", "/crm/v3/objects/deals/../tasks"],
    ];
    for (const [m, p] of refused) expect(() => assertAllowedHubSpotRequest(m, p)).toThrow(HubSpotRequestNotAllowedError);
  });

  it("allows only the explicit read-only contacts list endpoint for standalone lead discovery", () => {
    expect(assertAllowedHubSpotRequest("GET", "/crm/v3/objects/contacts")).toBe("contacts.list");
    expect(() => assertAllowedHubSpotRequest("POST", "/crm/v3/objects/contacts")).toThrow(HubSpotRequestNotAllowedError);
  });

  it("refuses before any network call", async () => {
    const { c, calls } = client([]);
    await expect(c.query("deals.search", "/crm/v3/objects/deals/batch/update", {})).rejects.toBeInstanceOf(HubSpotRequestNotAllowedError);
    await expect(c.get("deals.list", "/crm/v3/objects/tasks")).rejects.toBeInstanceOf(HubSpotRequestNotAllowedError);
    expect(calls).toEqual([]);
  });

  it("write scopes are recognised", () => {
    expect(isWriteScope("crm.objects.deals.write")).toBe(true);
    expect(isWriteScope("crm.objects.contacts.read")).toBe(false);
    expect(isWriteScope("oauth")).toBe(false);
  });
});

describe("HubSpotClient error handling", () => {
  it("429 honours Retry-After then succeeds", async () => {
    const clock = new VirtualClock();
    const { c } = client([err(429, { policyName: "TEN_SECONDLY_ROLLING" }, { "retry-after": "2" }), ok({ results: [] })], { clock });
    await expect(c.get("owners.list", "/crm/v3/owners")).resolves.toEqual({ results: [] });
    expect(clock.sleeps).toContain(2000);
  });

  it("DAILY 429 stops immediately (no retries)", async () => {
    const { c, calls } = client([err(429, { policyName: "DAILY" })]);
    await expect(c.get("owners.list", "/crm/v3/owners")).rejects.toMatchObject({ kind: "daily_limit" });
    expect(calls).toHaveLength(1);
  });

  it("a nearly spent daily allowance stops the run", async () => {
    const { c } = client([ok({ results: [] }, { "x-hubspot-ratelimit-daily": "250000", "x-hubspot-ratelimit-daily-remaining": "100" })]);
    await expect(c.get("owners.list", "/crm/v3/owners")).rejects.toMatchObject({ kind: "daily_limit" });
  });

  it("401 forces exactly one token refresh", async () => {
    const { c, refreshed } = client([err(401, { category: "EXPIRED_AUTHENTICATION" }), ok({ results: [] })]);
    await c.get("owners.list", "/crm/v3/owners");
    expect(refreshed()).toBe(1);
    const second = client([err(401, {}), err(401, {})]);
    await expect(second.c.get("owners.list", "/crm/v3/owners")).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("403 MISSING_SCOPES is insufficient_scope; other 403s are forbidden; 5xx retried", async () => {
    await expect(client([err(403, { category: "MISSING_SCOPES" })]).c.get("owners.list", "/crm/v3/owners")).rejects.toMatchObject({ kind: "insufficient_scope" });
    await expect(client([err(403, { category: "OTHER" })]).c.get("owners.list", "/crm/v3/owners")).rejects.toMatchObject({ kind: "forbidden" });
    await expect(client([err(502, {}), ok({ results: [] })]).c.get("owners.list", "/crm/v3/owners")).resolves.toEqual({ results: [] });
  });

  it("errors never carry response bodies", async () => {
    try {
      await client([err(400, { status: "error", message: "deal 'Secret Project' invalid" })]).c.get("owners.list", "/crm/v3/owners");
    } catch (e) {
      expect(e).toBeInstanceOf(HubSpotApiError);
      expect(String((e as Error).message)).not.toContain("Secret Project");
    }
  });

  it("pacer spaces requests (9 per second ≈ 90 / 10 s)", async () => {
    const clock = new VirtualClock();
    const pacer = new QuotaPacer(9, clock);
    const start = clock.now();
    for (let i = 0; i < 10; i++) await pacer.acquire(1);
    expect(clock.now() - start).toBeGreaterThanOrEqual(999);
  });
});

describe("mapper", () => {
  it("maps deals defensively (dates, amounts, ids, names)", () => {
    const d = mapDeal({
      id: "77",
      properties: {
        dealname: "  Acme\u0000 renewal ",
        amount: "12000.5",
        closedate: "2026-11-01T00:00:00.000Z",
        notes_next_activity_date: "1793836800000",
        hubspot_owner_id: "501",
        pipeline: "default",
        dealstage: "qualified",
        hs_is_closed: "false",
      },
      associations: { contacts: { results: [{ id: "1" }, { id: "1" }] } },
    });
    expect(d).toMatchObject({ externalId: "77", name: "Acme  renewal", amount: "12000.50", ownerExternalId: "501", isClosed: false, contactIds: ["1"], companyIds: [] });
    expect(d.closeDate?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(d.nextActivityAt).toBeInstanceOf(Date);
    expect(parseHubSpotDate("garbage")).toBeNull();
    expect(mapCompany({ id: "9", properties: { domain: "https://www.Buyer.io" } }).domain).toBe("buyer.io");
  });

  it("maps qualification and sales activity timestamps from HubSpot contacts", () => {
    const contact = mapContact({
      id: "902",
      properties: {
        email: "  QUALIFIED@Buyer.IO ",
        firstname: "Qualified",
        lastname: "Contact",
        lifecyclestage: "salesqualifiedlead",
        hs_lead_status: "IN_PROGRESS",
        hubspot_owner_id: "507",
        createdate: "2026-10-01T00:00:00.000Z",
        lastmodifieddate: "2026-10-20T00:00:00.000Z",
        notes_last_updated: "2026-10-19T00:00:00.000Z",
        notes_last_contacted: "2026-10-18T00:00:00.000Z",
        notes_next_activity_date: "2026-10-30T00:00:00.000Z",
        hs_v2_date_entered_salesqualifiedlead: "2026-10-10T00:00:00.000Z",
        hs_v2_date_entered_marketingqualifiedlead: null,
      },
    });
    expect(contact).toMatchObject({
      externalId: "902", email: "qualified@buyer.io", lifecycleStage: "salesqualifiedlead",
      leadStatus: "in_progress", ownerExternalId: "507",
    });
    expect(contact.dateEnteredSalesQualifiedLead?.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(contact.crmLastActivityAt?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(contact.nextActivityAt?.toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });

  it("stages (2026-09 shape): missing or unusable isClosed stays UNKNOWN, never defaulted", () => {
    const s = mapStages({
      results: [
        {
          id: "p",
          label: "P",
          archived: true,
          stages: [
            { id: "a", label: "No flag", metadata: { probability: "0.5" } },
            { id: "b", label: "Null meta", metadata: null },
            { id: "c", label: "Weird", metadata: { isClosed: "maybe" } },
            { id: "d", label: "Bool", metadata: { isClosed: true, probability: 0 } },
          ],
        },
      ],
    });
    expect(s.map((x) => [x.externalId, x.isClosed, x.isWon])).toEqual([["a", null, null], ["b", null, null], ["c", null, null], ["d", true, false]]);
  });

  it("stages: closed + probability 1 = won", () => {
    const s = mapStages({ results: [{ id: "p", label: "P", stages: [{ id: "w", label: "Won", metadata: { isClosed: "true", probability: "1.0" } }, { id: "o", label: "Open", metadata: { isClosed: "false", probability: "0.2" } }] }] });
    expect(s.map((x) => [x.externalId, x.isClosed, x.isWon])).toEqual([["w", true, true], ["o", false, null]]);
  });
});
