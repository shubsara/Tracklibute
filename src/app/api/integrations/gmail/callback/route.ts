import { after } from "next/server";

import { log } from "@/lib/log";
import { AppError } from "@/lib/errors";
import { classifyOAuthError } from "@/server/auth/google-oidc";
import { clearOAuthTransactionCookie, readOAuthTransaction } from "@/server/auth/oauth-state";
import { getAuthContext } from "@/server/auth/resolve";
import { redirect } from "@/server/http/route";
import { completeGmailConnect } from "@/server/integrations/gmail/gmail-connection.service";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";

export const dynamic = "force-dynamic";

const SETTINGS = "/settings/integrations";

/**
 * Schedule the initial sync after the response is sent. Outside a Next.js
 * request scope (e.g. tests) `after` is unavailable; the initial sync is then
 * left to the next cron run or "Sync now".
 */
function runAfterResponse(task: () => Promise<unknown>): void {
  try {
    after(() => task().catch(() => undefined));
  } catch {
    log.info("gmail.initial_sync_deferred", {});
  }
}

/**
 * Google redirects here after Gmail consent. Requires an authenticated
 * session; organization + mailbox owner come from that session and must match
 * the signed transaction. Query-string identifiers are never trusted.
 */
export async function GET(request: Request): Promise<Response> {
  const clearTx = clearOAuthTransactionCookie("gmail");
  const auth = await getAuthContext(request.headers);
  if (!auth) return redirect("/login?error=session_required", 303, [clearTx]);

  const transaction = readOAuthTransaction(request.headers, "gmail");
  if (!transaction) {
    log.warn("gmail.connect_failed", { organizationId: auth.organizationId, reason: "invalid_state" });
    return redirect(`${SETTINGS}?gmail=invalid_state`, 303, [clearTx]);
  }
  if (new URL(request.url).searchParams.has("error")) {
    return redirect(`${SETTINGS}?gmail=consent_denied`, 303, [clearTx]);
  }
  try {
    const result = await completeGmailConnect(auth, request.url, transaction);
    if (result.isFirstConnection) runAfterResponse(() => syncGmailMailbox(auth, { trigger: "connect" }));
    return redirect(`${SETTINGS}?gmail=connected`, 303, [clearTx]);
  } catch (err) {
    const reason = err instanceof AppError ? err.code : classifyOAuthError(err);
    log.warn("gmail.connect_failed", { organizationId: auth.organizationId, mailboxUserId: auth.userId, reason });
    return redirect(`${SETTINGS}?gmail=connect_failed`, 303, [clearTx]);
  }
}
