import "server-only";

import { randomBytes } from "node:crypto";

import { CrmAuthorizationRevokedError } from "@/domain/crm/types";
import type { DecryptedCredentials } from "@/domain/integrations/adapter";
import { getEnv } from "@/lib/env";
import {
  PolicyViolationError,
  ServiceUnavailableError,
  UpstreamServiceError,
  ValidationError,
} from "@/lib/errors";

import { HUBSPOT_API_BASE_URL, hubspotFetch, readReason } from "./hubspot.client";
import { type HubSpotIntrospection, hubspotIntrospectionSchema, hubspotTokenSchema } from "./hubspot.types";

/**
 * HubSpot OAuth 2.0 (authorization code) on the date-versioned 2026-03 API:
 *
 *   POST /oauth/2026-03/token             authorization_code | refresh_token
 *   POST /oauth/2026-03/token/introspect  token metadata (replaces v1
 *                                         GET /oauth/v1/access-tokens/{token},
 *                                         deprecated; sunset Feb 16, 2027)
 *
 * Every credential (client secret, code, tokens) travels in a form-encoded
 * body — never in a URL — and none is ever logged or put in an error message.
 * Not OIDC: no id_token / nonce; CSRF protection is the HMAC-signed,
 * user+org-bound state cookie.
 *
 * READ-ONLY: a grant carrying any write scope is refused. Tracklibute also
 * requires an ACCOUNT-LEVEL app: HubSpot documents that user-level apps
 * support only a subset of APIs (no owners, no association bulk reads, no v3
 * object endpoints), which Tracklibute's sync needs.
 */
export const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
export const HUBSPOT_OAUTH_TOKEN_PATH = "/oauth/2026-03/token";
export const HUBSPOT_OAUTH_INTROSPECT_PATH = "/oauth/2026-03/token/introspect";
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

type OAuthCall<T> = { ok: true; data: T } | { ok: false; status: number; reason: string | null };

/**
 * One form-encoded POST to an OAuth endpoint. Transport failures become a
 * safe UpstreamServiceError; the body (which carries secrets) is never logged
 * or included in any error.
 */
async function oauthPost<T>(
  fetchImpl: typeof fetch,
  endpoint: "oauth.token" | "oauth.introspect",
  path: string,
  form: Record<string, string>,
  parse: (v: unknown) => { success: true; data: T } | { success: false },
): Promise<OAuthCall<T>> {
  const s = getHubSpotSettings();
  let res: Response;
  try {
    res = await hubspotFetch(fetchImpl, s.apiBaseUrl, endpoint, "POST", path, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, ...form }).toString(),
    });
  } catch {
    throw new UpstreamServiceError("Could not reach HubSpot; try again later");
  }
  if (!res.ok) return { ok: false, status: res.status, reason: await readReason(res) };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UpstreamServiceError("HubSpot returned an unreadable OAuth response");
  }
  const parsed = parse(body);
  if (!parsed.success) throw new UpstreamServiceError("HubSpot returned an unexpected OAuth response");
  return { ok: true, data: parsed.data };
}

/** The app's credentials themselves were rejected: reconnecting cannot help; an operator must fix config. */
const CLIENT_ERRORS = new Set(["invalid_client", "unauthorized_client", "BAD_CLIENT_ID", "BAD_CLIENT_SECRET"]);

/**
 * Introspect an access token (POST /oauth/2026-03/token/introspect) and
 * validate everything Tracklibute depends on: active, an access token, issued
 * to THIS app, for a portal, account-level, with read-only scopes.
 */
export async function introspectHubSpotAccessToken(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ hubId: string; scopes: string[] }> {
  const r = await oauthPost(fetchImpl, "oauth.introspect", HUBSPOT_OAUTH_INTROSPECT_PATH, { token_type_hint: "access_token", token: accessToken }, (v) =>
    hubspotIntrospectionSchema.safeParse(v),
  );
  if (!r.ok) {
    if (r.reason && CLIENT_ERRORS.has(r.reason)) throw new ServiceUnavailableError("HubSpot rejected Tracklibute's app credentials");
    throw new UpstreamServiceError(`HubSpot token introspection failed (HTTP ${r.status})`);
  }
  return validateIntrospection(r.data);
}

