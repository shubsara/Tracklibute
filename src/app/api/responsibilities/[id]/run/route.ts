import { NotFoundError } from "@/lib/errors";
import { authedRoute, isFormRequest, json, redirect } from "@/server/http/route";
import { runOpportunityHealth } from "@/server/opportunity-health/opportunity-health.service";
import { getResponsibility } from "@/server/responsibilities/responsibilities.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** ADMIN: run a responsibility now. Only Opportunity Health has a detector in Spec 03. */
export const POST = authedRoute<{ id: string }>(
  async ({ auth, params, request }) => {
    const responsibility = await getResponsibility(auth, params.id);
    if (responsibility.templateKey !== "opportunity_health") throw new NotFoundError("This responsibility has no detector yet");
    const result = await runOpportunityHealth(auth, { trigger: "manual" });
    return isFormRequest(request) ? redirect("/opportunities") : json({ data: result });
  },
  { minRole: "ADMIN" },
);
