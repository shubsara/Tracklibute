/**
 * Development seed. Idempotent: safe to run repeatedly.
 *
 *   acme   — alice (OWNER), bob (MEMBER), vera (VIEWER)
 *   globex — gina (OWNER)
 *
 * Each org gets the five SYSTEM responsibilities, PENDING org-wide integration
 * rows for HubSpot / Google Calendar (no credentials), one sample recommendation
 * and one consequential proposed action awaiting approval.
 */
import { config as loadEnv } from "dotenv";

import type { MemberRole, Prisma } from "../src/generated/prisma/client";
import {
  defaultConfigFor,
  SYSTEM_RESPONSIBILITY_TEMPLATES,
  SYSTEM_TEMPLATE_KEYS,
} from "../src/domain/responsibilities/templates";
import { INTEGRATION_PROVIDERS } from "../src/domain/integrations/providers";

import { createOwnerClient } from "./owner-client";

loadEnv({ quiet: true });

const ORGS: { slug: string; name: string; members: { email: string; name: string; role: MemberRole }[] }[] = [
  {
    slug: "acme",
    name: "Acme Robotics",
    members: [
      { email: "alice@acme.test", name: "Alice Owner", role: "OWNER" },
      { email: "bob@acme.test", name: "Bob Member", role: "MEMBER" },
      { email: "vera@acme.test", name: "Vera Viewer", role: "VIEWER" },
    ],
  },
  {
    slug: "globex",
    name: "Globex Analytics",
    members: [{ email: "gina@globex.test", name: "Gina Owner", role: "OWNER" }],
  },
];

async function main() {
  const db = createOwnerClient();
  try {
    for (const spec of ORGS) {
      const org = await db.organization.upsert({
        where: { slug: spec.slug },
        update: { name: spec.name },
        create: { slug: spec.slug, name: spec.name },
      });

      let ownerId: string | undefined;
      for (const m of spec.members) {
        const user = await db.user.upsert({
          where: { email: m.email },
          update: { name: m.name },
          create: { email: m.email, name: m.name },
        });
        await db.organizationMember.upsert({
          where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
          update: { role: m.role },
          create: { organizationId: org.id, userId: user.id, role: m.role },
        });
        if (m.role === "OWNER") ownerId = user.id;
      }

      for (const key of SYSTEM_TEMPLATE_KEYS) {
        const t = SYSTEM_RESPONSIBILITY_TEMPLATES[key];
        await db.responsibility.upsert({
          where: { organizationId_templateKey: { organizationId: org.id, templateKey: key } },
          update: {},
          create: {
            organizationId: org.id,
            name: t.name,
            description: t.description,
            type: "SYSTEM",
            templateKey: key,
            ownerUserId: ownerId ?? null,
            config: defaultConfigFor(key) as Prisma.InputJsonValue,
          },
        });
      }

      // Org-wide placeholders only. Gmail is per-user and created when a member
      // explicitly connects their mailbox; remove pre-Spec-02 org-level Gmail rows.
      await db.integration.deleteMany({
        where: { organizationId: org.id, provider: "GMAIL", ownerUserId: null, encryptedCredentials: null },
      });
      for (const provider of INTEGRATION_PROVIDERS.filter((p) => p !== "GMAIL")) {
        const exists = await db.integration.findFirst({ where: { organizationId: org.id, provider, ownerUserId: null } });
        if (!exists) await db.integration.create({ data: { organizationId: org.id, provider } });
      }

      const sampleTitle = `[sample] Qualified lead has had no reply for 4 days`;
      const hasSample = await db.recommendation.findFirst({ where: { organizationId: org.id, title: sampleTitle } });
      if (!hasSample) {
        const leadHealth = await db.responsibility.findFirstOrThrow({
          where: { organizationId: org.id, templateKey: "lead_health" },
        });
        const rec = await db.recommendation.create({
          data: {
            organizationId: org.id,
            responsibilityId: leadHealth.id,
            title: sampleTitle,
            summary: "Seed data. Detection logic is not implemented in Foundation.",
            severity: "HIGH",
            subjectRef: { provider: "HUBSPOT", kind: "contact", externalId: "seed-1" },
          },
        });
        await db.proposedAction.create({
          data: {
            organizationId: org.id,
            recommendationId: rec.id,
            actionType: "gmail.send_email",
            payload: { to: ["prospect@example.com"], subject: "Following up", bodyText: "Seed draft." },
            requiresApproval: true,
            source: "SYSTEM",
          },
        });
      }
      console.info(`seeded organization ${spec.slug}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
