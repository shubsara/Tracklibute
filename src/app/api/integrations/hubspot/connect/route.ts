import { oauthTransactionCookie } from "@/server/auth/oauth-state";
import { authedRoute, redirect } from "@/server/http/route";
import { startHubSpotConnect } from "@/server/integrations/hubspot/hubspot-connection.service";

export const dynamic = "force-dynamic";

/** ADMIN: start read-only HubSpot OAuth for the whole organization. */
export const GET = authedRoute(
  async ({ auth }) => {
    const { url, transaction } = await startHubSpotConnect(auth);
    return redirect(url, 302, [oauthTransactionCookie(transaction)]);
  },
  { minRole: "ADMIN" },
);
