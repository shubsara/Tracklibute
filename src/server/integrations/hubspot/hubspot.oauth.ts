import "server-only";

import { randomBytes } from "node:crypto";

import { CrmAuthorizationRevokedError } from "@/domain/crm/types";
import type { DecryptedCredentials } from "@/domain/integrations/adapter";
import { getEnv } from "@/lib/env";
import { ServiceUnavailableError, UpstreamServiceError, ValidationError } from "@/lib/errors";

import { HUBSPOT_API_BASE_URL, hubspotFetch, readReason } from "./hubspot.client";
import { hubspotTokenInfoSchema, hubspotTokenSchema } from "./hubspot.types";

/**
 * HubSpot OAuth 2.0 (authorization code). Not OIDC: there is no id_token or
 * nonce. CSRF protection is the HMAC-signed, user+org-bound state cookie.
 *
 * READ-ONLY scopes only. A grant that carries any write scope is refused.
 */
export const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
export const HUBSPOT_REQUIRED_SCOPES = [
  "oauth",
  "crm.objects.deals.read",
  "crm.objects.contacts.read",
  "crm.objects.companies.read",
  "crm.objects.owners.read",
] as const;
const EXPIRY_SKEW_MS = 5 * 60_000;

export interface HubSpotCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  hubId: string;
}

export interface HubSpotSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiBaseUrl: string;
  authorizeUrl: string;
}

export function getHubSpotSettings(): HubSpotSettings {
  const env = getEnv();
  if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET || !env.HUBSPOT_REDIRECT_URI) {
    throw new ServiceUnavailableError("HubSpot is not configured (HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET / HUBSPOT_REDIRECT_URI)");
  }
  const test = env.NODE_ENV === "test";
  return {
    clientId: env.HUBSPOT_CLIENT_ID,
    clientSecret: env.HUBSPOT_CLIENT_SECRET,
    redirectUri: env.HUBSPOT_REDIRECT_URI,
    apiBaseUrl: test && env.HUBSPOT_API_BASE_URL ? env.HUBSPOT_API_BASE_URL : HUBSPOT_API_BASE_URL,
    authorizeUrl: test && env.HUBSPOT_AUTH_BASE_URL ? `${env.HUBSPOT_AUTH_BASE_URL}/oauth/authorize` : HUBSPOT_AUTHORIZE_URL,
  };
}

export function hubspotApiBaseUrl(): string {
  const env = getEnv();
  return env.NODE_ENV === "test" && env.HUBSPOT_API_BASE_URL ? env.HUBSPOT_API_BASE_URL : HUBSPOT_API_BASE_URL;
}

/** A scope that grants anything beyond reading. */
export function isWriteScope(scope: string): boolean {
  return /(^|[.-])(write|delete|create|update)($|[.-])/i.test(scope);
}

export function parseHubSpotCredentials(raw: DecryptedCredentials): HubSpotCredentials {
  const { accessToken, refreshToken, expiresAt, hubId } = raw as Partial<HubSpotCredentials>;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number" || typeof hubId !== "string") {
    throw new CrmAuthorizationRevokedError();
  }
  return { accessToken, refreshToken, expiresAt, hubId };
}

export function hubspotNeedsRefresh(creds: HubSpotCredentials, now = Date.now()): boolean {
  return creds.expiresAt - EXPIRY_SKEW_MS <= now;
}

export function beginHubSpotAuthorization(): { url: string; state: string } {
  const s = getHubSpotSettings();
  const state = randomBytes(32).toString("base64url");
  const url = new URL(s.authorizeUrl);
  url.searchParams.set("client_id", s.clientId);
  url.searchParams.set("redirect_uri", s.redirectUri);
  url.searchParams.set("scope", HUBSPOT_REQUIRED_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

async function tokenRequest(fetchImpl: typeof fetch, form: Record<string, string>) {
  const s = getHubSpotSettings();
  const res = await hubspotFetch(fetchImpl, s.apiBaseUrl, "oauth.token", "POST", "/oauth/v3/token", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, ...form }).toString(),
  });
  if (!res.ok) return { ok: false as const, status: res.status, reason: await readReason(res) };
  const parsed = hubspotTokenSchema.safeParse(await res.json());
  if (!parsed.success) throw new UpstreamServiceError("HubSpot returned an unexpected token response");
  return { ok: true as const, tokens: parsed.data };
}

/** Token metadata: which portal (hub) this is and which scopes were granted. */
export async function getHubSpotTokenInfo(accessToken: string, fetchImpl: typeof fetch = fetch) {
  if (!/^[A-Za-z0-9._~-]+$/.test(accessToken)) throw new UpstreamServiceError("HubSpot returned a malformed access token");
  const res = await hubspotFetch(fetchImpl, hubspotApiBaseUrl(), "oauth.tokenInfo", "GET", `/oauth/v1/access-tokens/${accessToken}`);
  if (!res.ok) throw new UpstreamServiceError(`HubSpot token lookup failed (HTTP ${res.status})`);
  const parsed = hubspotTokenInfoSchema.safeParse(await res.json());
  if (!parsed.success) throw new UpstreamServiceError("HubSpot returned unexpected token metadata");
  return parsed.data;
}

export async function exchangeHubSpotCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ credentials: HubSpotCredentials; scopes: string[] }> {
  if (!code || code.length > 2048) throw new ValidationError("Missing HubSpot authorization code");
  const r = await tokenRequest(fetchImpl, { grant_type: "authorization_code", code, redirect_uri: getHubSpotSettings().redirectUri });
  if (!r.ok) {
    throw r.status >= 500
      ? new UpstreamServiceError("HubSpot is temporarily unavailable; try again")
      : new ValidationError("HubSpot rejected the authorization. Please try connecting again.");
  }
  if (!r.tokens.refresh_token) throw new UpstreamServiceError("HubSpot did not return a refresh token");
  const info = await getHubSpotTokenInfo(r.tokens.access_token, fetchImpl);
  const missing = HUBSPOT_REQUIRED_SCOPES.filter((s) => !info.scopes.includes(s));
  if (missing.length) {
    throw new ValidationError(`HubSpot did not grant required read access (${missing.join(", ")}).`);
  }
  if (info.scopes.some(isWriteScope)) {
    throw new ValidationError("The HubSpot app requests write permissions; Tracklibute connects read-only. Connection refused.");
  }
  return {
    scopes: [...info.scopes].sort(),
    credentials: {
      accessToken: r.tokens.access_token,
      refreshToken: r.tokens.refresh_token,
      expiresAt: Date.now() + r.tokens.expires_in * 1000,
      hubId: info.hub_id,
    },
  };
}

/** Refresh. 400/401 means the grant is gone (app uninstalled / revoked). */
export async function refreshHubSpotCredentials(creds: HubSpotCredentials, fetchImpl: typeof fetch = fetch): Promise<HubSpotCredentials> {
  let r: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    r = await tokenRequest(fetchImpl, { grant_type: "refresh_token", refresh_token: creds.refreshToken });
  } catch (err) {
    if (err instanceof UpstreamServiceError) throw err;
    throw new UpstreamServiceError("Could not refresh HubSpot access; will retry later");
  }
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) {
      throw new CrmAuthorizationRevokedError({ endpoint: "oauth.token", httpStatus: r.status, providerReason: r.reason });
    }
    throw new UpstreamServiceError("Could not refresh HubSpot access; will retry later");
  }
  return {
    accessToken: r.tokens.access_token,
    refreshToken: r.tokens.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + r.tokens.expires_in * 1000,
    hubId: creds.hubId,
  };
}
