import { classifyOAuthError } from "@/server/auth/google-oidc";
import { completeGoogleSignIn } from "@/server/auth/google-sign-in";
import { clearOAuthTransactionCookie, readOAuthTransaction } from "@/server/auth/oauth-state";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/server/auth/session-store";
import { serializeCookie } from "@/server/auth/cookies";
import { log } from "@/lib/log";
import { redirect } from "@/server/http/route";

export const dynamic = "force-dynamic";

/**
 * Public: Google redirects here. State/nonce/PKCE are verified against the
 * signed transaction cookie; failures redirect to /login with a generic code.
 */
export async function GET(request: Request): Promise<Response> {
  const clearTx = clearOAuthTransactionCookie("login");
  const transaction = readOAuthTransaction(request.headers, "login");
  if (!transaction) {
    log.warn("auth.sign_in_failed", { reason: "invalid_state" });
    return redirect("/login?error=invalid_state", 303, [clearTx]);
  }
  if (new URL(request.url).searchParams.has("error")) {
    log.warn("auth.sign_in_failed", { reason: "consent_denied" });
    return redirect("/login?error=consent_denied", 303, [clearTx]);
  }
  try {
    const result = await completeGoogleSignIn(request.url, transaction);
    return redirect(result.hasOrganization ? "/" : "/onboarding", 303, [
      clearTx,
      serializeCookie(SESSION_COOKIE, result.sessionToken, { maxAge: SESSION_TTL_SECONDS }),
    ]);
  } catch (err) {
    log.warn("auth.sign_in_failed", { reason: classifyOAuthError(err) });
    return redirect("/login?error=sign_in_failed", 303, [clearTx]);
  }
}
