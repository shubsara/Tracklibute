import { NotFoundError } from "@/lib/errors";
import { authedRoute, isFormRequest, json, redirect } from "@/server/http/route";
import { runLeadHealth } from "@/server/lead-health/lead-health.service";
import { runOpportunityHealth } from "@/server/opportunity-health/opportunity-health.service";
import { getResponsibility } from "@/server/responsibilities/responsibilities.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** ADMIN: run an installed deterministic responsibility now. */
export const POST = authedRoute<{ id: string }>(
  async ({ auth, params, request }) => {
    const responsibility = await getResponsibility(auth, params.id);
    if (responsibility.templateKey === "opportunity_health") {
      const result = await runOpportunityHealth(auth, { trigger: "manual" });
      return isFormRequest(request) ? redirect("/opportunities") : json({ data: result });
    }
    if (responsibility.templateKey === "lead_health") {
      const result = await runLeadHealth(auth, { trigger: "manual" });
      return isFormRequest(request) ? redirect("/recommendations") : json({ data: result });
    }
    throw new NotFoundError("This responsibility has no detector yet");
  },
  { minRole: "ADMIN" },
);
