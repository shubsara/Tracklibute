import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

/**
 * Runtime database client. Connects as the restricted application role
 * (DATABASE_URL), which is subject to Row-Level Security.
 *
 * Do not query tenant-owned tables with this client directly — go through
 * `withOrgScope` so the RLS context is set for the transaction.
 */
const globalForDb = globalThis as unknown as { __tracklibuteDb?: PrismaClient };

export function getAppDb(): PrismaClient {
  if (!globalForDb.__tracklibuteDb) {
    const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
    globalForDb.__tracklibuteDb = new PrismaClient({ adapter });
  }
  return globalForDb.__tracklibuteDb;
}

export async function disconnectAppDb(): Promise<void> {
  await globalForDb.__tracklibuteDb?.$disconnect();
  globalForDb.__tracklibuteDb = undefined;
}
