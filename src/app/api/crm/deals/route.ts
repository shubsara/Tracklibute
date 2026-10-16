import { listDeals } from "@/server/crm/crm.service";
import { authedRoute, json } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** Open deals with their deterministic health. `state` and `mine` are filters only. */
export const GET = authedRoute(async ({ auth, request }) => {
  const q = new URL(request.url).searchParams;
  return json({ data: await listDeals(auth, { state: q.get("state") ?? undefined, mine: q.get("mine") === "true" }) });
});
