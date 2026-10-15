import "server-only";

import { type AuthContext, isMemberRole } from "@/domain/auth/auth-context";
import { UnauthenticatedError } from "@/lib/errors";
import { getAppDb } from "@/server/db/client";

import { devAuthProvider } from "./dev-provider";
import type { AuthProvider, SessionIdentity } from "./provider";
import { sessionAuthProvider } from "./session-provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session provider first; the dev provider self-disables in production. */
const providers: readonly AuthProvider[] = [sessionAuthProvider, devAuthProvider];

/** Who is calling (may not have an organization yet). Null if unauthenticated. */
export async function getSessionIdentity(headers: Headers): Promise<SessionIdentity | null> {
  for (const provider of providers) {
    const identity = await provider.authenticate(headers);
    if (identity) return identity;
  }
  return null;
}

/**
 * Turn an authenticated identity into an AuthContext by verifying CURRENT
 * membership in the database. Role always comes from the database, so a
 * removed or downgraded member loses access on the next request.
 */
export async function contextFromIdentity(identity: {
  userId: string;
  organizationId: string | null;
}): Promise<AuthContext | null> {
  if (!identity.organizationId) return null;
  if (!UUID.test(identity.userId) || !UUID.test(identity.organizationId)) return null;
  const rows = await getAppDb().$queryRaw<{ role: string | null }[]>`
    SELECT auth_resolve_membership(${identity.userId}::uuid, ${identity.organizationId}::uuid)::text AS role`;
  const role = rows[0]?.role;
  if (!isMemberRole(role)) return null;
  return { userId: identity.userId, organizationId: identity.organizationId, role };
}

/** Returns the AuthContext for this request, or null if unauthenticated / no organization. */
export async function getAuthContext(headers: Headers): Promise<AuthContext | null> {
  const identity = await getSessionIdentity(headers);
  if (!identity) return null;
  return contextFromIdentity(identity);
}

/** Like getAuthContext, but throws UnauthenticatedError. */
export async function requireAuthContext(headers: Headers): Promise<AuthContext> {
  const auth = await getAuthContext(headers);
  if (!auth) throw new UnauthenticatedError();
  return auth;
}
