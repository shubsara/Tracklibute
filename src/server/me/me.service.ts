import "server-only";

import type { AuthContext, MemberRole } from "@/domain/auth/auth-context";
import { NotFoundError } from "@/lib/errors";
import { withOrgScope } from "@/server/db/org-scope";

export interface MeDTO {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; name: string; slug: string };
  role: MemberRole;
}

export async function getMe(auth: AuthContext): Promise<MeDTO> {
  return withOrgScope(auth, async (tx) => {
    const [user, organization] = await Promise.all([
      tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, email: true, name: true } }),
      tx.organization.findUnique({
        where: { id: auth.organizationId },
        select: { id: true, name: true, slug: true },
      }),
    ]);
    if (!user || !organization) throw new NotFoundError("Session subject no longer exists");
    return { user, organization, role: auth.role };
  });
}
