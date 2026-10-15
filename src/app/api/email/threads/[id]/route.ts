import { getThread } from "@/server/email/email.service";
import { authedRoute, json } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** One of the caller's own threads with normalized messages (404 for anyone else's). */
export const GET = authedRoute<{ id: string }>(async ({ auth, params }) => json({ data: await getThread(auth, params.id) }));
