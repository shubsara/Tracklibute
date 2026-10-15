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

export async function listIntegrations(auth: AuthContext): Promise<IntegrationDTO[]> {
  const rows = await withOrgScope(auth, (tx) =>
    tx.integration.findMany({
      where: { organizationId: auth.organizationId },
      select: dtoSelect,
      orderBy: { createdAt: "asc" },
    }),
  );
  return rows.map(toDTO);
}

/** Encrypt and store credentials. Called by adapters' OAuth callbacks in later specs. */
export async function storeIntegrationCredentials(
  auth: AuthContext,
  integrationId: string,
  credentials: DecryptedCredentials,
): Promise<void> {
  requireRole(auth, "ADMIN");
  const envelope = encryptSecret(
    JSON.stringify(credentials),
    getEnv().CREDENTIALS_ENCRYPTION_KEY,
    aadFor(auth.organizationId, integrationId),
  );
  await withOrgScope(auth, async (tx) => {
    const { count } = await tx.integration.updateMany({
      where: { id: integrationId, organizationId: auth.organizationId },
      data: { encryptedCredentials: envelope, connectedByUserId: auth.userId },
    });
    if (count === 0) throw new NotFoundError("Integration not found");
    await recordAudit(tx, auth, {
      event: "integration.credentials_stored",
      entityType: "integration",
      entityId: integrationId,
    });
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
      select: { encryptedCredentials: true },
    }),
  );
  if (!row?.encryptedCredentials) throw new NotFoundError("Integration credentials not found");
  const json = decryptSecret(
    row.encryptedCredentials,
    getEnv().CREDENTIALS_ENCRYPTION_KEY,
    aadFor(auth.organizationId, integrationId),
  );
  return JSON.parse(json) as DecryptedCredentials;
}
