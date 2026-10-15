import { getAppDb } from "@/server/db/client";
import { json } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** Liveness + database connectivity. Public, no tenant data. */
export async function GET(): Promise<Response> {
  try {
    await getAppDb().$queryRaw`SELECT 1`;
    return json({ status: "ok", database: "ok" });
  } catch {
    return json({ status: "degraded", database: "unreachable" }, 503);
  }
}
