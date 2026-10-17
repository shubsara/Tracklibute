import "server-only";

import type { AuthContext } from "@/domain/auth/auth-context";
import {
  CrmAuthorizationRevokedError,
  type CrmCompanyRecord,
  type CrmContactRecord,
  type CrmDealRecord,
  CrmError,
  type CrmPage,
  type CrmSource,
  type CrmStageRecord,
} from "@/domain/crm/types";
import type {
  AuthorizationStart,
  ConnectionHealth,
  ConnectionResult,
  DecryptedCredentials,
  IntegrationAdapter,
} from "@/domain/integrations/adapter";
import { getEnv } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { loadIntegrationCredentials, storeIntegrationCredentials } from "@/server/integrations/integrations.service";

import { type Clock, QuotaPacer, realClock } from "../pacing";
import { HubSpotApiError, HubSpotClient } from "./hubspot.client";
import {
  COMPANY_PROPERTIES,
  CONTACT_PROPERTIES,
  DEAL_PROPERTIES,
  mapCompany,
  mapContact,
  mapDeal,
  mapOwner,
  mapStages,
} from "./hubspot.mapper";
import {
  beginHubSpotAuthorization,
  exchangeHubSpotCode,
  HUBSPOT_REQUIRED_SCOPES,
  hubspotApiBaseUrl,
  type HubSpotCredentials,
  hubspotNeedsRefresh,
  introspectHubSpotAccessToken,
  parseHubSpotCredentials,
  refreshHubSpotCredentials,
} from "./hubspot.oauth";
import {
  hubspotAssociationsSchema,
  hubspotBatchReadSchema,
  hubspotListSchema,
  hubspotOwnersSchema,
  hubspotPipelinesSchema,
  hubspotSearchSchema,
} from "./hubspot.types";
import { markHubSpotReauthRequired } from "./hubspot-reauth";

/** HubSpot Search caps any single query at 10,000 results. */
export const HUBSPOT_SEARCH_RESULT_CAP = 10_000;
export const SEARCH_PAGE_SIZE = 200;
export const LIST_PAGE_SIZE = 100;
export const BATCH_SIZE = 100;
/** Search API is limited separately (~4–5 / s); stay at 4. */
export const SEARCH_REQUESTS_PER_SECOND = 4;

/** Transport errors → provider-neutral CRM errors (non-secret diagnostics only). */
function toCrmError(err: unknown): unknown {
  if (err instanceof CrmError || !(err instanceof HubSpotApiError)) return err;
  const d = { endpoint: err.endpoint, httpStatus: err.status, providerReason: err.reason };
  switch (err.kind) {
    case "unauthorized":
    case "insufficient_scope":
      return new CrmAuthorizationRevokedError(d);
    case "forbidden":
      return new CrmError("HubSpot denied access to this resource", "forbidden", d);
    case "rate_limited":
      return new CrmError("HubSpot rate limit reached; retry later", "rate_limited", d);
    case "daily_limit":
      return new CrmError("HubSpot daily API allowance nearly spent; resuming later", "daily_limit", d);
    case "transient":
      return new CrmError("HubSpot is temporarily unavailable", "transient", d);
    default:
      return new CrmError(`HubSpot returned an unexpected response (HTTP ${err.status})`, "invalid_response", d);
  }
}

async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toCrmError(err);
  }
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown, endpoint: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError("HubSpot returned an unexpected response shape", "invalid_response", { endpoint });
  return r.data;
}

const chunks = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** CrmSource over the HubSpot CRM API. Read-only by construction. */
export class HubSpotCrmSource implements CrmSource {
  private readonly searchResultCap: number;

  constructor(
    private readonly client: HubSpotClient,
    opts: { searchResultCap?: number } = {},
  ) {
    this.searchResultCap = opts.searchResultCap ?? HUBSPOT_SEARCH_RESULT_CAP;
  }

  get requestCount(): number {
    return this.client.requestCount;
  }

