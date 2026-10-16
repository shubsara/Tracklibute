import type { AuthContext } from "@/domain/auth/auth-context";
import { encryptCredentialsFor } from "@/server/integrations/integrations.service";

import { type FakeHubSpot, HUBSPOT_READ_SCOPES } from "./fake-hubspot";
import { ownerDb } from "./fixtures";

/**
 * Arrange a CONNECTED org-wide HubSpot integration (as if an admin had
 * completed OAuth). Reuses the org's placeholder row if one exists.
 */
export async function connectHubSpotFixture(hubspot: FakeHubSpot, admin: AuthContext, hubId = "424242", opts: { expiresInSeconds?: number } = {}) {
  const tokens = hubspot.issueTokens(hubId, opts);
  const db = ownerDb();
  const existing = await db.integration.findFirst({ where: { organizationId: admin.organizationId, provider: "HUBSPOT", ownerUserId: null } });
  const row =
    existing ??
    (await db.integration.create({ data: { organizationId: admin.organizationId, provider: "HUBSPOT", status: "PENDING" } }));
  await db.integration.update({
    where: { id: row.id },
    data: {
      status: "CONNECTED",
      externalAccountId: hubId,
      connectedByUserId: admin.userId,
      scopes: HUBSPOT_READ_SCOPES,
      encryptedCredentials: encryptCredentialsFor(admin.organizationId, row.id, tokens),
      tokenExpiresAt: new Date(tokens.expiresAt),
    },
  });
  return { integrationId: row.id, tokens };
}

/** Install the Opportunity Health responsibility for an org fixture. */
export async function installOpportunityHealth(organizationId: string, config: Record<string, unknown> = {}) {
  return ownerDb().responsibility.upsert({
    where: { organizationId_templateKey: { organizationId, templateKey: "opportunity_health" } },
    update: { config: config as object, status: "ACTIVE" },
    create: {
      organizationId,
      name: "Opportunity Health",
      description: "fixture",
      type: "SYSTEM",
      templateKey: "opportunity_health",
      config: config as object,
    },
  });
}

export const isoDaysAgo = (n: number, now = Date.now()) => new Date(now - n * 86_400_000).toISOString();
