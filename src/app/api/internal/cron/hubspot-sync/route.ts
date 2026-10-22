import { verifyCronBearer } from "@/server/http/cron-auth";
import { errorResponse, json } from "@/server/http/route";
import { runHubSpotCronSync } from "@/server/integrations/hubspot/hubspot-cron.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Scheduler entry point: `Authorization: Bearer $CRON_SECRET`. Returns counts only. */
export async function POST(request: Request): Promise<Response> {
  try {
    verifyCronBearer(request.headers);
    return json({ data: await runHubSpotCronSync() });
  } catch (err) {
    return errorResponse(err);
  }
}
