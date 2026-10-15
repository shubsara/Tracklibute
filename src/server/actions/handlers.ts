import "server-only";

import type { AuthContext } from "@/domain/auth/auth-context";
import { type ActionPayload, type ActionType } from "@/domain/actions/registry";
import { NotFoundError } from "@/lib/errors";
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

export const defaultActionHandlers: ActionHandlers = {
  "recommendation.snooze": async ({ auth, payload }) => {
    await withOrgScope(auth, async (tx) => {
      const { count } = await tx.recommendation.updateMany({
        where: { id: payload.recommendationId, organizationId: auth.organizationId },
        data: { status: "SNOOZED", snoozedUntil: new Date(payload.until) },
      });
      if (count === 0) throw new NotFoundError("Recommendation not found");
    });
    return { snoozedUntil: payload.until };
  },
  // gmail.*, hubspot.*, google_calendar.* — intentionally absent in Foundation.
};
