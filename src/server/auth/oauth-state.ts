import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

import { clearCookie, readCookie, serializeCookie } from "./cookies";

/**
 * Short-lived, HMAC-signed, HttpOnly cookie carrying the OAuth transaction
 * (state, nonce, PKCE verifier) between the redirect to Google and the
 * callback. CSRF protection: the callback's `state` must equal the cookie's,
 * and the cookie can only have been set by this server for this browser.
 * For Gmail connect it is additionally bound to the user + organization that
 * started the flow.
 */
export type OAuthPurpose = "login" | "gmail";

export interface OAuthTransaction {
  purpose: OAuthPurpose;
  state: string;
  nonce: string;
  codeVerifier: string;
  userId?: string;
  organizationId?: string;
  exp: number; // epoch seconds
}

const TTL_SECONDS = 10 * 60;
const cookieName = (purpose: OAuthPurpose) => `tl_oauth_${purpose}`;
const COOKIE_PATH = "/api";

function sign(body: string): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(`oauth-state.v1.${body}`).digest("base64url");
}

export function oauthTransactionCookie(tx: Omit<OAuthTransaction, "exp">, now = Date.now()): string {
  const payload: OAuthTransaction = { ...tx, exp: Math.floor(now / 1000) + TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return serializeCookie(cookieName(tx.purpose), `${body}.${sign(body)}`, { maxAge: TTL_SECONDS, path: COOKIE_PATH });
}

export function clearOAuthTransactionCookie(purpose: OAuthPurpose): string {
  return clearCookie(cookieName(purpose), COOKIE_PATH);
}

/** Returns the verified transaction, or null if missing / tampered / expired / wrong purpose. */
export function readOAuthTransaction(
  headers: Headers,
  purpose: OAuthPurpose,
  now = Date.now(),
): OAuthTransaction | null {
  const raw = readCookie(headers, cookieName(purpose));
  if (!raw) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const tx = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthTransaction;
    if (tx.purpose !== purpose || typeof tx.state !== "string" || typeof tx.codeVerifier !== "string") return null;
    if (tx.exp <= Math.floor(now / 1000)) return null;
    return tx;
  } catch {
    return null;
  }
}
