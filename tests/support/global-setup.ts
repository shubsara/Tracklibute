import { execSync } from "node:child_process";

import { config as loadEnv } from "dotenv";

/**
 * Apply all migrations (incl. RLS + guards) to the test database.
 * Non-destructive: every test creates uniquely named organizations, so no
 * reset is needed between runs.
 */
export default function setup(): void {
  const env = loadEnv({ path: ".env.test", override: false, quiet: true }).parsed ?? {};
  const ownerUrl = env.DATABASE_OWNER_URL ?? "";
  if (!ownerUrl.includes("tracklibute_test")) {
    throw new Error("Refusing to migrate: DATABASE_OWNER_URL in .env.test must target tracklibute_test");
  }
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_OWNER_URL: ownerUrl },
  });
}
