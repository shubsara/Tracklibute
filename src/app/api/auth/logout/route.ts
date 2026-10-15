import { clearCookie } from "@/server/auth/cookies";
import { DEV_SESSION_COOKIE } from "@/server/auth/dev-provider";
import { readOpaqueSessionToken } from "@/server/auth/session-provider";
import { revokeSession, SESSION_COOKIE } from "@/server/auth/session-store";
import { assertSameOrigin, errorResponse, isFormRequest, json, redirect } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** Revokes the server-side session (not just the cookie) and clears cookies. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const token = readOpaqueSessionToken(request.headers);
    if (token) await revokeSession(token);
    const cookies = [clearCookie(SESSION_COOKIE), clearCookie(DEV_SESSION_COOKIE)];
    if (isFormRequest(request)) return redirect("/login", 303, cookies);
    const headers = new Headers();
    for (const c of cookies) headers.append("set-cookie", c);
    return json({ ok: true }, 200, headers);
  } catch (err) {
    return errorResponse(err);
  }
}
