import "server-only";

import type { Integration } from "@/generated/prisma/client";
import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import type { DecryptedCredentials } from "@/domain/integrations/adapter";
import { decryptSecret, encryptSecret } from "@/lib/crypto/credentials-cipher";
import { getEnv } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import { recordAudit } from "@/server/audit/audit-log";
import { withOrgScope } from "@/server/db/org-scope";

/** Client-safe view of an integration. Credentials are structurally absent. */
export interface IntegrationDTO {
  id: string;
  provider: Integration["provider"];
  status: Integration["status"];
  externalAccountId: string | null;
  scopes: string[];
  lastSyncedAt: string | null;
  hasCredentials: boolean;
}

const dtoSelect = {
  id: true,
  provider: true,
  status: true,
  externalAccountId: true,
  scopes: true,
  lastSyncedAt: true,
  encryptedCredentials: true,
} as const;

function toDTO(row: Pick<Integration, keyof typeof dtoSelect>): IntegrationDTO {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    externalAccountId: row.externalAccountId,
    scopes: row.scopes,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    hasCredentials: row.encryptedCredentials !== null,
  };
}

function aadFor(organizationId: string, integrationId: string): string {
  return `integration:${organizationId}:${integrationId}`;
}

/** Encrypt credentials for a specific integration (for writes inside an existing org-scoped transaction). */
export function encryptCredentialsFor(
  organizationId: string,
  integrationId: string,
  credentials: DecryptedCredentials,
): string {
  return encryptSecret(JSON.stringify(credentials), getEnv().CREDENTIALS_ENCRYPTION_KEY, aadFor(organizationId, integrationId));
}

/** Org-wide integrations plus the caller's own user-scoped ones (never another member's mailbox). */
export async function listIntegrations(auth: AuthContext): Promise<IntegrationDTO[]> {
  const rows = await withOrgScope(auth, (tx) =>
    tx.integration.findMany({
      where: { organizationId: auth.organizationId, OR: [{ ownerUserId: null }, { ownerUserId: auth.userId }] },
      select: dtoSelect,
      orderBy: { createdAt: "asc" },
    }),
  );
  return rows.map(toDTO);
}

/**
 * Who may manage an integration's credentials:
 *  - org-wide integration (ownerUserId = null): ADMIN or OWNER
 *  - user-scoped integration (a personal mailbox): only its owner
 * RLS independently hides other users' mailbox integrations.
 */
function assertMayManage(auth: AuthContext, row: { ownerUserId: string | null }): void {
  if (row.ownerUserId === null) requireRole(auth, "ADMIN");
  else if (row.ownerUserId !== auth.userId) throw new NotFoundError("Integration not found");
}

/** Encrypt and store credentials (AAD-bound to organization + integration). */
export async function storeIntegrationCredentials(
  auth: AuthContext,
  integrationId: string,
  credentials: DecryptedCredentials,
  opts: { tokenExpiresAt?: Date | null; audit?: boolean } = {},
): Promise<void> {
  const envelope = encryptSecret(
    JSON.stringify(credentials),
    getEnv().CREDENTIALS_ENCRYPTION_KEY,
    aadFor(auth.organizationId, integrationId),
  );
  await withOrgScope(auth, async (tx) => {
    const row = await tx.integration.findFirst({
      where: { id: integrationId, organizationId: auth.organizationId },
      select: { ownerUserId: true },
    });
    if (!row) throw new NotFoundError("Integration not found");
    assertMayManage(auth, row);
    await tx.integration.update({
      where: { id: integrationId },
      data: {
        encryptedCredentials: envelope,
        ...(opts.tokenExpiresAt !== undefined ? { tokenExpiresAt: opts.tokenExpiresAt } : {}),
      },
    });
    if (opts.audit !== false) {
      await recordAudit(tx, auth, {
        event: "integration.credentials_stored",
        entityType: "integration",
        entityId: integrationId,
      });
    }
  });
}

/**
 * Server-only. Decrypts credentials for an adapter call. The result must
 * never be logged, serialized to a client, or written anywhere else.
 */
export async function loadIntegrationCredentials(
  auth: AuthContext,
  integrationId: string,
): Promise<DecryptedCredentials> {
  const row = await withOrgScope(auth, (tx) =>
    tx.integration.findFirst({
      where: { id: integrationId, organizationId: auth.organizationId },
      select: { encryptedCredentials: true, ownerUserId: true },
    }),
  );
  if (!row?.encryptedCredentials) throw new NotFoundError("Integration credentials not found");
  if (row.ownerUserId !== null && row.ownerUserId !== auth.userId) {
    throw new NotFoundError("Integration credentials not found");
  }
  const json = decryptSecret(
    row.encryptedCredentials,
    getEnv().CREDENTIALS_ENCRYPTION_KEY,
    aadFor(auth.organizationId, integrationId),
  );
  return JSON.parse(json) as DecryptedCredentials;
}
