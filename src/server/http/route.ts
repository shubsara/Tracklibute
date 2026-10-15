import "server-only";

import { type AuthContext, type MemberRole, requireRole } from "@/domain/auth/auth-context";
import { AppError, ForbiddenError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { requireAuthContext } from "@/server/auth/resolve";

const NO_STORE = { "cache-control": "no-store" } as const;

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  // Merge via Headers so multi-value headers (Set-Cookie) survive.
  const merged = new Headers(headers);
  merged.set("cache-control", NO_STORE["cache-control"]);
  return Response.json(body, { status, headers: merged });
}

export function redirect(location: string, status: 302 | 303 = 303, setCookies: string[] = []): Response {
  const headers = new Headers({ location, ...NO_STORE });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: { code: err.code, message: err.message } };
    if (err instanceof ValidationError && err.issues.length) {
      (body.error as Record<string, unknown>).issues = err.issues;
    }
    return json(body, err.status);
  }
  // Unknown error: log a classification server-side, return a generic message.
  log.error("http.unhandled_error", { errorName: err instanceof Error ? err.name : typeof err });
  return json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
}

/**
 * CSRF defense for cookie-authenticated, state-changing requests: if the
 * browser sends an Origin header it must match this host. (SameSite=Lax
 * cookies already block most cross-site POSTs; this is the second layer.)
 */
export function assertSameOrigin(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError("Cross-origin request rejected");
  }
  if (originHost !== host) throw new ForbiddenError("Cross-origin request rejected");
}

export function isFormRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
}

type AuthedHandler<P> = (ctx: { request: Request; auth: AuthContext; params: P }) => Promise<Response>;

/**
 * Wrap a route handler behind the authentication boundary. The AuthContext
 * comes only from the server-side session + database membership. Any
 * organizationId / userId / mailboxUserId in the URL, body or headers is ignored.
 */
export function authedRoute<P = Record<string, never>>(handler: AuthedHandler<P>, opts: { minRole?: MemberRole } = {}) {
  return async (request: Request, routeCtx?: { params: Promise<P> }): Promise<Response> => {
    try {
      assertSameOrigin(request);
      const auth = await requireAuthContext(request.headers);
      if (opts.minRole) requireRole(auth, opts.minRole);
      const params = (routeCtx ? await routeCtx.params : {}) as P;
      return await handler({ request, auth, params });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}

/** Accepts JSON or an HTML form post. */
export async function readBody(request: Request): Promise<unknown> {
  if (isFormRequest(request)) return Object.fromEntries(await request.formData());
  return readJson(request);
}
