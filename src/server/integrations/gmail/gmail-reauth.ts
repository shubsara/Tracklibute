import "server-only";

import type { AuthContext } from "@/domain/auth/auth-context";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import { withOrgScope } from "@/server/db/org-scope";

/**
 * Google refused our refresh token (revoked access, password change, expired
 * test-mode grant, ...). Keep the integration row, flag it, and require the
 * owner to reconnect. Never deletes data; never stores provider messages.
 */
export async function markGmailReauthRequired(
  auth: AuthContext,
  integrationId: string,
  opts: { actor?: "USER" | "SYSTEM" } = {},
): Promise<void> {
  await withOrgScope(auth, async (tx) => {
    await tx.integration.updateMany({
      where: { id: integrationId, organizationId: auth.organizationId, ownerUserId: auth.userId },
      data: {
        status: "REAUTH_REQUIRED",
        lastError: "Google access was revoked or expired. Reconnect Gmail to resume syncing.",
        syncLeaseExpiresAt: null,
      },
    });
    for (const event of ["gmail.token_refresh_failed", "gmail.reauth_required"]) {
      await recordAudit(tx, auth, { event, entityType: "integration", entityId: integrationId }, opts);
    }
  });
  log.warn("gmail.reauth_required", {
    organizationId: auth.organizationId,
    mailboxUserId: auth.userId,
    integrationId,
  });
}
