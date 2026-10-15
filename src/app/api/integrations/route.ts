import { authedRoute, json } from "@/server/http/route";
import { listIntegrations } from "@/server/integrations/integrations.service";

export const dynamic = "force-dynamic";

/** Protected. Returns client-safe DTOs — credentials are never included. */
export const GET = authedRoute(async ({ auth }) => json({ data: await listIntegrations(auth) }));
