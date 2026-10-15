import "server-only";

import { createHmac, randomBytes } from "node:crypto";

import { isMemberRole, type MemberRole } from "@/domain/auth/auth-context";
import { getEnv } from "@/lib/env";
import { getAppDb } from "@/server/db/client";

/**
 * Database-backed opaque sessions.
 *
 * The client receives 32 random bytes (base64url). The database stores only
 * HMAC-SHA256(SESSION_SECRET, token), so a database leak does not yield usable
 * session tokens. Rotating SESSION_SECRET invalidates every session.
 * The app role has no grants on `sessions`; all access goes through
 * SECURITY DEFINER functions (see migration auth_sessions_gmail).
 */
export const SESSION_COOKIE = "tl_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  role: MemberRole | null;
  tokenHash: string;
}

export function hashSessionToken(token: string): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(`session.v1.${token}`).digest("hex");
}

/** Opaque tokens never contain "." — this distinguishes them from signed dev tokens. */
export function looksLikeSessionToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function createSession(userId: string): Promise<{ token: string; organizationId: string | null }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const rows = await getAppDb().$queryRaw<{ session_id: string; organization_id: string | null }[]>`
    SELECT session_id::text, organization_id::text
    FROM auth_create_session(${userId}::uuid, ${hashSessionToken(token)}, ${expiresAt})`;
  return { token, organizationId: rows[0]?.organization_id ?? null };
}

export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  if (!looksLikeSessionToken(token)) return null;
  const tokenHash = hashSessionToken(token);
  const rows = await getAppDb().$queryRaw<
    { session_id: string; user_id: string; organization_id: string | null; role: string | null }[]
  >`SELECT session_id::text, user_id::text, organization_id::text, role::text
    FROM auth_resolve_session(${tokenHash})`;
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    role: isMemberRole(row.role) ? row.role : null,
    tokenHash,
  };
}

export async function revokeSession(token: string): Promise<boolean> {
  if (!looksLikeSessionToken(token)) return false;
  const rows = await getAppDb().$queryRaw<{ revoked: boolean }[]>`
    SELECT auth_revoke_session(${hashSessionToken(token)}) AS revoked`;
  return rows[0]?.revoked ?? false;
}
