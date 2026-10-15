import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "@/domain/auth/auth-context";

import { getAppDb } from "./client";

export type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction bound to the caller's organization.
 *
 * Sets `app.organization_id` / `app.user_id` (transaction-local) so PostgreSQL
 * RLS policies apply. This is defense in depth: callers must STILL filter by
 * `auth.organizationId` and authorize the operation in application code.
 */
export async function withOrgScope<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(auth.organizationId) || !UUID.test(auth.userId)) {
    throw new Error("withOrgScope: AuthContext contains a malformed identifier");
  }
  return getAppDb().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${auth.organizationId}, true),
                                set_config('app.user_id', ${auth.userId}, true)`;
    return fn(tx);
  });
}
