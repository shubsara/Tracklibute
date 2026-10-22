import { listCrmOwners } from "@/server/crm/owner-mapping.service";
import { authedRoute, json } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** HubSpot owners and their Tracklibute member mapping. */
export const GET = authedRoute(async ({ auth }) => json({ data: await listCrmOwners(auth) }));
