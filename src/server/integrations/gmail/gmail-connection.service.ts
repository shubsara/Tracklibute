import "server-only";

import type { Integration } from "@/generated/prisma/client";
import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import type { OAuthTransaction } from "@/server/auth/oauth-state";
import { withOrgScope } from "@/server/db/org-scope";
import { encryptCredentialsFor, loadIntegrationCredentials } from "@/server/integrations/integrations.service";

import { GmailIntegrationAdapter } from "./gmail.adapter";
import { gmailRedirectUri, parseGmailCredentials, revokeGmailCredentials } from "./gmail.oauth";

/** Client-safe Gmail connection status. No token material, by construction. */
export interface GmailStatusDTO {
  connected: boolean;
  status: Integration["status"] | "NOT_CONNECTED";
  accountEmail: string | null;
  lastSyncedAt: string | null;
  lastSyncAttemptAt: string | null;
  lastError: string | null;
  syncInProgress: boolean;
  /** True once the initial backfill has fully completed (incremental mode). */
  initialSyncComplete: boolean;
  /** An initial backfill has started and will continue on the next run. */
  backfillInProgress: boolean;
  messagesSynced: number;
  threadsSynced: number;
}

let adapter = new GmailIntegrationAdapter();
/** Test hook. */
export function setGmailIntegrationAdapter(next: GmailIntegrationAdapter): void {
  adapter = next;
}

/** The caller's own Gmail integration (never another member's). */
export async function findOwnGmailIntegration(auth: AuthContext) {
  return withOrgScope(auth, (tx) =>
    tx.integration.findFirst({
      where: { organizationId: auth.organizationId, provider: "GMAIL", ownerUserId: auth.userId },
    }),
  );
}

export async function getGmailStatus(auth: AuthContext): Promise<GmailStatusDTO> {
  return withOrgScope(auth, async (tx) => {
    const row = await tx.integration.findFirst({
      where: { organizationId: auth.organizationId, provider: "GMAIL", ownerUserId: auth.userId },
      select: {
        id: true,
        status: true,
        externalAccountId: true,
        lastSyncedAt: true,
        lastSyncAttemptAt: true,
        lastError: true,
        syncLeaseExpiresAt: true,
        syncCursor: true,
        backfillCursor: true,
      },
    });
    if (!row) {
      return {
        connected: false,
        status: "NOT_CONNECTED",
        accountEmail: null,
        lastSyncedAt: null,
        lastSyncAttemptAt: null,
        lastError: null,
        syncInProgress: false,
        initialSyncComplete: false,
        backfillInProgress: false,
        messagesSynced: 0,
        threadsSynced: 0,
      };
    }
    const scope = { organizationId: auth.organizationId, mailboxUserId: auth.userId, integrationId: row.id };
    const [messagesSynced, threadsSynced] = await Promise.all([
      tx.emailMessage.count({ where: scope }),
      tx.emailThread.count({ where: scope }),
    ]);
    return {
      connected: row.status === "CONNECTED",
      status: row.status,
      accountEmail: row.externalAccountId,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastSyncAttemptAt: row.lastSyncAttemptAt?.toISOString() ?? null,
      lastError: row.lastError,
      syncInProgress: row.syncLeaseExpiresAt !== null && row.syncLeaseExpiresAt > new Date(),
      initialSyncComplete: row.syncCursor !== null,
      backfillInProgress: row.syncCursor === null && row.backfillCursor !== null,
      messagesSynced,
      threadsSynced,
    };
  });
}

/** Step 1 of connect: authorization URL + transaction bound to THIS user and organization. */
export async function startGmailConnect(
  auth: AuthContext,
): Promise<{ url: string; transaction: Omit<OAuthTransaction, "exp"> }> {
  requireRole(auth, "MEMBER");
  const start = await adapter.beginAuthorization({ redirectUri: gmailRedirectUri() });
  await withOrgScope(auth, (tx) =>
    recordAudit(tx, auth, { event: "gmail.connect_started", entityType: "integration" }),
  );
  return {
    url: start.redirectUrl,
    transaction: {
      purpose: "gmail",
      state: start.state,
      nonce: start.nonce,
      codeVerifier: start.codeVerifier,
      userId: auth.userId,
      organizationId: auth.organizationId,
    },
  };
}

