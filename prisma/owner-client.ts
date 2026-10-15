import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";

/**
 * Schema-owner client. Used ONLY by migrations tooling, the seed and test
 * fixtures. As the table owner it is exempt from RLS — never import this from
 * application code (src/).
 */
export function createOwnerClient(url = process.env.DATABASE_OWNER_URL): PrismaClient {
  if (!url) throw new Error("DATABASE_OWNER_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
