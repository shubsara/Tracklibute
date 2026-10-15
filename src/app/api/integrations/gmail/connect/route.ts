import { oauthTransactionCookie } from "@/server/auth/oauth-state";
import { authedRoute, redirect } from "@/server/http/route";
import { startGmailConnect } from "@/server/integrations/gmail/gmail-connection.service";

export const dynamic = "force-dynamic";

/** Explicit, separate consent for read-only Gmail access (MEMBER+). */
export const GET = authedRoute(async ({ auth }) => {
  const { url, transaction } = await startGmailConnect(auth);
  return redirect(url, 302, [oauthTransactionCookie(transaction)]);
});
