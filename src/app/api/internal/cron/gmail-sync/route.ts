import { errorResponse, json } from "@/server/http/route";
import { runGmailCronSync, verifyCronSecret } from "@/server/integrations/gmail/gmail-cron.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Protected scheduler entry point: `Authorization: Bearer $GMAIL_SYNC_CRON_SECRET`.
 * Not a user endpoint; returns counts only (no mailbox content or addresses).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    verifyCronSecret(request.headers);
    return json({ data: await runGmailCronSync() });
  } catch (err) {
    return errorResponse(err);
  }
}
