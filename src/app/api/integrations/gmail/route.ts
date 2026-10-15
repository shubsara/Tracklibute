import { authedRoute, isFormRequest, json, redirect } from "@/server/http/route";
import { disconnectGmail, getGmailStatus } from "@/server/integrations/gmail/gmail-connection.service";

export const dynamic = "force-dynamic";

/** The caller's own Gmail connection status. Never includes token material. */
export const GET = authedRoute(async ({ auth }) => json({ data: await getGmailStatus(auth) }));

/** Disconnect the caller's own Gmail (revoke at Google, wipe credentials). */
export const DELETE = authedRoute(async ({ auth, request }) => {
  await disconnectGmail(auth);
  return isFormRequest(request) ? redirect("/settings/integrations") : json({ ok: true });
});
