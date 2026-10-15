import { beginGoogleSignIn } from "@/server/auth/google-sign-in";
import { oauthTransactionCookie } from "@/server/auth/oauth-state";
import { errorResponse, redirect } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** Public: start Google sign-in (identity only — does NOT connect Gmail). */
export async function GET(): Promise<Response> {
  try {
    const { url, transaction } = await beginGoogleSignIn();
    return redirect(url.toString(), 302, [oauthTransactionCookie(transaction)]);
  } catch (err) {
    return errorResponse(err);
  }
}
