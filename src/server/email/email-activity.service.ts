import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import {
  type ActivityRules,
  type ActivitySource,
  deriveEmailActivities,
  isPublicEmailDomain,
  normalizeDomain,
} from "@/domain/email/activity";
import type { EmailDirection, EmailParticipant } from "@/domain/email/types";
import { ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import { type Tx, withOrgScope } from "@/server/db/org-scope";

/**
 * Writes the content-free, organization-readable EmailActivity layer.
 * Called only from the mailbox owner's own Gmail sync (RLS also enforces
 * mailbox_user_id = current user for INSERT / DELETE). Never copies subject,
 * snippet, body, labels or display names.
 */
export interface MailboxActivityRules extends ActivityRules {
  version: number;
}

export async function loadActivityRules(tx: Tx, auth: AuthContext, mailboxAddress: string): Promise<MailboxActivityRules> {
  const org = await tx.organization.findFirstOrThrow({
    where: { id: auth.organizationId },
    select: { internalEmailDomains: true, emailActivityRulesVersion: true },
  });
  const members = await tx.organizationMember.findMany({
    where: { organizationId: auth.organizationId },
    select: { user: { select: { email: true } } },
  });
  return {
    mailboxAddress: mailboxAddress.toLowerCase(),
    internalDomains: org.internalEmailDomains,
    memberEmails: new Set(members.map((m) => m.user.email.toLowerCase())),
    version: org.emailActivityRulesVersion,
  };
}

export interface ActivityMessage extends ActivitySource {
  externalMessageId: string;
  externalThreadId: string;
  occurredAt: Date;
}

export async function writeEmailActivities(
  tx: Tx,
  auth: AuthContext,
  integrationId: string,
  rules: ActivityRules,
  messages: readonly ActivityMessage[],
): Promise<number> {
  const rows: Prisma.EmailActivityCreateManyInput[] = [];
  for (const m of messages) {
    for (const a of deriveEmailActivities(m, rules)) {
      rows.push({
        id: randomUUID(),
        organizationId: auth.organizationId,
        integrationId,
        mailboxUserId: auth.userId,
        externalMessageId: m.externalMessageId,
        externalThreadId: m.externalThreadId,
        direction: a.direction,
        counterpartEmail: a.counterpartEmail,
        counterpartDomain: a.counterpartDomain,
        occurredAt: m.occurredAt,
      });
    }
  }
  if (rows.length === 0) return 0;
  const { count } = await tx.emailActivity.createMany({ data: rows, skipDuplicates: true });
  return count;
}

export async function deleteEmailActivities(tx: Tx, auth: AuthContext, integrationId: string, externalMessageIds: readonly string[]): Promise<number> {
  if (externalMessageIds.length === 0) return 0;
  const { count } = await tx.emailActivity.deleteMany({
    where: { organizationId: auth.organizationId, mailboxUserId: auth.userId, integrationId, externalMessageId: { in: [...externalMessageIds] } },
  });
  return count;
}

const metadataSchema = z
  .object({
    listId: z.string().nullable().default(null),
    hasListUnsubscribe: z.boolean().default(false),
    precedence: z.string().nullable().default(null),
    autoSubmitted: z.string().nullable().default(null),
  })
  .nullable()
  .catch(null);

const REBUILD_PAGE = 500;

/**
 * Re-derive this mailbox's activity from LOCALLY stored messages (zero Gmail
 * API calls) when it was never derived (backfill of pre-Spec-03 mail) or the
 * organization's internal-address rules changed since.
 */
export async function rebuildEmailActivityIfStale(auth: AuthContext, integrationId: string, mailboxAddress: string): Promise<boolean> {
  const state = await withOrgScope(auth, async (tx) => {
    const row = await tx.integration.findFirst({
      where: { id: integrationId, organizationId: auth.organizationId, ownerUserId: auth.userId, provider: "GMAIL" },
      select: { emailActivityVersion: true },
    });
    if (!row) return null;
    const rules = await loadActivityRules(tx, auth, mailboxAddress);
    return { current: row.emailActivityVersion, rules };
  });
  if (!state || state.current === state.rules.version) return false;
  const { rules } = state;

  const scope = { organizationId: auth.organizationId, mailboxUserId: auth.userId, integrationId };
  await withOrgScope(auth, (tx) => tx.emailActivity.deleteMany({ where: scope }));
  let cursor: string | undefined;
  let written = 0;
  for (;;) {
    const batch = await withOrgScope(auth, async (tx) => {
      const msgs = await tx.emailMessage.findMany({
        where: scope,
        orderBy: { id: "asc" },
        take: REBUILD_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          externalMessageId: true,
          externalThreadId: true,
          direction: true,
          fromEmail: true,
          receivedAt: true,
          headers: true,
          recipients: { select: { kind: true, email: true } },
        },
      });
      const toSource = (kind: "TO" | "CC", r: (typeof msgs)[number]): EmailParticipant[] =>
        r.recipients.filter((x) => x.kind === kind).map((x) => ({ email: x.email, name: null }));
      written += await writeEmailActivities(
        tx,
        auth,
        integrationId,
        rules,
        msgs.map((m) => ({
          externalMessageId: m.externalMessageId,
          externalThreadId: m.externalThreadId,
          direction: m.direction as EmailDirection,
          from: m.fromEmail ? { email: m.fromEmail, name: null } : null,
          to: toSource("TO", m),
          cc: toSource("CC", m),
          metadata: metadataSchema.parse(m.headers ?? null),
          occurredAt: m.receivedAt,
        })),
      );
      return msgs;
    });
    if (batch.length < REBUILD_PAGE) break;
    cursor = batch[batch.length - 1]!.id;
  }
  await withOrgScope(auth, (tx) =>
    tx.integration.updateMany({ where: { id: integrationId, organizationId: auth.organizationId, ownerUserId: auth.userId }, data: { emailActivityVersion: rules.version } }),
  );
  log.info("email_activity.rebuilt", { organizationId: auth.organizationId, mailboxUserId: auth.userId, integrationId, rows: written });
  return true;
}

// ─── Internal email domains (organization setting) ──────────────────────────

const domainsInput = z.object({ domains: z.array(z.string().max(253)).max(20) }).strict();

export async function getInternalEmailDomains(auth: AuthContext): Promise<string[]> {
  return withOrgScope(auth, async (tx) => {
    const org = await tx.organization.findFirstOrThrow({ where: { id: auth.organizationId }, select: { internalEmailDomains: true } });
    return org.internalEmailDomains;
  });
}

/** ADMIN: replace the internal domain list; every mailbox re-derives its activity on its next sync. */
export async function setInternalEmailDomains(auth: AuthContext, input: unknown): Promise<string[]> {
  requireRole(auth, "ADMIN");
  const parsed = domainsInput.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid domains", parsed.error.issues.map((i) => i.message));
  const domains: string[] = [];
  for (const raw of parsed.data.domains) {
    const d = normalizeDomain(raw);
    if (!d) throw new ValidationError(`"${raw.slice(0, 60)}" is not a valid domain`);
    if (isPublicEmailDomain(d)) throw new ValidationError(`${d} is a public email provider and cannot be an internal domain`);
    if (!domains.includes(d)) domains.push(d);
  }
  return withOrgScope(auth, async (tx) => {
    await tx.organization.update({
      where: { id: auth.organizationId },
      data: { internalEmailDomains: domains, emailActivityRulesVersion: { increment: 1 } },
    });
    await recordAudit(tx, auth, { event: "organization.internal_email_domains_updated", entityType: "organization", entityId: auth.organizationId, metadata: { domains } });
    return domains;
  });
}