/**
 * Step 2 of connect. The organization and mailbox owner come from the
 * authenticated session; the transaction must have been started by the same
 * user in the same organization (never from callback query parameters).
 */
export async function completeGmailConnect(
  auth: AuthContext,
  requestUrl: string,
  transaction: OAuthTransaction,
): Promise<{ integrationId: string; accountEmail: string; isFirstConnection: boolean }> {
  requireRole(auth, "MEMBER");
  if (transaction.userId !== auth.userId || transaction.organizationId !== auth.organizationId) {
    throw new ForbiddenError("This Gmail authorization was started by a different session");
  }

  const result = await adapter.completeAuthorization({
    requestUrl,
    redirectUri: gmailRedirectUri(),
    state: transaction.state,
    nonce: transaction.nonce,
    codeVerifier: transaction.codeVerifier,
  });

  const out = await withOrgScope(auth, async (tx) => {
    const existing = await tx.integration.findFirst({
      where: { organizationId: auth.organizationId, provider: "GMAIL", ownerUserId: auth.userId },
      select: { id: true, externalAccountId: true, syncCursor: true },
    });
    const mailboxChanged = existing !== null && existing.externalAccountId !== result.externalAccountId;

    const row =
      existing ??
      (await tx.integration.create({
        data: {
          organizationId: auth.organizationId,
          provider: "GMAIL",
          ownerUserId: auth.userId,
          connectedByUserId: auth.userId,
          externalAccountId: result.externalAccountId,
          status: "PENDING",
        },
        select: { id: true, externalAccountId: true, syncCursor: true },
      }));

    if (mailboxChanged) {
      // A different Google mailbox: its data must not mix with the previous one.
      await tx.emailThread.deleteMany({ where: { integrationId: row.id, organizationId: auth.organizationId } });
    }

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
        ...(mailboxChanged ? { syncCursor: null, backfillCursor: null, lastSyncedAt: null } : {}),
      },
    });
    await recordAudit(tx, auth, {
      event: "gmail.connected",
      entityType: "integration",
      entityId: row.id,
      metadata: { accountDomain: result.externalAccountId.split("@")[1] ?? null, mailboxChanged },
    });
    return {
      integrationId: row.id,
      accountEmail: result.externalAccountId,
      isFirstConnection: existing === null || mailboxChanged || row.syncCursor === null,
    };
  });
  log.info("gmail.connected", { organizationId: auth.organizationId, mailboxUserId: auth.userId, integrationId: out.integrationId });
  return out;
}

/**
 * Disconnect: revoke at Google (best effort), wipe credentials and the sync
 * checkpoint, mark DISCONNECTED. Synced mail is kept, still owner-private;
 * reconnecting resumes. The row is never deleted.
 */
export async function disconnectGmail(auth: AuthContext): Promise<void> {
  const row = await findOwnGmailIntegration(auth);
  if (!row) throw new NotFoundError("Gmail is not connected");

  let revoked = false;
  if (row.encryptedCredentials) {
    try {
      revoked = await revokeGmailCredentials(parseGmailCredentials(await loadIntegrationCredentials(auth, row.id)));
    } catch {
      revoked = false;
    }
  }

  await withOrgScope(auth, async (tx) => {
    await tx.integration.update({
      where: { id: row.id },
      data: {
        status: "DISCONNECTED",
        encryptedCredentials: null,
        tokenExpiresAt: null,
        syncCursor: null,
        backfillCursor: null,
        syncLeaseExpiresAt: null,
        lastError: null,
      },
    });
    await recordAudit(tx, auth, {
      event: "gmail.disconnected",
      entityType: "integration",
      entityId: row.id,
      metadata: { revokedAtGoogle: revoked },
    });
  });
}
