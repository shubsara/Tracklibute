import { config as loadEnv } from "dotenv";

// Tests always target the isolated test database, never dev.
loadEnv({ path: ".env.test", override: true, quiet: true });

if (!process.env.DATABASE_URL?.includes("tracklibute_test")) {
  throw new Error("Refusing to run tests: DATABASE_URL does not point at tracklibute_test");
}
