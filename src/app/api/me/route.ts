import { authedRoute, json } from "@/server/http/route";
import { getMe } from "@/server/me/me.service";

export const dynamic = "force-dynamic";

/** Protected: who am I, in which organization, with which role. */
export const GET = authedRoute(async ({ auth }) => json(await getMe(auth)));
