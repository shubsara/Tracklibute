import "server-only";

import { type AuthContext, isMemberRole } from "@/domain/auth/auth-context";
import { UnauthenticatedError } from "@/lib/errors";
import { getAppDb } from "@/server/db/client";

import { devAuthProvider } from "./dev-provider";
import type { AuthProvider, SessionIdentity } from "./provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let activeProvider: AuthProvider = devAuthProvider;

export function getAuthProvider(): AuthProvider {
  return activeProvider;
}

/** Swap provider (production provider in a later spec; tests). */
export function setAuthProvider(provider: AuthProvider): void {
  activeProvider = provider;
}

/**
 * Turn an authenticated identity into an AuthContext by verifying CURRENT
 * membership in the database. Role always comes from the database, so a
 * removed or downgraded member loses access on the next request.
 */
export async function contextFromIdentity(identity: SessionIdentity): Promise<AuthContext | null> {
  if (!UUID.test(identity.userId) || !UUID.test(identity.organizationId)) return null;
  const rows = await getAppDb().$queryRaw<{ role: string | null }[]>`
    SELECT auth_resolve_membership(${identity.userId}::uuid, ${identity.organizationId}::uuid)::text AS role`;
  const role = rows[0]?.role;
  if (!isMemberRole(role)) return null;
  return { userId: identity.userId, organizationId: identity.organizationId, role };
}

/** Returns the AuthContext for this request, or null if unauthenticated. */
export async function getAuthContext(headers: Headers): Promise<AuthContext | null> {
  const identity = await getAuthProvider().authenticate(headers);
  if (!identity) return null;
  return contextFromIdentity(identity);
}

/** Like getAuthContext, but throws UnauthenticatedError. */
export async function requireAuthContext(headers: Headers): Promise<AuthContext> {
  const auth = await getAuthContext(headers);
  if (!auth) throw new UnauthenticatedError();
  return auth;
}
