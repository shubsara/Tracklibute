import "server-only";

import { getEnv } from "@/lib/env";

import type { AuthProvider, SessionIdentity } from "./provider";
import { verifySessionToken } from "./session-token";

export const SESSION_COOKIE = "tl_session";

function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Reads a server-signed session token from `Authorization: Bearer` or the session cookie. */
export function readSessionToken(headers: Headers): string | null {
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) return authz.slice(7).trim() || null;
  return readCookie(headers, SESSION_COOKIE);
}

export function isDevAuthAllowed(): boolean {
  const env = getEnv();
  return env.DEV_AUTH_ENABLED && env.NODE_ENV !== "production";
}

/**
 * Development-only provider. Refuses to operate when NODE_ENV=production,
 * regardless of DEV_AUTH_ENABLED.
 */
export const devAuthProvider: AuthProvider = {
  name: "dev",
  async authenticate(headers: Headers): Promise<SessionIdentity | null> {
    if (!isDevAuthAllowed()) return null;
    const token = readSessionToken(headers);
    if (!token) return null;
    const claims = verifySessionToken(token, getEnv().AUTH_SESSION_SECRET);
    if (!claims) return null;
    return { userId: claims.sub, organizationId: claims.org };
  },
};
