import { z } from "zod";

import { ValidationError } from "@/lib/errors";
import { devLogin } from "@/server/auth/dev-login";
import { DEV_SESSION_COOKIE } from "@/server/auth/dev-provider";
import { errorResponse, json } from "@/server/http/route";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  email: z.email(),
  organizationSlug: z.string().trim().min(1).max(100),
});

function sessionCookie(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${DEV_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/**
 * DEVELOPMENT ONLY. Sign in as a seeded user within one of their
 * organizations. Disabled when NODE_ENV=production or DEV_AUTH_ENABLED!=true.
 * Accepts JSON (returns the token for API use) or an HTML form (redirects).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const isForm = (request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
    const raw = isForm ? Object.fromEntries(await request.formData()) : await request.json().catch(() => null);
    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("email and organizationSlug are required");

    const { token, auth } = await devLogin(parsed.data.email, parsed.data.organizationSlug);
    const cookie = sessionCookie(token, 60 * 60 * 8);

    if (isForm) {
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie } });
    }
    return json({ token, auth }, 200, { "set-cookie": cookie });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(): Promise<Response> {
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
}
