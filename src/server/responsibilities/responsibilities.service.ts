import "server-only";

import { z } from "zod";

import type { Prisma, Responsibility } from "@/generated/prisma/client";
import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import {
  customResponsibilityConfigSchema,
  defaultConfigFor,
  parseSystemConfig,
  SYSTEM_RESPONSIBILITY_TEMPLATES,
  SYSTEM_TEMPLATE_KEYS,
  isSystemTemplateKey,
} from "@/domain/responsibilities/templates";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/server/audit/audit-log";
import { withOrgScope } from "@/server/db/org-scope";

export async function listResponsibilities(auth: AuthContext): Promise<Responsibility[]> {
  return withOrgScope(auth, (tx) =>
    tx.responsibility.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
  );
}

export async function getResponsibility(auth: AuthContext, id: string): Promise<Responsibility> {
  const row = await withOrgScope(auth, (tx) =>
    tx.responsibility.findFirst({ where: { id, organizationId: auth.organizationId } }),
  );
  if (!row) throw new NotFoundError("Responsibility not found");
  return row;
}

/** Idempotently create all SYSTEM responsibilities for the caller's organization. */
export async function installSystemResponsibilities(auth: AuthContext): Promise<number> {
  requireRole(auth, "ADMIN");
  return withOrgScope(auth, async (tx) => {
    let created = 0;
    for (const key of SYSTEM_TEMPLATE_KEYS) {
      const exists = await tx.responsibility.findFirst({
        where: { organizationId: auth.organizationId, templateKey: key },
        select: { id: true },
      });
      if (exists) continue;
      const t = SYSTEM_RESPONSIBILITY_TEMPLATES[key];
      const row = await tx.responsibility.create({
        data: {
          organizationId: auth.organizationId,
          name: t.name,
          description: t.description,
          type: "SYSTEM",
          templateKey: key,
          ownerUserId: auth.userId,
          config: defaultConfigFor(key) as Prisma.InputJsonValue,
        },
      });
      await recordAudit(tx, auth, {
        event: "responsibility.created",
        entityType: "responsibility",
        entityId: row.id,
        metadata: { templateKey: key },
      });
      created++;
    }
    return created;
  });
}

const createCustomInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  config: customResponsibilityConfigSchema.default({}),
});

export async function createCustomResponsibility(auth: AuthContext, input: unknown): Promise<Responsibility> {
  requireRole(auth, "ADMIN");
  const parsed = createCustomInput.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid responsibility", parsed.error.issues.map((i) => i.message));
  }
  return withOrgScope(auth, async (tx) => {
    const row = await tx.responsibility.create({
      data: {
        organizationId: auth.organizationId,
        name: parsed.data.name,
        description: parsed.data.description,
        type: "CUSTOM",
        ownerUserId: auth.userId,
        config: parsed.data.config as Prisma.InputJsonValue,
      },
    });
    await recordAudit(tx, auth, { event: "responsibility.created", entityType: "responsibility", entityId: row.id });
    return row;
  });
}

export async function updateResponsibilityConfig(
  auth: AuthContext,
  id: string,
  config: unknown,
): Promise<Responsibility> {
  requireRole(auth, "ADMIN");
  return withOrgScope(auth, async (tx) => {
    const current = await tx.responsibility.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!current) throw new NotFoundError("Responsibility not found");

    let next: Record<string, unknown>;
    try {
      next =
        current.templateKey && isSystemTemplateKey(current.templateKey)
          ? parseSystemConfig(current.templateKey, config)
          : customResponsibilityConfigSchema.parse(config);
    } catch (err) {
      const issues = err instanceof z.ZodError ? err.issues.map((i) => i.message) : [];
      throw new ValidationError("Invalid responsibility config", issues);
    }

    const row = await tx.responsibility.update({
      where: { id: current.id },
      data: { config: next as Prisma.InputJsonValue },
    });
    await recordAudit(tx, auth, { event: "responsibility.config_updated", entityType: "responsibility", entityId: id });
    return row;
  });
}

export async function setResponsibilityStatus(
  auth: AuthContext,
  id: string,
  status: Responsibility["status"],
): Promise<void> {
  requireRole(auth, "ADMIN");
  await withOrgScope(auth, async (tx) => {
    const { count } = await tx.responsibility.updateMany({
      where: { id, organizationId: auth.organizationId },
      data: { status },
    });
    if (count === 0) throw new NotFoundError("Responsibility not found");
    await recordAudit(tx, auth, {
      event: "responsibility.status_changed",
      entityType: "responsibility",
      entityId: id,
      metadata: { status },
    });
  });
}
