import { getDeal } from "@/server/crm/crm.service";
import { authedRoute, json } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** One deal: health, reasons, contacts, and a metadata-only email timeline. */
export const GET = authedRoute<{ id: string }>(async ({ auth, params }) => json({ data: await getDeal(auth, params.id) }));
