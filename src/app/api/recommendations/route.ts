import type { Recommendation } from "@/generated/prisma/client";
import { authedRoute, json } from "@/server/http/route";
import { listRecommendations } from "@/server/recommendations/recommendations.service";

export const dynamic = "force-dynamic";

export const GET = authedRoute(async ({ auth, request }) => {
  const q = new URL(request.url).searchParams;
  return json({
    data: await listRecommendations(auth, {
      status: (q.get("status") ?? undefined) as Recommendation["status"] | undefined,
      mine: q.get("mine") === "true",
      dealId: q.get("dealId") ?? undefined,
    }),
  });
});
