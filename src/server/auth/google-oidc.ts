import "server-only";

import * as oidc from "openid-client";

import { getEnv } from "@/lib/env";
import { ServiceUnavailableError, UnauthenticatedError } from "@/lib/errors";

/**
 * Google OpenID Connect via `openid-client` (certified RP library).
 * Used by two separate flows that share one OAuth client:
 *   - sign-in        (scope: openid email profile)
 *   - Gmail connect  (scope: openid email gmail.readonly, offline access)
 */
export const GOOGLE_ISSUER = "https://accounts.google.com";

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  loginRedirectUri: string | undefined;
  gmailRedirectUri: string | undefined;
  issuer: string;
}

export function getGoogleSettings(): GoogleSettings {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ServiceUnavailableError("Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)");
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    loginRedirectUri: env.GOOGLE_REDIRECT_URI,
    gmailRedirectUri: env.GMAIL_REDIRECT_URI,
    // Endpoint override exists for the test suite's fake Google server only.
    issuer: env.NODE_ENV === "test" && env.GOOGLE_ISSUER ? env.GOOGLE_ISSUER : GOOGLE_ISSUER,
  };
}

let cache: { key: string; config: Promise<oidc.Configuration> } | undefined;

export function getGoogleOidcConfig(): Promise<oidc.Configuration> {
  const s = getGoogleSettings();
  const key = `${s.issuer}|${s.clientId}`;
  if (!cache || cache.key !== key) {
    const insecure = getEnv().NODE_ENV === "test" && s.issuer.startsWith("http://");
    const config = oidc
      .discovery(new URL(s.issuer), s.clientId, s.clientSecret, undefined, {
        execute: insecure ? [oidc.allowInsecureRequests] : [],
        timeout: 10,
      })
      .catch((err: unknown) => {
        cache = undefined;
        throw err;
      });
    cache = { key, config };
  }
  return cache.config;
}

export function resetGoogleOidcCache(): void {
  cache = undefined;
}

export interface AuthorizationStart {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export async function startAuthorization(input: {
  redirectUri: string;
  scope: string;
  extraParams?: Record<string, string>;
}): Promise<AuthorizationStart> {
  const config = await getGoogleOidcConfig();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: input.redirectUri,
    scope: input.scope,
    response_type: "code",
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    nonce,
    ...input.extraParams,
  });
  return { url, state, nonce, codeVerifier };
}

export interface CodeExchangeResult {
  claims: { sub: string; email?: string; email_verified?: boolean; name?: string };
  tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
}

/**
 * Validates the callback (state, PKCE, ID token signature/iss/aud/nonce) and
 * exchanges the code. The callback URL is rebuilt from the configured
 * redirect URI so proxies/hosts cannot alter `redirect_uri`.
 */
export async function completeAuthorization(input: {
  requestUrl: string;
  redirectUri: string;
  expectedState: string;
  expectedNonce: string;
  codeVerifier: string;
}): Promise<CodeExchangeResult> {
  const config = await getGoogleOidcConfig();
  const callbackUrl = new URL(input.redirectUri);
  callbackUrl.search = new URL(input.requestUrl).search;

  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    expectedState: input.expectedState,
    expectedNonce: input.expectedNonce,
    pkceCodeVerifier: input.codeVerifier,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new UnauthenticatedError("Google did not return an identity");
  return {
    claims: {
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      email_verified: claims.email_verified === true,
      name: typeof claims.name === "string" ? claims.name : undefined,
    },
    tokens,
  };
}

export async function refreshAccessToken(refreshToken: string) {
  return oidc.refreshTokenGrant(await getGoogleOidcConfig(), refreshToken);
}

export async function revokeToken(token: string): Promise<void> {
  await oidc.tokenRevocation(await getGoogleOidcConfig(), token);
}

/** True when Google says the grant is no longer valid (revoked / expired refresh token). */
export function isInvalidGrant(err: unknown): boolean {
  return err instanceof oidc.ResponseBodyError && (err.error === "invalid_grant" || err.error === "unauthorized_client");
}

/** Narrow classification for logs — never includes provider messages that might echo input. */
export function classifyOAuthError(err: unknown): string {
  if (err instanceof oidc.ResponseBodyError) return `oauth_${err.error}`;
  if (err instanceof oidc.AuthorizationResponseError) return `authorization_${err.error}`;
  if (err instanceof oidc.ClientError) return `oauth_client_${err.code ?? "error"}`;
  return err instanceof Error ? err.name : "unknown";
}
