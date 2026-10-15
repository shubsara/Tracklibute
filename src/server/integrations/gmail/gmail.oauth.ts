import "server-only";

import { MailboxAuthorizationRevokedError } from "@/domain/email/types";
import type { DecryptedCredentials } from "@/domain/integrations/adapter";
import { ServiceUnavailableError, UnauthenticatedError, UpstreamServiceError, ValidationError } from "@/lib/errors";
import {
  completeAuthorization,
  getGoogleSettings,
  isInvalidGrant,
  refreshAccessToken,
  revokeToken,
  startAuthorization,
} from "@/server/auth/google-oidc";

/**
 * Gmail connection OAuth — separate from sign-in and separately consented.
 * Read-only: Tracklibute never requests send / modify / compose here.
 */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_CONNECT_SCOPE = `openid email ${GMAIL_READONLY_SCOPE}`;
const FORBIDDEN_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.insert",
];
const EXPIRY_SKEW_MS = 60_000;

export interface GmailCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

export function gmailRedirectUri(): string {
  const uri = getGoogleSettings().gmailRedirectUri;
  if (!uri) throw new ServiceUnavailableError("GMAIL_REDIRECT_URI is not configured");
  return uri;
}

export function parseGmailCredentials(raw: DecryptedCredentials): GmailCredentials {
  const { accessToken, refreshToken, expiresAt, scope } = raw as Partial<GmailCredentials>;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number") {
    throw new MailboxAuthorizationRevokedError();
  }
  return { accessToken, refreshToken, expiresAt, scope: typeof scope === "string" ? scope : "" };
}

export function needsRefresh(creds: GmailCredentials, now = Date.now()): boolean {
  return creds.expiresAt - EXPIRY_SKEW_MS <= now;
}

export async function beginGmailAuthorization(loginHint?: string) {
  return startAuthorization({
    redirectUri: gmailRedirectUri(),
    scope: GMAIL_CONNECT_SCOPE,
    extraParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      ...(loginHint ? { login_hint: loginHint } : {}),
    },
  });
}

export async function exchangeGmailCode(input: {
  requestUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}): Promise<{ credentials: GmailCredentials; scopes: string[] }> {
  const { tokens } = await completeAuthorization({
    requestUrl: input.requestUrl,
    redirectUri: gmailRedirectUri(),
    expectedState: input.state,
    expectedNonce: input.nonce,
    codeVerifier: input.codeVerifier,
  });
  const scopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new ValidationError("Gmail read access was not granted. Please allow access and try again.");
  }
  if (scopes.some((s) => FORBIDDEN_SCOPES.includes(s))) {
    throw new ValidationError("Unexpected Gmail permissions were granted; connection refused.");
  }
  if (!tokens.refresh_token) {
    throw new UnauthenticatedError("Google did not grant offline access; please reconnect Gmail.");
  }
  return {
    scopes,
    credentials: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expiresIn() ?? 3600) * 1000,
      scope: tokens.scope ?? GMAIL_READONLY_SCOPE,
    },
  };
}

/** Refresh; Google normally omits a new refresh token, so the old one is kept. */
export async function refreshGmailCredentials(creds: GmailCredentials): Promise<GmailCredentials> {
  try {
    const tokens = await refreshAccessToken(creds.refreshToken);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? creds.refreshToken,
      expiresAt: Date.now() + (tokens.expiresIn() ?? 3600) * 1000,
      scope: tokens.scope ?? creds.scope,
    };
  } catch (err) {
    if (isInvalidGrant(err)) throw new MailboxAuthorizationRevokedError();
    throw new UpstreamServiceError("Could not refresh Gmail access; will retry later");
  }
}

/** Best-effort revocation at Google (disconnect). Never throws. */
export async function revokeGmailCredentials(creds: GmailCredentials): Promise<boolean> {
  try {
    await revokeToken(creds.refreshToken);
    return true;
  } catch {
    return false;
  }
}
