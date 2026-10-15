import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "@/domain/auth/auth-context";
import { redact } from "@/lib/redact";
import type { Tx } from "@/server/db/org-scope";

export { redact };

export interface AuditEntry {
  event: string; // e.g. "proposed_action.approved"
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append an audit record inside the caller's org-scoped transaction.
 * `actor: "SYSTEM"` records automated work (e.g. cron sync) done on behalf of
 * `auth.userId`, which is kept in metadata.onBehalfOfUserId.
 */
export async function recordAudit(
  tx: Tx,
  auth: AuthContext,
  entry: AuditEntry,
  opts: { actor?: "USER" | "SYSTEM" } = {},
): Promise<void> {
  const system = opts.actor === "SYSTEM";
  const metadata = system ? { ...entry.metadata, onBehalfOfUserId: auth.userId } : entry.metadata;
  await tx.auditLog.create({
    data: {
      organizationId: auth.organizationId,
      actorType: system ? "SYSTEM" : "USER",
      actorUserId: system ? null : auth.userId,
      event: entry.event,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: metadata ? (redact(metadata) as Prisma.InputJsonValue) : undefined,
    },
  });
}
