import { after } from "next/server";

import { log } from "@/lib/log";
import { authedRoute, isFormRequest, json, redirect } from "@/server/http/route";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { runOpportunityHealthAfterSync } from "@/server/opportunity-health/opportunity-health.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** ADMIN: "Sync now" (read-only). A completed sync re-evaluates Opportunity Health. */
export const POST = authedRoute(
  async ({ auth, request }) => {
    const result = await syncHubSpot(auth, { trigger: "manual" });
    if (result.outcome === "completed") {
      try {
        // Never throws; failures are logged and surfaced via the HubSpot status.
        after(() => runOpportunityHealthAfterSync(auth, "manual"));
      } catch {
        log.info("opportunity_health.deferred", {});
      }
    }
    if (isFormRequest(request)) return redirect("/settings/integrations?hubspot=synced");
    return json({ data: result });
  },
  { minRole: "ADMIN" },
);
