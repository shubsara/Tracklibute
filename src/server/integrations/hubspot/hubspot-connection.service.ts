import "server-only";

import type { Integration } from "@/generated/prisma/client";
import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import type { OAuthTransaction } from "@/server/auth/oauth-state";
import { type Tx, withOrgScope } from "@/server/db/org-scope";
import { encryptCredentialsFor } from "@/server/integrations/integrations.service";

import { HubSpotIntegrationAdapter } from "./hubspot.adapter";
import { getHubSpotSettings } from "./hubspot.oauth";

/**
 * HubSpot is ONE org-wide integration (owner_user_id IS NULL), connected and
 * disconnected by an ADMIN/OWNER. Read-only: no CRM write is ever performed.
 */
export interface HubSpotStatusDTO {
  connected: boolean;
  status: Integration["status"] | "NOT_CONNECTED";
  hubId: string | null;
  scopes: string[];
  lastSyncedAt: string | null;
  lastSyncAttemptAt: string | null;
  fullSyncedAt: string | null;
  lastError: string | null;
  syncInProgress: boolean;
  deals: number;
  openDeals: number;
  /** Deals whose open/closed status could not be determined; excluded from Opportunity Health. */
  unknownStatusDeals: number;
  /** "OK" | "UNAVAILABLE" | null (never attempted); see pipelineMetadataError for a safe reason code. */
  pipelineMetadataStatus: string | null;
  pipelineMetadataError: string | null;
  owners: number;
  unmappedOwners: number;
}

let adapter = new HubSpotIntegrationAdapter();
/** Test hook. */
export function setHubSpotIntegrationAdapter(next: HubSpotIntegrationAdapter): void {
  adapter = next;
}

export async function findHubSpotIntegration(auth: AuthContext) {
  return withOrgScope(auth, (tx) =>
    tx.integration.findFirst({ where: { organizationId: auth.organizationId, provider: "HUBSPOT", ownerUserId: null } }),
  );
}

export async function getHubSpotStatus(auth: AuthContext): Promise<HubSpotStatusDTO> {
  return withOrgScope(auth, async (tx) => {
    const row = await tx.integration.findFirst({
      where: { organizationId: auth.organizationId, provider: "HUBSPOT", ownerUserId: null },
      select: {
        id: true,
        status: true,
        externalAccountId: true,
        scopes: true,
        lastSyncedAt: true,
        lastSyncAttemptAt: true,
        fullSyncedAt: true,
        lastError: true,
        syncLeaseExpiresAt: true,
        pipelineMetadataStatus: true,
        pipelineMetadataError: true,
      },
    });
    const scope = { organizationId: auth.organizationId, integrationId: row?.id ?? "00000000-0000-0000-0000-000000000000" };
    const [deals, openDeals, unknownStatusDeals, owners, unmappedOwners] = row
      ? await Promise.all([
          tx.crmDeal.count({ where: { ...scope, archivedAt: null } }),
          tx.crmDeal.count({ where: { ...scope, archivedAt: null, isClosed: false } }),
          tx.crmDeal.count({ where: { ...scope, archivedAt: null, isClosed: null } }),
          tx.crmOwner.count({ where: { ...scope, archived: false } }),
          tx.crmOwner.count({ where: { ...scope, archived: false, mapping: null } }),
        ])
      : [0, 0, 0, 0, 0];
    const active = row && row.status !== "PENDING" && row.status !== "DISCONNECTED";
    return {
      connected: row?.status === "CONNECTED",
      status: active ? row.status : row?.status === "DISCONNECTED" ? "DISCONNECTED" : "NOT_CONNECTED",
      hubId: active ? row.externalAccountId : null,
      scopes: active ? row.scopes : [],
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      lastSyncAttemptAt: row?.lastSyncAttemptAt?.toISOString() ?? null,
      fullSyncedAt: row?.fullSyncedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      syncInProgress: Boolean(row?.syncLeaseExpiresAt && row.syncLeaseExpiresAt > new Date()),
      deals,
      openDeals,
      unknownStatusDeals,
      pipelineMetadataStatus: active ? row.pipelineMetadataStatus : null,
      pipelineMetadataError: active ? row.pipelineMetadataError : null,
      owners,
      unmappedOwners,
    };
  });
}

/** Step 1: authorization URL + a transaction bound to THIS admin and organization. */
export async function startHubSpotConnect(auth: AuthContext): Promise<{ url: string; transaction: Omit<OAuthTransaction, "exp"> }> {
  requireRole(auth, "ADMIN");
  getHubSpotSettings();
  const start = await adapter.beginAuthorization();
  await withOrgScope(auth, (tx) => recordAudit(tx, auth, { event: "hubspot.connect_started", entityType: "integration" }));
  return {
    url: start.redirectUrl,
    transaction: {
      purpose: "hubspot",
      state: start.state,
      nonce: start.nonce,
      codeVerifier: start.codeVerifier,
      userId: auth.userId,
      organizationId: auth.organizationId,
    },
  };
}

