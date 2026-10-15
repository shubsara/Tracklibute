import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IntegrationNotImplementedError } from "@/domain/integrations/adapter";
import { INTEGRATION_PROVIDERS } from "@/domain/integrations/providers";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { disconnectAppDb } from "@/server/db/client";
import { getIntegrationAdapter } from "@/server/integrations/adapters";
import {
  listIntegrations,
  loadIntegrationCredentials,
  storeIntegrationCredentials,
} from "@/server/integrations/integrations.service";

import { closeOwnerDb, connectIntegration, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";

let A: OrgFixture;
let B: OrgFixture;
let integrationA: string;

beforeAll(async () => {
  A = await createOrgFixture("inta");
  B = await createOrgFixture("intb");
  integrationA = (await connectIntegration(A.organizationId, "GMAIL")).id;
});

afterAll(async () => {
  await disconnectAppDb();
  await closeOwnerDb();
});

describe("integration abstraction", () => {
  it("has a placeholder adapter per MVP provider that refuses network operations", async () => {
    expect([...INTEGRATION_PROVIDERS]).toEqual(["GMAIL", "HUBSPOT", "GOOGLE_CALENDAR"]);
    for (const provider of INTEGRATION_PROVIDERS) {
      const adapter = getIntegrationAdapter(provider);
      expect(adapter.provider).toBe(provider);
      await expect(adapter.checkConnection({})).rejects.toBeInstanceOf(IntegrationNotImplementedError);
    }
  });
});

describe("credential vault", () => {
  const creds = { refresh_token: "1//gmail-refresh-SECRET", access_token: "ya29.SECRET" };

  it("stores credentials encrypted at rest and decrypts server-side", async () => {
    await storeIntegrationCredentials(A.members.ADMIN, integrationA, creds);
    const row = await ownerDb().integration.findUniqueOrThrow({ where: { id: integrationA } });
    expect(row.encryptedCredentials).toMatch(/^v1\./);
    expect(row.encryptedCredentials).not.toContain("SECRET");
    expect(await loadIntegrationCredentials(A.members.MEMBER, integrationA)).toEqual(creds);
  });

  it("only ADMIN+ may store credentials", async () => {
    await expect(storeIntegrationCredentials(A.members.MEMBER, integrationA, creds)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("another organization cannot read or overwrite them", async () => {
    await expect(loadIntegrationCredentials(B.members.OWNER, integrationA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(storeIntegrationCredentials(B.members.OWNER, integrationA, { x: 1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("a ciphertext copied to another organization's row does not decrypt (AAD binding)", async () => {
    const stolen = (await ownerDb().integration.findUniqueOrThrow({ where: { id: integrationA } })).encryptedCredentials;
    const target = await connectIntegration(B.organizationId, "GMAIL");
    await ownerDb().integration.update({ where: { id: target.id }, data: { encryptedCredentials: stolen } });
    await expect(loadIntegrationCredentials(B.members.OWNER, target.id)).rejects.toThrow(/could not be decrypted/);
  });

  it("list DTOs and audit entries contain no secrets", async () => {
    const list = await listIntegrations(A.members.VIEWER);
    expect(JSON.stringify(list)).not.toMatch(/SECRET|v1\./);
    const audit = await ownerDb().auditLog.findMany({ where: { organizationId: A.organizationId } });
    expect(JSON.stringify(audit)).not.toContain("SECRET");
  });
});
