import "server-only";

import type { Recommendation } from "@/generated/prisma/client";
import type { AuthContext } from "@/domain/auth/auth-context";
import { NotFoundError } from "@/lib/errors";
import { withOrgScope } from "@/server/db/org-scope";

/**
 * Read access only in Foundation. Recommendations are produced by
 * responsibility detectors, which arrive in later specs.
 */
export async function listRecommendations(
  auth: AuthContext,
  opts: { status?: Recommendation["status"] } = {},
): Promise<Recommendation[]> {
  return withOrgScope(auth, (tx) =>
    tx.recommendation.findMany({
      where: { organizationId: auth.organizationId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
}

export async function getRecommendation(auth: AuthContext, id: string): Promise<Recommendation> {
  const row = await withOrgScope(auth, (tx) =>
    tx.recommendation.findFirst({ where: { id, organizationId: auth.organizationId } }),
  );
  if (!row) throw new NotFoundError("Recommendation not found");
  return row;
}
