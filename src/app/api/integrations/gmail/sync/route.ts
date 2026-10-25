import { after } from "next/server";

import { authedRoute, isFormRequest, json, redirect } from "@/server/http/route";
import { runLeadHealthAfterSync } from "@/server/lead-health/lead-health.service";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "Sync now" — only for the caller's own mailbox. */
export const POST = authedRoute(async ({ auth, request }) => {
  const result = await syncGmailMailbox(auth, { trigger: "manual" });
  if (result.outcome === "completed") {
    after(() => runLeadHealthAfterSync(auth, "gmail_sync"));
  }
  if (isFormRequest(request)) return redirect("/settings/integrations?gmail=synced");
  return json({
    data: {
      outcome: result.outcome,
      resumed: result.resumed,
      alreadySynced: result.alreadySynced,
      syncType: result.syncType,
      messagesUpserted: result.messagesUpserted,
      messagesDeleted: result.messagesDeleted,
      threadsTouched: result.threadsTouched,
      skipped: result.skipped,
      durationMs: result.durationMs,
    },
  });
});