  listOwners(after?: string) {
    return translate(async () => {
      const res = parse(hubspotOwnersSchema, await this.client.get("owners.list", "/crm/v3/owners", { limit: "100", after }), "owners.list");
      return { items: res.results.map(mapOwner), next: res.paging?.next?.after ?? null };
    });
  }

  listDealStages(): Promise<readonly CrmStageRecord[]> {
    return translate(async () =>
      mapStages(parse(hubspotPipelinesSchema, await this.client.get("pipelines.deals", "/crm/pipelines/2026-09/deals"), "pipelines.deals")),
    );
  }

  listDeals(after?: string): Promise<CrmPage<CrmDealRecord>> {
    return translate(async () => {
      const res = parse(
        hubspotListSchema,
        await this.client.get("deals.list", "/crm/v3/objects/deals", {
          limit: String(LIST_PAGE_SIZE),
          after,
          archived: "false",
          properties: DEAL_PROPERTIES.join(","),
          associations: "contacts,companies",
        }),
        "deals.list",
      );
      return { items: res.results.map(mapDeal), next: res.paging?.next?.after ?? null };
    });
  }

  searchDealsModifiedSince(since: number, after?: string) {
    return translate(async () => {
      const offset = Number(after ?? "0");
      const res = parse(
        hubspotSearchSchema,
        await this.client.query("deals.search", "/crm/v3/objects/deals/search", {
          filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(since) }] }],
          sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
          properties: [...DEAL_PROPERTIES],
          limit: SEARCH_PAGE_SIZE,
          ...(after ? { after } : {}),
        }),
        "deals.search",
      );
      const next = res.paging?.next?.after ?? null;
      // The result window ends at 10,000: the next offset would be refused.
      const capped = next !== null && Number(next) >= this.searchResultCap;
      return {
        items: res.results.map(mapDeal),
        next: capped ? null : next,
        capped: capped || (next === null && offset + res.results.length >= this.searchResultCap),
      };
    });
  }

  dealAssociations(dealIds: readonly string[], to: "contacts" | "companies") {
    return translate(async () => {
      const out = new Map<string, string[]>();
      for (const ids of chunks(dealIds, BATCH_SIZE)) {
        const res = parse(
          hubspotAssociationsSchema,
          await this.client.query("associations.batchRead", `/crm/v4/associations/deals/${to}/batch/read`, {
            inputs: ids.map((id) => ({ id })),
          }),
          "associations.batchRead",
        );
        for (const r of res.results) out.set(r.from.id, [...new Set(r.to.map((t) => t.toObjectId))]);
      }
      for (const id of dealIds) if (!out.has(id)) out.set(id, []);
      return out as ReadonlyMap<string, readonly string[]>;
    });
  }

  getContacts(ids: readonly string[]): Promise<readonly CrmContactRecord[]> {
    return this.batchRead("contacts", ids, CONTACT_PROPERTIES, mapContact);
  }

  getCompanies(ids: readonly string[]): Promise<readonly CrmCompanyRecord[]> {
    return this.batchRead("companies", ids, COMPANY_PROPERTIES, mapCompany);
  }

  private batchRead<T>(
    object: "contacts" | "companies",
    ids: readonly string[],
    properties: readonly string[],
    map: (o: Parameters<typeof mapContact>[0]) => T,
  ): Promise<T[]> {
    return translate(async () => {
      const out: T[] = [];
      for (const chunk of chunks([...new Set(ids)], BATCH_SIZE)) {
        const res = parse(
          hubspotBatchReadSchema,
          await this.client.query(`${object}.batchRead`, `/crm/v3/objects/${object}/batch/read`, {
            inputs: chunk.map((id) => ({ id })),
            properties: [...properties],
          }),
          `${object}.batchRead`,
        );
        out.push(...res.results.map(map));
      }
      return out;
    });
  }
}

/**
 * Access tokens for the org-wide HubSpot integration: loads from the vault,
 * refreshes near expiry (30-minute tokens), persists refreshed credentials
 * encrypted, and flags REAUTH_REQUIRED when HubSpot rejects the refresh token.
 */
