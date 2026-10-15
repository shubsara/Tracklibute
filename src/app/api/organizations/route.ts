import { getSessionIdentity } from "@/server/auth/resolve";
import { assertSameOrigin, errorResponse, isFormRequest, json, readBody, redirect } from "@/server/http/route";
import { createOrganizationForSession } from "@/server/organizations/organizations.service";

export const dynamic = "force-dynamic";

/**
 * Onboarding: create an organization for the signed-in user (who becomes
 * OWNER). Only `name` is read from the body; the user comes from the session.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const identity = await getSessionIdentity(request.headers);
    const org = await createOrganizationForSession(identity, await readBody(request));
    if (isFormRequest(request)) return redirect("/", 303);
    return json({ data: { organizationId: org.organizationId, name: org.name, slug: org.slug, role: org.role } }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
