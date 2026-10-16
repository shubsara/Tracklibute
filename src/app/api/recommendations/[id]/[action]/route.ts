import { NotFoundError } from "@/lib/errors";
import { authedRoute, isFormRequest, json, readBody, redirect } from "@/server/http/route";
import { actOnRecommendation, type RecommendationAction } from "@/server/recommendations/recommendations.service";

export const dynamic = "force-dynamic";

const ACTIONS = new Set<RecommendationAction>(["snooze", "dismiss", "accept"]);

/**
 * POST /api/recommendations/:id/{snooze|dismiss|accept} (MEMBER+). Runs the
 * matching registered internal action; nothing outside Tracklibute changes.
 */
export const POST = authedRoute<{ id: string; action: string }>(
  async ({ auth, params, request }) => {
    if (!ACTIONS.has(params.action as RecommendationAction)) throw new NotFoundError("Unknown recommendation action");
    const form = isFormRequest(request);
    const body = form ? await readBody(request) : await request.text().then((t) => (t ? JSON.parse(t) : {})).catch(() => ({}));
    const { returnTo, ...input } = (body ?? {}) as Record<string, unknown>;
    const rec = await actOnRecommendation(auth, params.id, params.action as RecommendationAction, input);
    if (form) return redirect(typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/recommendations");
    return json({ data: rec });
  },
  { minRole: "MEMBER" },
);
