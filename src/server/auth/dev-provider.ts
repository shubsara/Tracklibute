import "server-only";

import { getEnv } from "@/lib/env";

import { readBearer, readCookie } from "./cookies";
import type { AuthProvider, SessionIdentity } from "./provider";
import { verifySessionToken } from "./session-token";

export const DEV_SESSION_COOKIE = "tl_dev_session";

/** Signed dev tokens always contain a "." (payload.signature). */
export function readDevToken(headers: Headers): string | null {
  const bearer = readBearer(headers);
  if (bearer?.includes(".")) return bearer;
  return readCookie(headers, DEV_SESSION_COOKIE);
}

/**
 * Dev auth is available only when BOTH hold:
 *   NODE_ENV !== "production"  AND  DEV_AUTH_ENABLED === "true".
 * A production deployment cannot enable it through configuration.
 */
export function isDevAuthAllowed(): boolean {
  const env = getEnv();
  return env.DEV_AUTH_ENABLED && env.NODE_ENV !== "production" && process.env.NODE_ENV !== "production";
}

export const devAuthProvider: AuthProvider = {
  name: "dev",
  async authenticate(headers: Headers): Promise<SessionIdentity | null> {
    if (!isDevAuthAllowed()) return null;
    const token = readDevToken(headers);
    if (!token) return null;
    const claims = verifySessionToken(token, getEnv().SESSION_SECRET);
    if (!claims) return null;
    return { provider: "dev", userId: claims.sub, organizationId: claims.org };
  },
};