export class HubSpotTokenProvider {
  private creds: HubSpotCredentials | undefined;

  constructor(
    private readonly auth: AuthContext,
    private readonly integrationId: string,
    private readonly actor: "USER" | "SYSTEM" = "USER",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAccessToken(forceRefresh: boolean): Promise<string> {
    this.creds ??= parseHubSpotCredentials(await loadIntegrationCredentials(this.auth, this.integrationId));
    if (!forceRefresh && !hubspotNeedsRefresh(this.creds)) return this.creds.accessToken;
    let next: HubSpotCredentials;
    try {
      next = await refreshHubSpotCredentials(this.creds, this.fetchImpl);
    } catch (err) {
      if (err instanceof CrmAuthorizationRevokedError) {
        await markHubSpotReauthRequired(this.auth, this.integrationId, { actor: this.actor });
      }
      throw err;
    }
    await storeIntegrationCredentials(this.auth, this.integrationId, { ...next }, { tokenExpiresAt: new Date(next.expiresAt), audit: false });
    this.creds = next;
    return next.accessToken;
  }
}

export interface HubSpotSourceOptions {
  actor?: "USER" | "SYSTEM";
  fetchImpl?: typeof fetch;
  clock?: Clock;
  requestsPer10s?: number;
  searchPerSecond?: number;
  /** Test hook: HubSpot's 10,000-result search window. */
  searchResultCap?: number;
}

/** One source = one sync run (its pacers are shared by every call in the run). */
export function createHubSpotCrmSource(auth: AuthContext, integrationId: string, opts: HubSpotSourceOptions = {}): HubSpotCrmSource {
  const clock = opts.clock ?? realClock;
  const tokens = new HubSpotTokenProvider(auth, integrationId, opts.actor, opts.fetchImpl);
  const client = new HubSpotClient({
    baseUrl: hubspotApiBaseUrl(),
    getAccessToken: (force) => tokens.getAccessToken(force),
    fetchImpl: opts.fetchImpl,
    clock,
    pacer: new QuotaPacer((opts.requestsPer10s ?? getEnv().HUBSPOT_REQUESTS_PER_10S) / 10, clock),
    searchPacer: new QuotaPacer(opts.searchPerSecond ?? SEARCH_REQUESTS_PER_SECOND, clock),
  });
  return new HubSpotCrmSource(client, { searchResultCap: opts.searchResultCap });
}

/** IntegrationAdapter for HubSpot: CRM READ only (no crm.write capability is offered). */
export class HubSpotIntegrationAdapter implements IntegrationAdapter {
  readonly provider = "HUBSPOT" as const;
  readonly capabilities = ["crm.read"] as const;
  readonly requiredScopes = HUBSPOT_REQUIRED_SCOPES;

  constructor(private readonly opts: { fetchImpl?: typeof fetch } = {}) {}

  async beginAuthorization(): Promise<AuthorizationStart> {
    const { url, state } = beginHubSpotAuthorization();
    // No PKCE / nonce for HubSpot; the transaction cookie still binds state to user + org.
    return { redirectUrl: url, state, nonce: "", codeVerifier: "" };
  }

  async completeAuthorization(input: { requestUrl: string; state: string }): Promise<ConnectionResult> {
    const params = new URL(input.requestUrl).searchParams;
    if (params.get("state") !== input.state) throw new ValidationError("HubSpot authorization state mismatch");
    const { credentials, scopes } = await exchangeHubSpotCode(params.get("code") ?? "", this.opts.fetchImpl);
    return {
      externalAccountId: credentials.hubId,
      scopes,
      credentials: { ...credentials },
      tokenExpiresAt: new Date(credentials.expiresAt),
    };
  }

  async checkConnection(raw: DecryptedCredentials): Promise<ConnectionHealth> {
    try {
      await introspectHubSpotAccessToken(parseHubSpotCredentials(raw).accessToken, this.opts.fetchImpl);
      return { ok: true };
    } catch {
      return { ok: false, detail: "error" };
    }
  }
}
