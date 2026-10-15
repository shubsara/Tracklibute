import "server-only";

import { ServiceUnavailableError, UnauthenticatedError } from "@/lib/errors";
import { log } from "@/lib/log";
import { getAppDb } from "@/server/db/client";

import { completeAuthorization, getGoogleSettings, startAuthorization } from "./google-oidc";
import type { OAuthTransaction } from "./oauth-state";
import { createSession } from "./session-store";

export const SIGN_IN_SCOPE = "openid email profile";

function loginRedirectUri(): string {
  const uri = getGoogleSettings().loginRedirectUri;
  if (!uri) throw new ServiceUnavailableError("GOOGLE_REDIRECT_URI is not configured");
  return uri;
}

/** Step 1: build the Google sign-in redirect + the transaction to persist in a signed cookie. */
export async function beginGoogleSignIn(): Promise<{ url: URL; transaction: Omit<OAuthTransaction, "exp"> }> {
  const start = await startAuthorization({
    redirectUri: loginRedirectUri(),
    scope: SIGN_IN_SCOPE,
    extraParams: { prompt: "select_account" },
  });
  return {
    url: start.url,
    transaction: { purpose: "login", state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier },
  };
}

/**
 * Step 2: verify the callback, upsert the user by Google `sub`, and create an
 * opaque session. Sign-in NEVER connects Gmail — that is a separate consent.
 */
export async function completeGoogleSignIn(
  requestUrl: string,
  transaction: OAuthTransaction,
): Promise<{ sessionToken: string; userId: string; hasOrganization: boolean }> {
  const { claims } = await completeAuthorization({
    requestUrl,
    redirectUri: loginRedirectUri(),
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    codeVerifier: transaction.codeVerifier,
  });
  if (!claims.email || !claims.email_verified) {
    throw new UnauthenticatedError("Google account email is missing or unverified");
  }

  const rows = await getAppDb().$queryRaw<{ id: string }[]>`
    SELECT auth_upsert_google_user(${claims.sub}, ${claims.email}, ${claims.name ?? null})::text AS id`;
  const userId = rows[0]?.id;
  if (!userId) throw new UnauthenticatedError("Could not resolve user");

  const session = await createSession(userId);
  log.info("auth.sign_in", { userId, hasOrganization: session.organizationId !== null });
  return { sessionToken: session.token, userId, hasOrganization: session.organizationId !== null };
}
