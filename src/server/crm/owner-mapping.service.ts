import "server-only";

import { z } from "zod";

import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/server/audit/audit-log";
import { withOrgScope } from "@/server/db/org-scope";

/**
 * HubSpot owner → Tracklibute member mapping.
 *
 *   AUTO_EMAIL  created by sync when the owner's email equals a member's email
 *   MANUAL      set by an ADMIN; never overwritten by sync
 *
 * Used to assign deals / recommendations to teammates ("mine") and to decide
 * whether a deal owner's mailbox is connected (limited-signal flag).
 */
export interface CrmOwnerDTO {
  id: string;
  externalId: string;
  email: string | null;
  name: string | null;
  archived: boolean;
  mapping: { userId: string; userEmail: string; userName: string | null; source: "AUTO_EMAIL" | "MANUAL" } | null;
}

export interface MemberOptionDTO {
  userId: string;
  email: string;
  name: string | null;
}

const ownerName = (o: { firstName: string | null; lastName: string | null }) =>
  [o.firstName, o.lastName].filter(Boolean).join(" ") || null;

/** Create AUTO_EMAIL mappings for unmapped owners whose email matches a member. Returns how many were created. */
export async function autoMapOwners(auth: AuthContext, integrationId: string): Promise<number> {
  return withOrgScope(auth, async (tx) => {
    const unmapped = await tx.crmOwner.findMany({
      where: { organizationId: auth.organizationId, integrationId, mapping: null, email: { not: null } },
      select: { id: true, email: true },
    });
    if (unmapped.length === 0) return 0;
    const members = await tx.organizationMember.findMany({
      where: { organizationId: auth.organizationId },
      select: { userId: true, user: { select: { email: true } } },
    });
    const byEmail = new Map(members.map((m) => [m.user.email.toLowerCase(), m.userId]));
    let created = 0;
    for (const o of unmapped) {
      const userId = byEmail.get(o.email!.toLowerCase());
      if (!userId) continue;
      const r = await tx.crmOwnerMapping.createMany({
        data: [{ organizationId: auth.organizationId, crmOwnerId: o.id, userId, source: "AUTO_EMAIL" }],
        skipDuplicates: true,
      });
      created += r.count;
    }
    if (created) {
      await recordAudit(tx, auth, { event: "crm_owner_mapping.auto_mapped", entityType: "integration", entityId: integrationId, metadata: { created } }, { actor: "SYSTEM" });
    }
    return created;
  });
}

export async function listCrmOwners(auth: AuthContext): Promise<{ owners: CrmOwnerDTO[]; members: MemberOptionDTO[] }> {
  return withOrgScope(auth, async (tx) => {
    const [owners, members] = await Promise.all([
      tx.crmOwner.findMany({
        where: { organizationId: auth.organizationId, integration: { provider: "HUBSPOT", ownerUserId: null, status: { in: ["CONNECTED", "REAUTH_REQUIRED", "ERROR"] } } },
        include: { mapping: { include: { member: { include: { user: { select: { email: true, name: true } } } } } } },
        orderBy: [{ archived: "asc" }, { lastName: "asc" }, { firstName: "asc" }],
      }),
      tx.organizationMember.findMany({
        where: { organizationId: auth.organizationId },
        select: { userId: true, user: { select: { email: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      owners: owners.map((o) => ({
        id: o.id,
        externalId: o.externalId,
        email: o.email,
        name: ownerName(o),
        archived: o.archived,
        mapping: o.mapping
          ? { userId: o.mapping.userId, userEmail: o.mapping.member.user.email, userName: o.mapping.member.user.name, source: o.mapping.source }
          : null,
      })),
      members: members.map((m) => ({ userId: m.userId, email: m.user.email, name: m.user.name })),
    };
  });
}

const setInput = z.object({ userId: z.uuid() }).strict();

/** ADMIN: map an owner to a member (MANUAL; replaces any existing mapping). */
export async function setCrmOwnerMapping(auth: AuthContext, crmOwnerId: string, input: unknown): Promise<void> {
  requireRole(auth, "ADMIN");
  const parsed = setInput.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid mapping", parsed.error.issues.map((i) => i.message));
  await withOrgScope(auth, async (tx) => {
    const owner = await tx.crmOwner.findFirst({ where: { id: crmOwnerId, organizationId: auth.organizationId }, select: { id: true } });
    if (!owner) throw new NotFoundError("CRM owner not found");
    const member = await tx.organizationMember.findFirst({
      where: { organizationId: auth.organizationId, userId: parsed.data.userId },
      select: { userId: true },
    });
    if (!member) throw new ValidationError("That user is not a member of this organization");
    await tx.crmOwnerMapping.upsert({
      where: { organizationId_crmOwnerId: { organizationId: auth.organizationId, crmOwnerId } },
      create: { organizationId: auth.organizationId, crmOwnerId, userId: member.userId, source: "MANUAL", createdByUserId: auth.userId },
      update: { userId: member.userId, source: "MANUAL", createdByUserId: auth.userId },
    });
    await recordAudit(tx, auth, { event: "crm_owner_mapping.set", entityType: "crm_owner", entityId: crmOwnerId, metadata: { userId: member.userId } });
  });
}

/** ADMIN: remove a mapping. (Sync may re-create an AUTO mapping if emails still match.) */
export async function clearCrmOwnerMapping(auth: AuthContext, crmOwnerId: string): Promise<void> {
  requireRole(auth, "ADMIN");
  await withOrgScope(auth, async (tx) => {
    const { count } = await tx.crmOwnerMapping.deleteMany({ where: { organizationId: auth.organizationId, crmOwnerId } });
    if (count === 0) throw new NotFoundError("Mapping not found");
    await recordAudit(tx, auth, { event: "crm_owner_mapping.cleared", entityType: "crm_owner", entityId: crmOwnerId });
  });
}
