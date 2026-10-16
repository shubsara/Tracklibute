import { getInternalEmailDomains, setInternalEmailDomains } from "@/server/email/email-activity.service";
import { authedRoute, isFormRequest, json, readBody, redirect } from "@/server/http/route";

export const dynamic = "force-dynamic";

/** Internal email domains: addresses on them are teammates, never buyers. */
export const GET = authedRoute(async ({ auth }) => json({ data: { domains: await getInternalEmailDomains(auth) } }));

export const PUT = authedRoute(
  async ({ auth, request }) => json({ data: { domains: await setInternalEmailDomains(auth, await readBody(request)) } }),
  { minRole: "ADMIN" },
);

/** HTML-form variant: one domain per line / comma separated. */
export const POST = authedRoute(
  async ({ auth, request }) => {
    const body = (await readBody(request)) as { domains?: string };
    const domains = String(body.domains ?? "").split(/[\s,]+/).filter(Boolean);
    await setInternalEmailDomains(auth, { domains });
    return isFormRequest(request) ? redirect("/settings/organization?saved=1") : json({ ok: true });
  },
  { minRole: "ADMIN" },
);
