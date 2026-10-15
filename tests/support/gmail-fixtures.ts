import type { AuthContext } from "@/domain/auth/auth-context";
import { encryptCredentialsFor } from "@/server/integrations/integrations.service";

import type { FakeGoogle } from "./fake-google";
import { ownerDb } from "./fixtures";

/** Arrange a CONNECTED Gmail integration for `auth` (as if OAuth had completed). */
export async function connectGmailFixture(google: FakeGoogle, auth: AuthContext, mailbox: string, opts: { expiresInSeconds?: number } = {}) {
  const tokens = google.issueTokens(mailbox, opts);
  const row = await ownerDb().integration.create({
    data: {
      organizationId: auth.organizationId,
      provider: "GMAIL",
      ownerUserId: auth.userId,
      connectedByUserId: auth.userId,
      externalAccountId: mailbox,
      status: "CONNECTED",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
  });
  await ownerDb().integration.update({
    where: { id: row.id },
    data: {
      encryptedCredentials: encryptCredentialsFor(auth.organizationId, row.id, tokens),
      tokenExpiresAt: new Date(tokens.expiresAt),
    },
  });
  google.mailbox(mailbox);
  return { integrationId: row.id, tokens };
}

export const daysAgo = (n: number, now = Date.now()) => new Date(now - n * 86_400_000);
