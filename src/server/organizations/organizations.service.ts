import "server-only";

import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { AuthContext } from "@/domain/auth/auth-context";
import { ConflictError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import type { SessionIdentity } from "@/server/auth/provider";
import { getAppDb } from "@/server/db/client";
import { withOrgScope } from "@/server/db/org-scope";

const createOrgInput = z.object({ name: z.string().trim().min(2).max(100) });

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `${base || "org"}-${randomBytes(3).toString("hex")}`;
}

/**
 * Onboarding: a signed-in user with no organization creates one and becomes
 * OWNER; the session is bound to it atomically in the database. The user is
 * taken from the session — any organizationId/userId in the input is ignored.
 */
export async function createOrganizationForSession(
  identity: SessionIdentity | null,
  input: unknown,
): Promise<AuthContext & { slug: string; name: string }> {
  if (!identity || identity.provider !== "session" || !identity.sessionTokenHash) {
    throw new UnauthenticatedError("A signed-in session is required");
  }
  if (identity.organizationId) throw new ConflictError("You already belong to an organization");

  const parsed = createOrgInput.safeParse(input);
  if (!parsed.success) throw new ValidationError("Organization name must be 2–100 characters");
  const slug = slugify(parsed.data.name);

  let organizationId: string;
  try {
    const rows = await getAppDb().$queryRaw<{ id: string }[]>`
      SELECT app_create_organization_for_session(${identity.sessionTokenHash}, ${parsed.data.name}, ${slug})::text AS id`;
    organizationId = rows[0]!.id;
  } catch (err) {
    if (err instanceof Error && /already belongs/.test(err.message)) {
      throw new ConflictError("You already belong to an organization");
    }
    throw err;
  }

  const auth: AuthContext = { userId: identity.userId, organizationId, role: "OWNER" };
  await withOrgScope(auth, (tx) =>
    recordAudit(tx, auth, {
      event: "organization.created",
      entityType: "organization",
      entityId: organizationId,
      metadata: { slug },
    }),
  );
  log.info("organization.created", { organizationId, userId: identity.userId });
  return { ...auth, slug, name: parsed.data.name };
}
