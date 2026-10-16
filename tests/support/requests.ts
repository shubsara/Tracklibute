import type { AuthContext } from "@/domain/auth/auth-context";
import { getEnv } from "@/lib/env";
import { issueSessionToken } from "@/server/auth/session-token";

/** A Request authenticated as `auth` (Bearer session token), optionally with cookies. */
export function authedRequest(path: string, auth: AuthContext | null, init: RequestInit & { cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (auth) headers.set("authorization", `Bearer ${issueSessionToken(auth, getEnv().SESSION_SECRET)}`);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(path.startsWith("http") ? path : `http://localhost${path}`, { ...init, headers });
}

export const routeParams = <P>(p: P) => ({ params: Promise.resolve(p) });
