import { authedRoute, json, readJson } from "@/server/http/route";
import {
  createCustomResponsibility,
  listResponsibilities,
} from "@/server/responsibilities/responsibilities.service";

export const dynamic = "force-dynamic";

/** Protected, organization-scoped. */
export const GET = authedRoute(async ({ auth }) => json({ data: await listResponsibilities(auth) }));

/** Protected, ADMIN+. Creates a CUSTOM responsibility. */
export const POST = authedRoute(
  async ({ auth, request }) => json({ data: await createCustomResponsibility(auth, await readJson(request)) }, 201),
  { minRole: "ADMIN" },
);
