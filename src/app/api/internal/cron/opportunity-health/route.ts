import { verifyCronBearer } from "@/server/http/cron-auth";
import { errorResponse, json } from "@/server/http/route";
import { runOpportunityHealthCron } from "@/server/opportunity-health/opportunity-health-cron.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Scheduler entry point: `Authorization: Bearer $CRON_SECRET`. Database-only; returns counts. */
export async function POST(request: Request): Promise<Response> {
  try {
    verifyCronBearer(request.headers);
    return json({ data: await runOpportunityHealthCron() });
  } catch (err) {
    return errorResponse(err);
  }
}
