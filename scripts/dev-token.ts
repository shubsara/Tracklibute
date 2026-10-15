/**
 * DEVELOPMENT ONLY. Print a bearer token for a seeded user in an organization.
 *   pnpm dev:token alice@acme.test acme
 *   curl -H "Authorization: Bearer <token>" localhost:3000/api/me
 */
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

async function main() {
  const [email, slug] = process.argv.slice(2);
  if (!email || !slug) {
    console.error("usage: pnpm dev:token <email> <organization-slug>");
    process.exit(2);
  }
  const { devLogin } = await import("../src/server/auth/dev-login");
  const { disconnectAppDb } = await import("../src/server/db/client");
  try {
    const { token, auth } = await devLogin(email, slug);
    console.info(JSON.stringify({ auth, token }, null, 2));
  } finally {
    await disconnectAppDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
