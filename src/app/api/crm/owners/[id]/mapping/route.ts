import { clearCrmOwnerMapping, setCrmOwnerMapping } from "@/server/crm/owner-mapping.service";
import { authedRoute, isFormRequest, json, readBody, redirect } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** ADMIN: map a HubSpot owner to an organization member (MANUAL). */
export const PUT = authedRoute<{ id: string }>(
  async ({ auth, params, request }) => {
    await setCrmOwnerMapping(auth, params.id, await readBody(request));
    return json({ ok: true });
  },
  { minRole: "ADMIN" },
);

/** HTML-form variant: an empty userId clears the mapping. */
export const POST = authedRoute<{ id: string }>(
  async ({ auth, params, request }) => {
    const body = (await readBody(request)) as { userId?: string };
    if (body.userId) await setCrmOwnerMapping(auth, params.id, { userId: body.userId });
    else await clearCrmOwnerMapping(auth, params.id);
    return isFormRequest(request) ? redirect("/settings/crm-owners") : json({ ok: true });
  },
  { minRole: "ADMIN" },
);

export const DELETE = authedRoute<{ id: string }>(
  async ({ auth, params }) => {
    await clearCrmOwnerMapping(auth, params.id);
    return json({ ok: true });
  },
  { minRole: "ADMIN" },
);
