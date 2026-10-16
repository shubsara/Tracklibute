import "server-only";

import { z } from "zod";

import type { Prisma, Recommendation } from "@/generated/prisma/client";
import type { AuthContext } from "@/domain/auth/auth-context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { executeAction, proposeAction } from "@/server/actions/actions.service";
import { withOrgScope } from "@/server/db/org-scope";

/**
 * Recommendations are produced by responsibility detectors (Opportunity
 * Health in Spec 03). People act on them only through registered, internal,
 * non-consequential actions (snooze / dismiss / accept) — never by editing.
 */
const STATUSES = ["OPEN", "ACCEPTED", "DISMISSED", "SNOOZED", "RESOLVED"] as const;

export interface ListRecommendationsOptions {
  status?: Recommendation["status"];
  /** Only recommendations about deals owned (via owner mapping) by the caller. */
  mine?: boolean;
  dealId?: string;
}

export async function myDealIds(tx: Prisma.TransactionClient, auth: AuthContext): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT d.id::text AS id
      FROM crm_deals d
      JOIN crm_owners o ON o.organization_id = d.organization_id AND o.integration_id = d.integration_id AND o.external_id = d.owner_external_id
      JOIN crm_owner_mappings m ON m.organization_id = o.organization_id AND m.crm_owner_id = o.id
     WHERE d.organization_id = ${auth.organizationId}::uuid AND m.user_id = ${auth.userId}::uuid`;
  return rows.map((r) => r.id);
}

export async function listRecommendations(auth: AuthContext, opts: ListRecommendationsOptions = {}): Promise<Recommendation[]> {
  if (opts.status && !(STATUSES as readonly string[]).includes(opts.status)) throw new ValidationError("Unknown status");
  if (opts.dealId && !z.uuid().safeParse(opts.dealId).success) throw new ValidationError("Invalid deal id");
  return withOrgScope(auth, async (tx) => {
    const and: Prisma.RecommendationWhereInput[] = [];
    if (opts.mine) and.push({ dealId: { in: await myDealIds(tx, auth) } });
    if (opts.dealId) and.push({ dealId: opts.dealId });
    return tx.recommendation.findMany({
      where: { organizationId: auth.organizationId, ...(opts.status ? { status: opts.status } : {}), AND: and },
      orderBy: [{ severity: "desc" }, { lastDetectedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 200,
    });
  });
}

export async function getRecommendation(auth: AuthContext, id: string): Promise<Recommendation> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Recommendation not found");
  const row = await withOrgScope(auth, (tx) =>
    tx.recommendation.findFirst({ where: { id, organizationId: auth.organizationId } }),
  );
  if (!row) throw new NotFoundError("Recommendation not found");
  return row;
}

const snoozeInput = z
  .object({
    until: z.iso.datetime({ offset: true }).optional(),
    days: z.coerce.number().int().min(1).max(90).optional(),
  })
  .strict();

export type RecommendationAction = "snooze" | "dismiss" | "accept";

/**
 * Act on a recommendation through the closed action registry: a USER-sourced
 * proposal of a non-consequential internal action, executed immediately.
 */
export async function actOnRecommendation(
  auth: AuthContext,
  id: string,
  action: RecommendationAction,
  input: unknown = {},
): Promise<Recommendation> {
  await getRecommendation(auth, id);
  let actionType: "recommendation.snooze" | "recommendation.dismiss" | "recommendation.accept";
  let payload: Record<string, string>;
  if (action === "snooze") {
    const parsed = snoozeInput.safeParse(input ?? {});
    if (!parsed.success) throw new ValidationError("Invalid snooze", parsed.error.issues.map((i) => i.message));
    const until = parsed.data.until ?? new Date(Date.now() + (parsed.data.days ?? 7) * 86_400_000).toISOString();
    if (new Date(until).getTime() <= Date.now()) throw new ValidationError("Snooze time must be in the future");
    actionType = "recommendation.snooze";
    payload = { recommendationId: id, until };
  } else {
    actionType = action === "dismiss" ? "recommendation.dismiss" : "recommendation.accept";
    payload = { recommendationId: id };
  }
  const proposed = await proposeAction(auth, { actionType, payload, recommendationId: id, source: "USER" });
  const executed = await executeAction(auth, proposed.id);
  if (executed.status !== "EXECUTED") throw new ConflictError(executed.error ?? "The action could not be completed");
  return getRecommendation(auth, id);
}