export function validateIntrospection(info: HubSpotIntrospection): { hubId: string; scopes: string[] } {
  if (!info.active) throw new CrmAuthorizationRevokedError({ endpoint: "oauth.introspect", providerReason: "inactive" });
  if (info.token_use !== undefined && info.token_use !== "access_token") {
    throw new UpstreamServiceError("HubSpot introspection described an unexpected token type");
  }
  if (info.client_id !== undefined && info.client_id !== getHubSpotSettings().clientId) {
    throw new PolicyViolationError("This HubSpot token was issued to a different app. Check HUBSPOT_CLIENT_ID.");
  }
  if (info.signed_access_token?.isUserLevel === true) {
    throw new PolicyViolationError(
      "This HubSpot app uses user-level access. Tracklibute needs an account-level app (owners, association reads and CRM search are not available to user-level apps).",
    );
  }
  if (!info.hub_id || !/^\d{1,20}$/.test(info.hub_id)) throw new UpstreamServiceError("HubSpot introspection did not return a portal id");
  const scopes = [...new Set(info.scopes ?? [])].sort();
  const missing = HUBSPOT_REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) throw new ValidationError(`HubSpot did not grant required read access (${missing.join(", ")}).`);
  if (scopes.some(isWriteScope)) {
    throw new ValidationError("The HubSpot app requests write permissions; Tracklibute connects read-only. Connection refused.");
  }
  return { hubId: info.hub_id, scopes };
}

export async function exchangeHubSpotCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ credentials: HubSpotCredentials; scopes: string[] }> {
  if (!code || code.length > 2048) throw new ValidationError("Missing HubSpot authorization code");
  const r = await oauthPost(
    fetchImpl,
    "oauth.token",
    HUBSPOT_OAUTH_TOKEN_PATH,
    { grant_type: "authorization_code", code, redirect_uri: getHubSpotSettings().redirectUri },
    (v) => hubspotTokenSchema.safeParse(v),
  );
  if (!r.ok) {
    if (r.reason && CLIENT_ERRORS.has(r.reason)) throw new ServiceUnavailableError("HubSpot rejected Tracklibute's app credentials");
    throw r.status >= 500
      ? new UpstreamServiceError("HubSpot is temporarily unavailable; try again")
      : new ValidationError("HubSpot rejected the authorization. Please try connecting again.");
  }
  const tokens = r.data;
  if (!tokens.refresh_token) throw new UpstreamServiceError("HubSpot did not return a refresh token");
  if (tokens.scopes?.some(isWriteScope)) {
    throw new ValidationError("The HubSpot app requests write permissions; Tracklibute connects read-only. Connection refused.");
  }
  const info = await introspectHubSpotAccessToken(tokens.access_token, fetchImpl);
  if (tokens.hub_id !== undefined && tokens.hub_id !== info.hubId) {
    throw new UpstreamServiceError("HubSpot returned inconsistent portal ids");
  }
  return {
    scopes: info.scopes,
    credentials: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      hubId: info.hubId,
    },
  };
}

/**
 * Refresh (POST /oauth/2026-03/token, grant_type=refresh_token).
 * 400/401 means the grant is gone (app uninstalled / revoked) → reconnect,
 * except when HubSpot rejects the app's own client credentials (a
 * configuration fault reconnecting cannot fix).
 */
export async function refreshHubSpotCredentials(creds: HubSpotCredentials, fetchImpl: typeof fetch = fetch): Promise<HubSpotCredentials> {
  const r = await oauthPost(fetchImpl, "oauth.token", HUBSPOT_OAUTH_TOKEN_PATH, { grant_type: "refresh_token", refresh_token: creds.refreshToken }, (v) =>
    hubspotTokenSchema.safeParse(v),
  );
  if (!r.ok) {
    if (r.reason && CLIENT_ERRORS.has(r.reason)) throw new ServiceUnavailableError("HubSpot rejected Tracklibute's app credentials");
    if (r.status === 400 || r.status === 401) {
      throw new CrmAuthorizationRevokedError({ endpoint: "oauth.token", httpStatus: r.status, providerReason: r.reason });
    }
    throw new UpstreamServiceError("Could not refresh HubSpot access; will retry later");
  }
  if (r.data.hub_id !== undefined && r.data.hub_id !== creds.hubId) {
    // A refresh must never silently switch portals.
    throw new CrmAuthorizationRevokedError({ endpoint: "oauth.token", providerReason: "portal_mismatch" });
  }
  return {
    accessToken: r.data.access_token,
    refreshToken: r.data.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + r.data.expires_in * 1000,
    hubId: creds.hubId,
  };
}
