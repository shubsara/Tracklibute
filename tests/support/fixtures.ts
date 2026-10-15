import { randomUUID } from "node:crypto";

import { createOwnerClient } from "../../prisma/owner-client";
import type { MemberRole, PrismaClient } from "@/generated/prisma/client";
import type { AuthContext } from "@/domain/auth/auth-context";

let owner: PrismaClient | undefined;

/** Owner (RLS-exempt) client for arranging fixtures. Never used to assert isolation. */
export function ownerDb(): PrismaClient {
  owner ??= createOwnerClient();
  return owner;
}

export async function closeOwnerDb(): Promise<void> {
  await owner?.$disconnect();
  owner = undefined;
}

export interface OrgFixture {
  organizationId: string;
  slug: string;
  members: Record<MemberRole, AuthContext & { email: string }>;
  responsibilityId: string;
  recommendationId: string;
}

/** Create an isolated organization with one user per role, a responsibility and a recommendation. */
export async function createOrgFixture(label: string): Promise<OrgFixture> {
  const db = ownerDb();
  const suffix = randomUUID().slice(0, 8);
  const slug = `${label}-${suffix}`;
  const org = await db.organization.create({ data: { name: `${label} ${suffix}`, slug } });

  const members = {} as OrgFixture["members"];
  for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const) {
    const email = `${role.toLowerCase()}-${suffix}@${label}.test`;
    const user = await db.user.create({ data: { email, name: `${role} ${label}` } });
    await db.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role } });
    members[role] = { userId: user.id, organizationId: org.id, role, email };
  }

  const resp = await db.responsibility.create({
    data: {
      organizationId: org.id,
      name: "Lead Health",
      description: "fixture",
      type: "SYSTEM",
      templateKey: "lead_health",
      config: { firstTouchWithinHours: 24, staleAfterDays: 3 },
    },
  });
  const rec = await db.recommendation.create({
    data: { organizationId: org.id, responsibilityId: resp.id, title: `rec ${label}`, summary: "fixture" },
  });

  return { organizationId: org.id, slug, members, responsibilityId: resp.id, recommendationId: rec.id };
}

export async function connectIntegration(organizationId: string, provider: "GMAIL" | "HUBSPOT" | "GOOGLE_CALENDAR") {
  return ownerDb().integration.create({
    data: { organizationId, provider, status: "CONNECTED", externalAccountId: `${provider}-${randomUUID()}` },
  });
}
