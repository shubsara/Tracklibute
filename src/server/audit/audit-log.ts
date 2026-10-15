import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "@/domain/auth/auth-context";
import type { Tx } from "@/server/db/org-scope";

const SENSITIVE_KEY = /token|secret|password|credential|authorization|api[-_]?key|cookie/i;

/** Recursively replace values under sensitive-looking keys. Audit logs must never hold secrets. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v),
      ]),
    );
  }
  return value;
}

export interface AuditEntry {
  event: string; // e.g. "proposed_action.approved"
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/** Append an audit record inside the caller's org-scoped transaction. */
export async function recordAudit(tx: Tx, auth: AuthContext, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: auth.organizationId,
      actorType: "USER",
      actorUserId: auth.userId,
      event: entry.event,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ? (redact(entry.metadata) as Prisma.InputJsonValue) : undefined,
    },
  });
}
