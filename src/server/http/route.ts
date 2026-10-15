import "server-only";

import { type AuthContext, type MemberRole, requireRole } from "@/domain/auth/auth-context";
import { AppError, ValidationError } from "@/lib/errors";
import { requireAuthContext } from "@/server/auth/resolve";

const NO_STORE = { "cache-control": "no-store" } as const;

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: { code: err.code, message: err.message } };
    if (err instanceof ValidationError && err.issues.length) {
      (body.error as Record<string, unknown>).issues = err.issues;
    }
    return json(body, err.status);
  }
  // Unknown error: log server-side, return a generic message.
  console.error("Unhandled route error", err instanceof Error ? err.name : typeof err);
  return json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
}

type AuthedHandler = (ctx: { request: Request; auth: AuthContext }) => Promise<Response>;

/**
 * Wrap a route handler behind the authentication boundary. The AuthContext
 * comes only from the server-verified session + database membership. Any
 * organizationId/userId in the URL, body or headers is ignored.
 */
export function authedRoute(handler: AuthedHandler, opts: { minRole?: MemberRole } = {}) {
  return async (request: Request): Promise<Response> => {
    try {
      const auth = await requireAuthContext(request.headers);
      if (opts.minRole) requireRole(auth, opts.minRole);
      return await handler({ request, auth });
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
