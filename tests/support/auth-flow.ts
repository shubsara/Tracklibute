import { GET as googleCallback } from "@/app/api/auth/google/callback/route";
import { GET as googleLogin } from "@/app/api/auth/google/login/route";

import type { FakeGoogle } from "./fake-google";

/** First `name=value` pair for a cookie from Set-Cookie headers. */
export function cookieFrom(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  return null;
}

export function cookieValue(res: Response, name: string): string | null {
  const pair = cookieFrom(res, name);
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

export interface Identity {
  sub: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
}

/** Full Google sign-in through the real routes against the fake Google. */
export async function signIn(google: FakeGoogle, identity: Identity) {
  const start = await googleLogin();
  const txCookie = cookieFrom(start, "tl_oauth_login")!;
  const callbackUrl = google.authorize(start.headers.get("location")!, identity);
  const done = await googleCallback(new Request(callbackUrl, { headers: { cookie: txCookie } }));
  const token = cookieValue(done, "tl_session");
  return { token, location: done.headers.get("location"), response: done };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
