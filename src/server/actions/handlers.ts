import "server-only";

import type { AuthContext } from "@/domain/auth/auth-context";
import { type ActionPayload, type ActionType } from "@/domain/actions/registry";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { withOrgScope } from "@/server/db/org-scope";

/**
 * Executors for registered action types. A handler receives an already
 * validated, already approved payload. Handlers for external providers are
 * added with each provider's adapter spec; until then those action types are
 * refused before any state change.
 */
export type JsonResult = Record<string, string | number | boolean | null>;

export type ActionHandler<T extends ActionType = ActionType> = (ctx: {
  auth: AuthContext;
  actionId: string;
  payload: ActionPayload<T>;
}) => Promise<JsonResult>;

export type ActionHandlers = { [T in ActionType]?: ActionHandler<T> };

/** Internal recommendation status change. A RESOLVED recommendation cannot be acted on. */
async function setRecommendationStatus(
  auth: AuthContext,
  recommendationId: string,
  data: { status: "SNOOZED" | "DISMISSED" | "ACCEPTED"; snoozedUntil: Date | null },
): Promise<void> {
  await withOrgScope(auth, async (tx) => {
    const { count } = await tx.recommendation.updateMany({
      where: { id: recommendationId, organizationId: auth.organizationId, status: { not: "RESOLVED" } },
      data,
    });
    if (count === 0) {
      const exists = await tx.recommendation.findFirst({ where: { id: recommendationId, organizationId: auth.organizationId }, select: { id: true } });
      throw exists ? new ConflictError("This recommendation is already resolved") : new NotFoundError("Recommendation not found");
    }
  });
}

export const defaultActionHandlers: ActionHandlers = {
  "recommendation.snooze": async ({ auth, payload }) => {
    await setRecommendationStatus(auth, payload.recommendationId, { status: "SNOOZED", snoozedUntil: new Date(payload.until) });
    return { snoozedUntil: payload.until };
  },
  "recommendation.dismiss": async ({ auth, payload }) => {
    await setRecommendationStatus(auth, payload.recommendationId, { status: "DISMISSED", snoozedUntil: null });
    return { status: "DISMISSED" };
  },
  "recommendation.accept": async ({ auth, payload }) => {
    await setRecommendationStatus(auth, payload.recommendationId, { status: "ACCEPTED", snoozedUntil: null });
    return { status: "ACCEPTED" };
  },
  // gmail.*, hubspot.*, google_calendar.* — intentionally absent. HubSpot is
  // strictly read-only (Spec 03): there is no executor for any CRM write.
};
