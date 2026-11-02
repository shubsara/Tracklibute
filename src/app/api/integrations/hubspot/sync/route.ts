import { after } from "next/server";

import { log } from "@/lib/log";
import { authedRoute, isFormRequest, json, redirect } from "@/server/http/route";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { runLeadHealthAfterSync } from "@/server/lead-health/lead-health.service";
import { runOpportunityHealthAfterSync } from "@/server/opportunity-health/opportunity-health.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** ADMIN: incremental or full read-only sync. A completed sync re-evaluates both health responsibilities. */
export const POST = authedRoute(
  async ({ auth, request }) => {
    const forceFull = new URL(request.url).searchParams.get("full") === "true";
    const result = await syncHubSpot(auth, { trigger: "manual", forceFull });
    if (result.outcome === "completed") {
      try {
        // Never throws; failures are logged and surfaced via the HubSpot status.
        after(async () => {
          await runOpportunityHealthAfterSync(auth, "manual");
          await runLeadHealthAfterSync(auth, "hubspot_manual");
        });
      } catch {
        log.info("opportunity_health.deferred", {});
      }
    }
    if (isFormRequest(request)) return redirect("/settings/integrations?hubspot=synced");
    return json({ data: result });
  },
  { minRole: "ADMIN" },
);