/**
 * Remove the CRM mirror for one integration. Opportunity Health
 * recommendations keep their history: they are resolved and unlinked first.
 */
export async function purgeCrmData(tx: Tx, auth: AuthContext, integrationId: string): Promise<void> {
  const org = auth.organizationId;
  await tx.$executeRaw`
    UPDATE recommendations r
       SET deal_id = NULL,
           status = CASE WHEN r.status = 'RESOLVED' THEN r.status ELSE 'RESOLVED'::recommendation_status END,
           resolved_at = coalesce(r.resolved_at, now()),
           updated_at = now()
      FROM crm_deals d
     WHERE r.organization_id = ${org}::uuid AND d.organization_id = ${org}::uuid
       AND r.deal_id = d.id AND d.integration_id = ${integrationId}::uuid`;
  const where = { organizationId: org, integrationId };
  await tx.crmDeal.deleteMany({ where });
  await tx.crmContact.deleteMany({ where });
  await tx.crmCompany.deleteMany({ where });
  await tx.crmOwner.deleteMany({ where });
  await tx.crmPipelineStage.deleteMany({ where });
}

/**
 * Step 2. Organization and acting admin come from the session; the
 * transaction must have been started by the same user in the same org.
 */
export async function completeHubSpotConnect(
  auth: AuthContext,
  requestUrl: string,
  transaction: OAuthTransaction,
): Promise<{ integrationId: string; hubId: string; isFirstConnection: boolean }> {
  requireRole(auth, "ADMIN");
  if (transaction.userId !== auth.userId || transaction.organizationId !== auth.organizationId) {
    throw new ForbiddenError("This HubSpot authorization was started by a different session");
  }
  const result = await adapter.completeAuthorization({
    requestUrl,
    state: transaction.state,
  });

  const out = await withOrgScope(auth, async (tx) => {
    const existing = await tx.integration.findFirst({
      where: { organizationId: auth.organizationId, provider: "HUBSPOT", ownerUserId: null },
      select: { id: true, externalAccountId: true, syncCursor: true, fullSyncedAt: true },
    });
    const row =
      existing ??
      (await tx.integration.create({
        data: { organizationId: auth.organizationId, provider: "HUBSPOT", status: "PENDING", connectedByUserId: auth.userId },
        select: { id: true, externalAccountId: true, syncCursor: true, fullSyncedAt: true },
      }));
    // A different HubSpot portal: its records must not mix with the previous one's.
    const portalChanged = existing !== null && existing.externalAccountId !== null && existing.externalAccountId !== result.externalAccountId;
    if (portalChanged) await purgeCrmData(tx, auth, row.id);

    await tx.integration.update({
      where: { id: row.id },
      data: {
        status: "CONNECTED",
        externalAccountId: result.externalAccountId,
        scopes: [...result.scopes],
        connectedByUserId: auth.userId,
        encryptedCredentials: encryptCredentialsFor(auth.organizationId, row.id, result.credentials),
        tokenExpiresAt: result.tokenExpiresAt,
        lastError: null,
        ...(portalChanged ? { syncCursor: null, backfillCursor: null, fullSyncedAt: null, lastSyncedAt: null } : {}),
      },
    });
    await recordAudit(tx, auth, {
      event: "hubspot.connected",
      entityType: "integration",
      entityId: row.id,
      metadata: { hubId: result.externalAccountId, portalChanged, scopes: [...result.scopes] },
    });
    return {
      integrationId: row.id,
      hubId: result.externalAccountId,
      isFirstConnection: existing === null || portalChanged || row.fullSyncedAt === null,
    };
  });
  log.info("hubspot.connected", { organizationId: auth.organizationId, integrationId: out.integrationId });
  return out;
}

/**
 * Disconnect: wipe credentials and checkpoints, remove the CRM mirror,
 * mark DISCONNECTED. No call is made to HubSpot (no write of any kind): an
 * admin removes the app in HubSpot's "Connected apps" settings to revoke it there.
 */
export async function disconnectHubSpot(auth: AuthContext): Promise<void> {
  requireRole(auth, "ADMIN");
  const row = await findHubSpotIntegration(auth);
  if (!row || row.status === "PENDING" || row.status === "DISCONNECTED") throw new NotFoundError("HubSpot is not connected");
  await withOrgScope(auth, async (tx) => {
    await purgeCrmData(tx, auth, row.id);
    await tx.integration.update({
      where: { id: row.id },
      data: {
        status: "DISCONNECTED",
        encryptedCredentials: null,
        tokenExpiresAt: null,
        syncCursor: null,
        backfillCursor: null,
        fullSyncedAt: null,
        pipelineMetadataStatus: null,
        pipelineMetadataError: null,
        syncLeaseExpiresAt: null,
        lastError: null,
      },
    });
    await recordAudit(tx, auth, { event: "hubspot.disconnected", entityType: "integration", entityId: row.id });
  });
}
