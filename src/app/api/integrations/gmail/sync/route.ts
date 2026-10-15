import { authedRoute, isFormRequest, json, redirect } from "@/server/http/route";
import { syncGmailMailbox } from "@/server/integrations/gmail/gmail-sync.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "Sync now" — only for the caller's own mailbox. */
export const POST = authedRoute(async ({ auth, request }) => {
  const result = await syncGmailMailbox(auth, { trigger: "manual" });
  if (isFormRequest(request)) return redirect("/settings/integrations?gmail=synced");
  return json({
    data: {
      syncType: result.syncType,
      messagesUpserted: result.messagesUpserted,
      messagesDeleted: result.messagesDeleted,
      threadsTouched: result.threadsTouched,
      skipped: result.skipped,
      durationMs: result.durationMs,
    },
  });
});
