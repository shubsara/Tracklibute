import { listThreads } from "@/server/email/email.service";
import { authedRoute, json } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** The caller's own threads, newest first. `limit` and `cursor` are pagination only. */
export const GET = authedRoute(async ({ auth, request }) => {
  const q = new URL(request.url).searchParams;
  return json({ data: await listThreads(auth, { limit: q.get("limit") ?? undefined, cursor: q.get("cursor") ?? undefined }) });
});

