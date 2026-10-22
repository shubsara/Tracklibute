import { authedRoute, json } from "@/server/http/route";
import { getRecommendation } from "@/server/recommendations/recommendations.service";

export const dynamic = "force-dynamic";

export const GET = authedRoute<{ id: string }>(async ({ auth, params }) => json({ data: await getRecommendation(auth, params.id) }));
