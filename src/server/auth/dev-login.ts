import "server-only";

import { type AuthContext, isMemberRole } from "@/domain/auth/auth-context";
import { getEnv } from "@/lib/env";
import { ForbiddenError, UnauthenticatedError } from "@/lib/errors";
import { getAppDb } from "@/server/db/client";

import { isDevAuthAllowed } from "./dev-provider";
import { issueSessionToken } from "./session-token";

/**
 * Development login: (email, organization slug) → signed session token.
 * Succeeds only if the user is a member of that organization. No password —
 * this exists solely so the authentication boundary can be exercised locally.
 */
export async function devLogin(
  email: string,
  organizationSlug: string,
): Promise<{ token: string; auth: AuthContext }> {
  if (!isDevAuthAllowed()) throw new ForbiddenError("Development authentication is disabled");

  const rows = await getAppDb().$queryRaw<{ user_id: string; organization_id: string; role: string }[]>`
    SELECT user_id::text, organization_id::text, role::text
    FROM auth_resolve_login(${email}, ${organizationSlug})`;
  const row = rows[0];
  if (!row || !isMemberRole(row.role)) throw new UnauthenticatedError("Unknown user or organization");

  const auth: AuthContext = { userId: row.user_id, organizationId: row.organization_id, role: row.role };
  const token = issueSessionToken(auth, getEnv().SESSION_SECRET);
  return { token, auth };
}
