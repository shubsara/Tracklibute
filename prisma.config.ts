import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

loadEnv({ quiet: true });

// Migrations and seeding run as the schema-owner role. The application itself
// connects as a restricted role (DATABASE_URL) that is subject to Row-Level Security.
const ownerUrl = process.env.DATABASE_OWNER_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  ...(ownerUrl ? { datasource: { url: ownerUrl } } : {}),
});
