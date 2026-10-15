import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compact HMAC-SHA256 signed session token: base64url(payload).base64url(sig).
 * Used by the development auth provider only. The organization id inside is
 * written by the server after a membership check — never taken from a client.
 */
export interface SessionClaims {
  readonly sub: string; // userId
  readonly org: string; // organizationId
  readonly iat: number; // seconds
  readonly exp: number; // seconds
}

const VERSION = "v1";

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(`${VERSION}.${data}`).digest("base64url");
}

export function issueSessionToken(
  input: { userId: string; organizationId: string },
  secret: string,
  ttlSeconds = 60 * 60 * 8,
  now = Math.floor(Date.now() / 1000),
): string {
  const claims: SessionClaims = { sub: input.userId, org: input.organizationId, iat: now, exp: now + ttlSeconds };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** Returns claims for a valid, unexpired token; otherwise null. Never throws on bad input. */
export function verifySessionToken(
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionClaims>;
    if (
      typeof claims.sub !== "string" ||
      typeof claims.org !== "string" ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number"
    ) {
      return null;
    }
    if (claims.exp <= now) return null;
    return claims as SessionClaims;
  } catch {
    return null;
  }
}
