import { authedRoute, isFormRequest, json, redirect } from "@/server/http/route";
import { disconnectHubSpot, getHubSpotStatus } from "@/server/integrations/hubspot/hubspot-connection.service";

export const dynamic = "force-dynamic";

/** Org-wide HubSpot connection status (any member). Never includes token material. */
export const GET = authedRoute(async ({ auth }) => json({ data: await getHubSpotStatus(auth) }));

/** ADMIN: disconnect HubSpot (wipe credentials + CRM mirror). No call is made to HubSpot. */
export const DELETE = authedRoute(
  async ({ auth, request }) => {
    await disconnectHubSpot(auth);
    return isFormRequest(request) ? redirect("/settings/integrations") : json({ ok: true });
  },
  { minRole: "ADMIN" },
);
