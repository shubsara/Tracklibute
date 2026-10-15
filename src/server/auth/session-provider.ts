import "server-only";

import { readBearer, readCookie } from "./cookies";
import type { AuthProvider, SessionIdentity } from "./provider";
import { looksLikeSessionToken, resolveSession, SESSION_COOKIE } from "./session-store";

/** Reads the opaque session token from the session cookie or a Bearer header. */
export function readOpaqueSessionToken(headers: Headers): string | null {
  const bearer = readBearer(headers);
  if (bearer && looksLikeSessionToken(bearer)) return bearer;
  const cookie = readCookie(headers, SESSION_COOKIE);
  return cookie && looksLikeSessionToken(cookie) ? cookie : null;
}

/** Production provider: database-backed sessions established by Google sign-in. */
export const sessionAuthProvider: AuthProvider = {
  name: "session",
  async authenticate(headers: Headers): Promise<SessionIdentity | null> {
    const token = readOpaqueSessionToken(headers);
    if (!token) return null;
    const session = await resolveSession(token);
    if (!session) return null;
    return {
      provider: "session",
      userId: session.userId,
      organizationId: session.organizationId,
      sessionTokenHash: session.tokenHash,
    };
  },
};
