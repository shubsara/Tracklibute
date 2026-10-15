import { ForbiddenError } from "@/lib/errors";

/**
 * The authentication boundary.
 *
 * Every server-side operation receives an AuthContext produced by the server
 * auth layer (src/server/auth). Domain and service code depend only on this
 * shape — never on a concrete auth provider, a cookie, or a client-supplied
 * userId / organizationId.
 */
export const MEMBER_ROLES = ["VIEWER", "MEMBER", "ADMIN", "OWNER"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface AuthContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: MemberRole;
}

const RANK: Record<MemberRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function hasRole(auth: AuthContext, minimum: MemberRole): boolean {
  return RANK[auth.role] >= RANK[minimum];
}

export function requireRole(auth: AuthContext, minimum: MemberRole): void {
  if (!hasRole(auth, minimum)) {
    throw new ForbiddenError(`This action requires the ${minimum} role or higher`);
  }
}

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);
}
