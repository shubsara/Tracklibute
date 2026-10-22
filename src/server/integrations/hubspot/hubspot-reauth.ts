import "server-only";

import type { AuthContext } from "@/domain/auth/auth-context";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import { withOrgScope } from "@/server/db/org-scope";

/**
 * HubSpot refused our grant (app uninstalled, access revoked, scopes removed).
 * Keep the integration row and synced CRM data, flag it, and require an
 * admin to reconnect. Idempotent: only CONNECTED → REAUTH_REQUIRED is audited.
 */
export async function markHubSpotReauthRequired(
  auth: AuthContext,
  integrationId: string,
  opts: { actor?: "USER" | "SYSTEM" } = {},
): Promise<void> {
  const changed = await withOrgScope(auth, async (tx) => {
    const { count } = await tx.integration.updateMany({
      where: { id: integrationId, organizationId: auth.organizationId, provider: "HUBSPOT", ownerUserId: null, status: "CONNECTED" },
      data: {
        status: "REAUTH_REQUIRED",
        lastError: "HubSpot access was revoked or is missing permissions. An admin must reconnect HubSpot.",
        syncLeaseExpiresAt: null,
      },
    });
    if (count === 0) return false;
    await recordAudit(tx, auth, { event: "hubspot.reauth_required", entityType: "integration", entityId: integrationId }, opts);
    return true;
  });
  if (changed) log.warn("hubspot.reauth_required", { organizationId: auth.organizationId, integrationId });
}
