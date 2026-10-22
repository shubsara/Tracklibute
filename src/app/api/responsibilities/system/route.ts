import { z } from "zod";

import { authedRoute, isFormRequest, json, readBody, redirect } from "@/server/http/route";
import { runOpportunityHealthAfterSync } from "@/server/opportunity-health/opportunity-health.service";
import { installSystemResponsibilities } from "@/server/responsibilities/responsibilities.service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const input = z
  .object({ runOpportunityHealth: z.union([z.boolean(), z.enum(["true", "false"])]).optional() })
  .strip();

/**
 * ADMIN: install any missing SYSTEM responsibilities for the caller's own
 * organization (idempotent; existing ones and their config are untouched).
 * Optionally run Opportunity Health right after. Repairs organizations
 * created before onboarding installed them — no reset, reseed or reconnect.
 */
export const POST = authedRoute(
  async ({ auth, request }) => {
    const raw = request.headers.get("content-length") === "0" ? {} : await readBody(request).catch(() => ({}));
    const parsed = input.safeParse(raw ?? {});
    const runAfter = parsed.success && (parsed.data.runOpportunityHealth === true || parsed.data.runOpportunityHealth === "true");
    const created = await installSystemResponsibilities(auth);
    const health = runAfter ? await runOpportunityHealthAfterSync(auth, "manual") : null;
    if (isFormRequest(request)) {
      const notice = health?.status === "failed" ? "health_failed" : "installed";
      return redirect(`/settings/integrations?responsibilities=${notice}`);
    }
    return json({ data: { created, opportunityHealth: health } });
  },
  { minRole: "ADMIN" },
);
